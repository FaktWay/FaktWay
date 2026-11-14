#!/usr/bin/env node
// Raport nocnego zespołu na Telegram (docs/runbooks/nocny-zespol.md, „Raport na Telegram”).
//
// Token bota i czat czyta ze zmiennych środowiska sesji: TELEGRAM_BOT_TOKEN
// i TELEGRAM_CHAT_ID (jeden identyfikator albo kilka po przecinku). Tekst bierze
// z pliku (argument) albo ze standardowego wejścia. Wiadomość dłuższą niż 4096
// znaków (limit Bot API) dzieli na części: najpierw na pustych liniach, potem
// na końcach linii, potem na spacjach, i numeruje je „(1/3)”. Wysyła zwykły
// tekst, bez Markdown i HTML, więc znaki w nazwach plików nic nie psują.
// Tokenu nie wypisuje nigdzie, także w komunikatach o błędach.
//
// Użycie:
//   node scripts/nocny/telegram.mjs raport.txt
//   node scripts/nocny/telegram.mjs < raport.txt
//   node scripts/nocny/telegram.mjs --podglad raport.txt    części na ekran, bez wysyłki
// Kod wyjścia: 0 wysłane, 1 Telegram albo sieć odmówiły, 2 złe użycie albo brak konfiguracji.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LIMIT_ZNAKOW = 4096;
export const NAJWYZEJ_CZESCI = 10;
/** Miejsce na numer części „(10/10) ” przed tekstem. */
const ZAPAS_NA_NUMER = 16;
const ADRES_API = 'https://api.telegram.org';
const TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
const PROBY = 3;

const UZYCIE = 'Użycie: node scripts/nocny/telegram.mjs [--podglad] [plik]   (bez pliku: tekst ze standardowego wejścia)';

const czekajMs = (ms) => new Promise((gotowe) => setTimeout(gotowe, ms));

/** Tekst bez tokenu (zamiennik w miejscu każdego wystąpienia). */
export function ukryjToken(tekst, token) {
  return token ? String(tekst).split(token).join('[token]') : String(tekst);
}

/** Miejsce cięcia w drugiej połowie części; na końcu twarde cięcie, które nie rozrywa pary surogatów (emoji). */
function miejsceCiecia(tekst, limit) {
  for (const separator of ['\n\n', '\n', ' ']) {
    const indeks = tekst.lastIndexOf(separator, limit - separator.length);
    if (indeks >= limit / 2) return { koniec: indeks, dalej: indeks + separator.length };
  }
  const kod = tekst.charCodeAt(limit - 1);
  const koniec = kod >= 0xd800 && kod <= 0xdbff ? limit - 1 : limit;
  return { koniec, dalej: koniec };
}

/**
 * Części wiadomości, każda najwyżej `limit` znaków (jednostek UTF-16, czyli
 * nie więcej niż liczy Telegram). Jedna część bez numeru, kilka z „(n/k) ”.
 */
export function podziel(tekst, limit = LIMIT_ZNAKOW) {
  if (limit <= ZAPAS_NA_NUMER * 2) throw new Error(`Limit części musi być większy niż ${ZAPAS_NA_NUMER * 2} znaków.`);
  const caly = String(tekst ?? '').replace(/\r\n?/g, '\n').trim();
  if (caly.length === 0) return [];
  if (caly.length <= limit) return [caly];
  const naCzesc = limit - ZAPAS_NA_NUMER;
  const czesci = [];
  let reszta = caly;
  while (reszta.length > naCzesc) {
    const { koniec, dalej } = miejsceCiecia(reszta, naCzesc);
    const kawalek = reszta.slice(0, koniec).trimEnd();
    if (kawalek) czesci.push(kawalek);
    reszta = reszta.slice(dalej).replace(/^\n+/, '');
  }
  if (reszta.trim()) czesci.push(reszta);
  return czesci.map((czesc, i) => `(${i + 1}/${czesci.length}) ${czesc}`);
}

/** Identyfikatory czatów z TELEGRAM_CHAT_ID: liczby (grupy z minusem), kilka po przecinku. */
export function czytajCzaty(wartosc) {
  const czaty = String(wartosc ?? '')
    .split(',')
    .map((czat) => czat.trim())
    .filter(Boolean);
  if (czaty.length === 0) return { blad: 'Brak TELEGRAM_CHAT_ID: ustaw identyfikator czatu w zmiennych środowiska sesji.' };
  if (czaty.some((czat) => !/^-?\d+$/.test(czat))) {
    return { blad: 'TELEGRAM_CHAT_ID: identyfikator czatu to liczba (kilka po przecinku).' };
  }
  return { czaty };
}

/** Rodzaj błędu sieci bez treści komunikatu (komunikat mógłby zawierać adres z tokenem). */
function rodzajBledu(blad) {
  return blad?.cause?.code ?? blad?.code ?? blad?.name ?? 'błąd';
}

