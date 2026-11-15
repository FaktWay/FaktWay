import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  LIMIT_ZNAKOW,
  NAJWYZEJ_CZESCI,
  czytajCzaty,
  glowna,
  podziel,
  ukryjToken,
  wyslij,
} from '@/scripts/nocny/telegram.mjs';

/**
 * Raport nocnego zespołu na Telegram (docs/runbooks/nocny-zespol.md):
 * podział powyżej 4096 znaków, zwykły tekst, token tylko w adresie zapytania,
 * nigdy w wyjściu ani w błędach. Sieć tylko przez atrapę `fetch`.
 */

const TOKEN = '123456789:AAFake_token-for-tests_0123456789';
const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_IDS: '111222333' };

type Wywolanie = { url: string; body: { chat_id: string; text: string; parse_mode?: string; link_preview_options?: unknown } };

function odpowiedz(status: number, dane: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => dane };
}

function atrapaFetch(...odpowiedzi: Array<ReturnType<typeof odpowiedz> | Error>) {
  const wywolania: Wywolanie[] = [];
  let licznik = 0;
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    wywolania.push({ url, body: JSON.parse(init.body) });
    const nastepna = odpowiedzi[Math.min(licznik++, odpowiedzi.length - 1)] ?? odpowiedz(200, { ok: true, result: {} });
    if (nastepna instanceof Error) throw nastepna;
    return nastepna;
  });
  return { fetch, wywolania };
}

const ok = () => odpowiedz(200, { ok: true, result: { message_id: 1 } });

async function uruchom(argv: string[], opcje: { env?: Record<string, string>; wejscie?: string; fetch?: unknown } = {}) {
  const wyjscie: string[] = [];
  const bledy: string[] = [];
  const czekaj = vi.fn(async () => {});
  const kod = await glowna(argv, {
    env: opcje.env ?? env,
    wejscie: opcje.wejscie,
    fetch: opcje.fetch,
    czekaj,
    wypisz: (tekst: string) => wyjscie.push(tekst),
    bledy: (tekst: string) => bledy.push(tekst),
  });
  return { kod, wyjscie: wyjscie.join('\n'), bledy: bledy.join('\n'), czekaj };
}

function akapity(ile: number, dlugosc = 300) {
  return Array.from({ length: ile }, (_, i) => `Akapit ${i + 1}: ${'słowo '.repeat(dlugosc / 6).trim()}`).join('\n\n');
}

describe('podziel', () => {
  it('krótki raport to jedna część bez numeru, bez białych znaków na brzegach', () => {
    expect(podziel('  Noc spokojna.\r\nNic do zrobienia.\n\n')).toEqual(['Noc spokojna.\nNic do zrobienia.']);
    expect(podziel('a'.repeat(LIMIT_ZNAKOW))).toHaveLength(1);
  });

  it('pusty tekst nie daje żadnej części', () => {
    expect(podziel('')).toEqual([]);
    expect(podziel(' \n\n ')).toEqual([]);
  });

  it('długi raport dzieli na akapitach, każda część mieści się w limicie Telegrama', () => {
    const tekst = akapity(40);
    expect(tekst.length).toBeGreaterThan(LIMIT_ZNAKOW * 2);
    const czesci = podziel(tekst);
    expect(czesci.length).toBeGreaterThan(2);
    for (const [i, czesc] of czesci.entries()) {
      expect(czesc.length).toBeLessThanOrEqual(LIMIT_ZNAKOW);
      expect(czesc.startsWith(`(${i + 1}/${czesci.length}) `)).toBe(true);
      // Cięcie na granicy akapitu: część kończy się pełnym akapitem.
      expect(czesc.endsWith('słowo')).toBe(true);
    }
    const bezNumerow = czesci.map((czesc) => czesc.replace(/^\(\d+\/\d+\) /, '')).join('\n\n');
    expect(bezNumerow).toBe(tekst);
  });

  it('bez pustych linii tnie na końcach linii, potem na spacjach, nie gubiąc słów', () => {
    const linie = Array.from({ length: 30 }, (_, i) => `linia ${i} ${'x'.repeat(40)}`).join('\n');
    const czesci = podziel(linie, 200);
    for (const czesc of czesci) expect(czesc.length).toBeLessThanOrEqual(200);
    expect(czesci.map((c) => c.replace(/^\(\d+\/\d+\) /, '')).join('\n')).toBe(linie);

    const zdanie = Array.from({ length: 80 }, (_, i) => `wyraz${i}`).join(' ');
    const poSpacjach = podziel(zdanie, 120);
    for (const czesc of poSpacjach) expect(czesc.length).toBeLessThanOrEqual(120);
    expect(poSpacjach.map((c) => c.replace(/^\(\d+\/\d+\) /, '')).join(' ')).toBe(zdanie);
  });

  it('twarde cięcie nie rozrywa emoji (pary surogatów)', () => {
    const emoji = '🟢'.repeat(500);
    const czesci = podziel(emoji, 101);
    for (const czesc of czesci) {
      expect(czesc.length).toBeLessThanOrEqual(101);
      const tresc = czesc.replace(/^\(\d+\/\d+\) /, '');
      expect(/[\uD800-\uDBFF]$/.test(tresc)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(tresc)).toBe(false);
    }
    expect(czesci.map((c) => c.replace(/^\(\d+\/\d+\) /, '')).join('')).toBe(emoji);
  });

  it('odrzuca limit, w którym nie zmieści się numer części', () => {
    expect(() => podziel('x', 20)).toThrow(/Limit części/);
  });
});