async function wyslijCzesc({ token, czat, tekst, fetch, czekaj }) {
  let ostatni = 'nieznany błąd';
  for (let proba = 1; proba <= PROBY; proba++) {
    let odpowiedz;
    try {
      odpowiedz = await fetch(`${ADRES_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: czat, text: tekst, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (blad) {
      ostatni = `brak połączenia z api.telegram.org (${rodzajBledu(blad)}); w chmurze dopisz api.telegram.org w Allowed domains środowiska`;
      if (proba < PROBY) await czekaj(2000 * proba);
      continue;
    }
    const dane = await odpowiedz.json().catch(() => null);
    if (odpowiedz.ok && dane?.ok === true) return null;
    ostatni = dane?.description
      ? `HTTP ${odpowiedz.status}: ${String(dane.description).slice(0, 200)}`
      : `HTTP ${odpowiedz.status} bez odpowiedzi Telegrama (możliwa blokada sieci środowiska: api.telegram.org w Allowed domains)`;
    if (odpowiedz.status !== 429 && odpowiedz.status < 500) return ostatni;
    if (proba < PROBY) {
      const poczekaj = Number(dane?.parameters?.retry_after);
      await czekaj(odpowiedz.status === 429 && poczekaj > 0 ? Math.min(poczekaj, 60) * 1000 : 2000 * proba);
    }
  }
  return ostatni;
}

/**
 * @typedef {(adres: string, opcje: { method: string, headers: Record<string, string>, body: string, signal?: AbortSignal })
 *   => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} FetchTelegrama
 */

/**
 * Wysyła części po kolei do każdego czatu. Po błędzie części dalsze części
 * do tego czatu nie idą (bez dziur w środku raportu). Zwraca listę błędów.
 * @param {{ token: string, czaty: string[], czesci: string[], fetch?: FetchTelegrama, czekaj?: (ms: number) => Promise<unknown> }} opcje
 * @returns {Promise<string[]>}
 */
export async function wyslij({ token, czaty, czesci, fetch = globalThis.fetch, czekaj = czekajMs }) {
  const bledy = [];
  for (const [numerCzatu, czat] of czaty.entries()) {
    for (const [indeks, tekst] of czesci.entries()) {
      const blad = await wyslijCzesc({ token, czat, tekst, fetch, czekaj });
      if (blad) {
        bledy.push(`czat ${numerCzatu + 1}, część ${indeks + 1}/${czesci.length}: ${ukryjToken(blad, token)}`);
        break;
      }
    }
  }
  return bledy;
}

/** Standardowe wejście; bez danych przez 30 s (otwarte, puste wejście) kończy pustym tekstem zamiast czekać bez końca. */
async function czytajWejscie(cisza = 30_000) {
  if (process.stdin.isTTY) return '';
  const kawalki = [];
  const czytaj = (async () => {
    for await (const kawalek of process.stdin) kawalki.push(Buffer.isBuffer(kawalek) ? kawalek : Buffer.from(String(kawalek)));
  })();
  let zegar;
  const limit = new Promise((gotowe) => {
    zegar = setTimeout(() => gotowe('cisza'), cisza);
  });
  const wynik = await Promise.race([czytaj.then(() => 'koniec'), limit]);
  clearTimeout(zegar);
  if (wynik === 'cisza' && kawalki.length === 0) process.stdin.destroy();
  else if (wynik === 'cisza') await czytaj;
  return Buffer.concat(kawalki).toString('utf8');
}

export async function glowna(argv, zaleznosci = {}) {
  const {
    env = process.env,
    wejscie,
    fetch = globalThis.fetch,
    czekaj = czekajMs,
    wypisz = (tekst) => console.log(tekst),
    bledy = (tekst) => console.error(tekst),
  } = zaleznosci;
  const podglad = argv.includes('--podglad');
  const nieznane = argv.filter((argument) => argument.startsWith('-') && argument !== '--podglad');
  const pliki = argv.filter((argument) => !argument.startsWith('-'));
  if (nieznane.length > 0 || pliki.length > 1) {
    bledy(UZYCIE);
    return 2;
  }

  let tekst;
  if (pliki.length === 1) {
    try {
      tekst = readFileSync(pliki[0], 'utf8');
    } catch {
      bledy(`Nie mogę przeczytać pliku z raportem: ${pliki[0]}`);
      return 2;
    }
  } else {
    tekst = wejscie ?? (await czytajWejscie());
  }
  const czesci = podziel(tekst);
  if (czesci.length === 0) {
    bledy('Pusty raport: nie ma czego wysłać.');
    return 2;
  }
  if (czesci.length > NAJWYZEJ_CZESCI) {
    bledy(`Raport za długi: ${czesci.length} części, najwyżej ${NAJWYZEJ_CZESCI}. Skróć go (szczegóły są w dzienniku).`);
    return 2;
  }
  if (podglad) {
    for (const czesc of czesci) wypisz(`--- ${czesc.length} znaków ---\n${czesc}`);
    wypisz(`Części: ${czesci.length}.`);
    return 0;
  }

  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) {
    bledy('Brak TELEGRAM_BOT_TOKEN: ustaw token bota w zmiennych środowiska sesji (nie w czacie i nie w repozytorium).');
    return 2;
  }
  if (!TOKEN.test(token)) {
    bledy('TELEGRAM_BOT_TOKEN ma zły format (oczekiwane: liczba, dwukropek i znaki tokenu z BotFathera).');
    return 2;
  }
  const { czaty, blad } = czytajCzaty(env.TELEGRAM_CHAT_ID);
  if (!czaty) {
    bledy(blad);
    return 2;
  }
  const bledyWysylki = await wyslij({ token, czaty, czesci, fetch, czekaj });
  if (bledyWysylki.length > 0) {
    for (const opis of bledyWysylki) bledy(`Telegram: ${opis}`);
    return 1;
  }
  wypisz(`Wysłano raport (części: ${czesci.length}, czaty: ${czaty.length}).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  glowna(process.argv.slice(2))
    .then((kod) => {
      process.exitCode = kod;
    })
    .catch((blad) => {
      const opis = blad instanceof Error ? blad.message : 'nieznany błąd';
      console.error(`telegram: ${ukryjToken(opis, String(process.env.TELEGRAM_BOT_TOKEN ?? '').trim())}`);
      process.exitCode = 1;
    });
}