describe('czytajCzaty i ukryjToken', () => {
  it('jeden albo kilka identyfikatorów po przecinku, grupy z minusem', () => {
    expect(czytajCzaty('111')).toEqual({ czaty: ['111'] });
    expect(czytajCzaty(' 111 , -100222 ,')).toEqual({ czaty: ['111', '-100222'] });
  });

  it('brak albo zły identyfikator to błąd z nazwą zmiennej', () => {
    expect(czytajCzaty('').blad).toMatch(/TELEGRAM_CHAT_IDS/);
    expect(czytajCzaty(undefined).blad).toMatch(/TELEGRAM_CHAT_IDS/);
    expect(czytajCzaty('111,@kanal').blad).toMatch(/liczba/);
  });

  it('zamienia każde wystąpienie tokenu', () => {
    expect(ukryjToken(`a ${TOKEN} b /bot${TOKEN}/x`, TOKEN)).toBe('a [token] b /bot[token]/x');
    expect(ukryjToken('bez tokenu', '')).toBe('bez tokenu');
  });
});

describe('wysyłka', () => {
  it('jedna wiadomość: POST na sendMessage, zwykły tekst, bez podglądu linków, token tylko w adresie', async () => {
    const { fetch, wywolania } = atrapaFetch(ok());
    const wynik = await uruchom([], { wejscie: 'Noc: 2 błędy naprawione.', fetch });
    expect(wynik.kod).toBe(0);
    expect(wywolania).toHaveLength(1);
    expect(wywolania[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(wywolania[0].body).toEqual({
      chat_id: '111222333',
      text: 'Noc: 2 błędy naprawione.',
      link_preview_options: { is_disabled: true },
    });
    expect(wywolania[0].body.parse_mode).toBeUndefined();
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(`${wynik.wyjscie}${wynik.bledy}`).not.toContain(TOKEN);
  });

  it('długi raport idzie częściami po kolei, każdy czat dostaje całość', async () => {
    const { fetch, wywolania } = atrapaFetch(ok());
    const tekst = akapity(30);
    const czesci = podziel(tekst);
    const wynik = await uruchom([], { env: { ...env, TELEGRAM_CHAT_IDS: '111,-100222' }, wejscie: tekst, fetch });
    expect(wynik.kod).toBe(0);
    expect(wywolania.map((w) => w.body.chat_id)).toEqual([...czesci.map(() => '111'), ...czesci.map(() => '-100222')]);
    expect(wywolania.slice(0, czesci.length).map((w) => w.body.text)).toEqual(czesci);
    for (const w of wywolania) expect(w.body.text.length).toBeLessThanOrEqual(LIMIT_ZNAKOW);
    expect(wynik.wyjscie).toContain(`części: ${czesci.length}, czaty: 2`);
  });

  it('błąd Telegrama (400) bez ponawiania, kod 1, opis bez tokenu', async () => {
    const { fetch } = atrapaFetch(odpowiedz(400, { ok: false, error_code: 400, description: `Bad Request: chat not found (bot${TOKEN})` }));
    const wynik = await uruchom([], { wejscie: 'raport', fetch });
    expect(wynik.kod).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(wynik.bledy).toContain('chat not found');
    expect(wynik.bledy).not.toContain(TOKEN);
  });

  it('429 czeka retry_after sekund i ponawia', async () => {
    const { fetch } = atrapaFetch(odpowiedz(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }), ok());
    const wynik = await uruchom([], { wejscie: 'raport', fetch });
    expect(wynik.kod).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(wynik.czekaj).toHaveBeenCalledWith(3000);
  });

  it('błąd sieci: trzy próby, potem kod 1 z podpowiedzią o Allowed domains, bez tokenu', async () => {
    const blad = Object.assign(new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`), {
      cause: { code: 'ENOTFOUND' },
    });
    const { fetch } = atrapaFetch(blad);
    const wynik = await uruchom([], { wejscie: 'raport', fetch });
    expect(wynik.kod).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(wynik.bledy).toContain('ENOTFOUND');
    expect(wynik.bledy).toContain('Allowed domains');
    expect(wynik.bledy).not.toContain(TOKEN);
  });

  it('403 bez odpowiedzi Telegrama (proxy sieci) podpowiada Allowed domains', async () => {
    const { fetch } = atrapaFetch({ ok: false, status: 403, json: async () => { throw new SyntaxError('html'); } });
    const wynik = await uruchom([], { wejscie: 'raport', fetch });
    expect(wynik.kod).toBe(1);
    expect(wynik.bledy).toContain('HTTP 403');
    expect(wynik.bledy).toContain('Allowed domains');
  });

  it('po błędzie części dalsze części do tego czatu nie idą', async () => {
    const { fetch } = atrapaFetch(ok(), odpowiedz(400, { ok: false, description: 'Bad Request: message is too long' }), ok());
    const czekaj = vi.fn(async () => {});
    const bledy = await wyslij({ token: TOKEN, czaty: ['111'], czesci: ['(1/3) a', '(2/3) b', '(3/3) c'], fetch, czekaj });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bledy).toEqual(['czat 1, część 2/3: HTTP 400: Bad Request: message is too long']);
  });
});

describe('wejście i konfiguracja', () => {
  it('te same zmienne co nocne wdrożenie (TELEGRAM_CHAT_IDS), dawna TELEGRAM_CHAT_ID jako zapas', async () => {
    const { fetch, wywolania } = atrapaFetch(ok());
    expect((await uruchom([], { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '444' }, wejscie: 'x', fetch })).kod).toBe(0);
    expect((await uruchom([], { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_IDS: '555', TELEGRAM_CHAT_ID: '444' }, wejscie: 'x', fetch })).kod).toBe(0);
    expect(wywolania.map((w) => w.body.chat_id)).toEqual(['444', '555']);
  });

  it('czyta raport z pliku', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'nocny-telegram-'));
    const plik = join(katalog, 'raport.txt');
    writeFileSync(plik, 'Raport z pliku.\n');
    const { fetch, wywolania } = atrapaFetch(ok());
    const wynik = await uruchom([plik], { fetch });
    expect(wynik.kod).toBe(0);
    expect(wywolania[0].body.text).toBe('Raport z pliku.');
  });

  it('podgląd pokazuje części i nie wysyła, token niepotrzebny', async () => {
    const { fetch } = atrapaFetch(ok());
    const wynik = await uruchom(['--podglad'], { env: {}, wejscie: akapity(20), fetch });
    expect(wynik.kod).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(wynik.wyjscie).toMatch(/Części: \d+\./);
  });

  it.each([
    ['brak tokenu', { TELEGRAM_CHAT_ID: '111' }, /TELEGRAM_BOT_TOKEN/],
    ['zły format tokenu', { TELEGRAM_BOT_TOKEN: 'proxy-injected', TELEGRAM_CHAT_ID: '111' }, /zły format/],
    ['brak czatu', { TELEGRAM_BOT_TOKEN: TOKEN }, /TELEGRAM_CHAT_IDS/],
  ])('%s: kod 2, nic nie wysyła, token nie trafia do wyjścia', async (_nazwa, zmienne, komunikat) => {
    const { fetch } = atrapaFetch(ok());
    const wynik = await uruchom([], { env: zmienne, wejscie: 'raport', fetch });
    expect(wynik.kod).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(wynik.bledy).toMatch(komunikat);
    expect(wynik.bledy).not.toContain(TOKEN);
  });

  it('pusty raport, za długi raport, zły argument: kod 2', async () => {
    const { fetch } = atrapaFetch(ok());
    expect((await uruchom([], { wejscie: '  ', fetch })).kod).toBe(2);
    expect((await uruchom([], { wejscie: akapity(NAJWYZEJ_CZESCI * 16), fetch })).kod).toBe(2);
    expect((await uruchom(['--markdown'], { wejscie: 'x', fetch })).kod).toBe(2);
    expect((await uruchom(['a.txt', 'b.txt'], { wejscie: 'x', fetch })).kod).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('wiersz poleceń (bez sieci)', () => {
  const cli = (argumenty: string[], input: string, zmienne: Record<string, string>) => {
    try {
      const stdout = execFileSync('node', ['scripts/nocny/telegram.mjs', ...argumenty], {
        input,
        encoding: 'utf8',
        // Czyste środowisko: bez prawdziwych zmiennych Telegrama z maszyny.
        env: { ...zmienne, PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { kod: 0, wyjscie: stdout };
    } catch (blad) {
      const e = blad as { status: number; stdout: string; stderr: string };
      return { kod: e.status, wyjscie: `${e.stdout}${e.stderr}` };
    }
  };

  it('podgląd ze standardowego wejścia', () => {
    const wynik = cli(['--podglad'], 'Raport nocy.', {});
    expect(wynik.kod).toBe(0);
    expect(wynik.wyjscie).toContain('Raport nocy.');
  });

  it('bez tokenu kończy kodem 2 i nie łączy się z siecią', () => {
    const wynik = cli([], 'Raport nocy.', { TELEGRAM_CHAT_ID: '111' });
    expect(wynik.kod).toBe(2);
    expect(wynik.wyjscie).toContain('TELEGRAM_BOT_TOKEN');
  });
});
