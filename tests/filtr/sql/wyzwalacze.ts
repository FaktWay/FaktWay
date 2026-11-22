import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Spis wyzwalaczy po wszystkich migracjach z `supabase/migrations`, czytany
 * statycznie (NZ-SQL-01). Migracje idą po kolei numerów: `CREATE TRIGGER`
 * dopisuje albo podmienia wyzwalacz, `DROP TRIGGER`, `DROP TABLE` i `DROP
 * FUNCTION … CASCADE` go usuwają, `ALTER TABLE … RENAME TO` przenosi na nową
 * nazwę tabeli. Funkcja wyzwalacza (`RETURNS trigger`) to jej ostatnia
 * definicja. Polecenia w blokach `DO` też się liczą. Wszystko, czego spis nie
 * umie odczytać (wyzwalacz z `EXECUTE`, `ALTER TRIGGER`, `DISABLE TRIGGER`,
 * zmiana nazwy funkcji), trafia do `nierozpoznane`, a test filtra wymaga
 * pustej listy, więc nowa postać polecenia nie przejdzie po cichu.
 *
 * `instrukcje` nie korzysta z `oczyscSql` (`scripts/ops/kontrola-migracji.mjs`),
 * bo tamta wycina ciała funkcji i treść napisów, a tu potrzebne są oba.
 * Zgodność spisu z prawdziwą bazą sprawdza `tests/rls-spis-wyzwalaczy.test.ts`
 * (job „RLS isolation”).
 */

export interface Wyzwalacz {
  /** `schemat.tabela` małymi literami. */
  tabela: string;
  nazwa: string;
  kiedy: string;
  zdarzenia: string;
  /** `schemat.funkcja` małymi literami. */
  funkcja: string;
  /** Migracja, w której wyzwalacz powstał ostatnio. */
  plik: string;
}

export interface FunkcjaWyzwalacza {
  nazwa: string;
  cialo: string;
  jezyk: string | null;
  plik: string;
}

export interface Spis {
  wyzwalacze: Wyzwalacz[];
  funkcje: Map<string, FunkcjaWyzwalacza>;
  nierozpoznane: string[];
}

export interface Wyjatek {
  komunikat: string | null;
  /** `ERRCODE`; bez niego PostgreSQL daje P0001. */
  kod: string | null;
  /** `HINT` i `DETAIL`, gdy podane jako napis. */
  podpowiedz: string | null;
  szczegoly: string | null;
}

const ZNAK_NAZWY = /[A-Za-z0-9_$]/;

/**
 * Dzieli SQL na instrukcje po średnikach poza komentarzami, napisami i
 * blokami `$tag$…$tag$`. Komentarze zamienia na spację, napisy i bloki
 * zostawia bez zmian.
 */
export function instrukcje(sql: string): string[] {
  const wynik: string[] = [];
  let biezaca = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const koniec = sql.indexOf('\n', i);
      i = koniec === -1 ? n : koniec;
      biezaca += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      let glebokosc = 1;
      i += 2;
      while (i < n && glebokosc > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          glebokosc += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          glebokosc -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      biezaca += ' ';
      continue;
    }
    if (c === "'") {
      const eskejp = /[eE]$/.test(biezaca) && !ZNAK_NAZWY.test(biezaca.at(-2) ?? '');
      let j = i + 1;
      while (j < n) {
        if (eskejp && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j += 1;
      }
      biezaca += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      biezaca += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$' && !ZNAK_NAZWY.test(sql[i - 1] ?? '')) {
      const znacznik = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80))?.[0];
      if (znacznik) {
        const koniec = sql.indexOf(znacznik, i + znacznik.length);
        if (koniec === -1) throw new Error(`Niedomknięty blok ${znacznik}`);
        biezaca += sql.slice(i, koniec + znacznik.length);
        i = koniec + znacznik.length;
        continue;
      }
    }
    if (c === ';') {
      if (biezaca.trim()) wynik.push(biezaca.trim());
      biezaca = '';
      i += 1;
      continue;
    }
    biezaca += c;
    i += 1;
  }
  if (biezaca.trim()) wynik.push(biezaca.trim());
  return wynik;
}

/**
 * Ta sama instrukcja z treścią napisów, nazw w cudzysłowach i bloków `$…$`
 * zamienioną na spacje (ta sama długość, więc indeksy pasują do oryginału);
 * do szukania słów kluczowych poza treścią.
 */
function bezTresci(s: string): string {
  let wynik = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    let koniec = -1;
    if (c === "'") {
      const eskejp = /[eE]/.test(s[i - 1] ?? '') && !ZNAK_NAZWY.test(s[i - 2] ?? '');
      koniec = i + 1;
      while (koniec < s.length) {
        if (eskejp && s[koniec] === '\\') {
          koniec += 2;
          continue;
        }
        if (s[koniec] === "'" && s[koniec + 1] === "'") {
          koniec += 2;
          continue;
        }
        if (s[koniec] === "'") break;
        koniec += 1;
      }
    } else if (c === '"') {
      koniec = s.indexOf('"', i + 1);
    } else if (c === '$' && !ZNAK_NAZWY.test(s[i - 1] ?? '')) {
      const znacznik = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 80))?.[0];
      if (znacznik) {
        const k = s.indexOf(znacznik, i + znacznik.length);
        koniec = k === -1 ? s.length - 1 : k + znacznik.length - 1;
      }
    }
    if (koniec === -1) {
      wynik += c;
      i += 1;
      continue;
    }
    koniec = Math.min(koniec, s.length - 1);
    wynik += c + ' '.repeat(Math.max(0, koniec - i - 1)) + (koniec > i ? s[koniec] : '');
    i = koniec + 1;
  }
  return wynik;
}

const NAZWA = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const KWALIFIKOWANA = String.raw`(?:${NAZWA}\s*\.\s*)?${NAZWA}`;

function nazwa(s: string): string {
  const czesci = s.split('.').map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase());
  return czesci.length === 1 ? `public.${czesci[0]}` : czesci.join('.');
}

const RE_WYZWALACZ = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(${NAZWA})\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]+?)\s+ON\s+(${KWALIFIKOWANA})\s+[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(${KWALIFIKOWANA})\s*\(`,
  'i',
);
const RE_USUN_WYZWALACZ = new RegExp(String.raw`^DROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?(${NAZWA})\s+ON\s+(${KWALIFIKOWANA})`, 'i');
const RE_FUNKCJA = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(${KWALIFIKOWANA})\s*\(`, 'i');
const RE_USUN_FUNKCJE = new RegExp(String.raw`^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$`, 'i');
const RE_USUN_TABELE = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$`, 'i');
const RE_NAZWA_TABELI = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${KWALIFIKOWANA})\s+RENAME\s+TO\s+(${NAZWA})\s*$`,
  'i',
);
const RE_DO = /^DO\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*)\1(?:\s+LANGUAGE\s+\w+)?$/i;
/** Polecenia o wyzwalaczach i funkcjach, których spis nie odczytuje (wyłączenie: `RE_OBEJSCIE`). */
const RE_NIEOBSLUGIWANE = /\b(ALTER\s+TRIGGER|ALTER\s+FUNCTION\s+[\s\S]*?\bRENAME\b)/i;
const RE_OBEJSCIE = /\bsession_replication_role\b|\b(?:DISABLE|ENABLE)\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER\b/i;
const RE_SLOWO_WYZWALACZ =/\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER|DROP\s+TRIGGER)\b/i;

/** Spis z podanych migracji (w kolejności tablicy). */
export function spisZMigracji(migracje: ReadonlyArray<{ plik: string; sql: string }>): Spis {
  const wyzwalacze = new Map<string, Wyzwalacz>();
  const funkcje = new Map<string, FunkcjaWyzwalacza>();
  const nierozpoznane: string[] = [];
  const skrot = (s: string) => s.replace(/\s+/g, ' ').slice(0, 160);

  const usunWyzwalaczeTabeli = (tabela: string) => {
    for (const [klucz, w] of [...wyzwalacze]) if (w.tabela === tabela) wyzwalacze.delete(klucz);
  };

  const obsluz = (s: string, plik: string): void => {
    // Wyłączenie wyzwalaczy także w ciele funkcji (wykonuje się później).
    if (RE_OBEJSCIE.test(s)) nierozpoznane.push(`${plik}: wyłączenie wyzwalaczy: ${skrot(s)}`);
    const bez = bezTresci(s);
    if (RE_NIEOBSLUGIWANE.test(bez)) {
      nierozpoznane.push(`${plik}: ${skrot(s)}`);
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = RE_WYZWALACZ.exec(s))) {
      const w: Wyzwalacz = {
        nazwa: nazwa(m[1]).split('.')[1],
        kiedy: m[2].toUpperCase().replace(/\s+/g, ' '),
        zdarzenia: m[3].replace(/\s+/g, ' ').trim(),
        tabela: nazwa(m[4]),
        funkcja: nazwa(m[5]),
        plik,
      };
      wyzwalacze.set(`${w.tabela}#${w.nazwa}`, w);
      return;
    }
    if ((m = RE_USUN_WYZWALACZ.exec(s))) {
      wyzwalacze.delete(`${nazwa(m[3])}#${nazwa(m[2]).split('.')[1]}`);
      return;
    }
    if ((m = RE_FUNKCJA.exec(s))) {
      if (!/\bRETURNS\s+trigger\b/i.test(bez)) return;
      const blok = /(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*?)\1/.exec(s);
      if (!blok) {
        nierozpoznane.push(`${plik}: funkcja wyzwalacza bez bloku $…$: ${skrot(s)}`);
        return;
      }
      const f = nazwa(m[1]);
      funkcje.set(f, {
        nazwa: f,
        cialo: blok[2],
        jezyk: /\bLANGUAGE\s+([A-Za-z]+)/i.exec(bez)?.[1]?.toLowerCase() ?? null,
        plik,
      });
      return;
    }
    if ((m = RE_USUN_FUNKCJE.exec(s))) {
      const kaskada = /\bCASCADE\s*$/i.test(m[1]);
      for (const czesc of m[1].replace(/\b(?:CASCADE|RESTRICT)\s*$/i, '').split(/,(?![^(]*\))/)) {
        const f = nazwa(czesc.replace(/\([\s\S]*$/, '').trim());
        funkcje.delete(f);
        if (kaskada) for (const [klucz, w] of [...wyzwalacze]) if (w.funkcja === f) wyzwalacze.delete(klucz);
      }
      return;
    }
    if ((m = RE_NAZWA_TABELI.exec(s))) {
      const stara = nazwa(m[1]);
      const nowa = `${stara.split('.')[0]}.${nazwa(m[2]).split('.')[1]}`;
      for (const [klucz, w] of [...wyzwalacze]) {
        if (w.tabela !== stara) continue;
        wyzwalacze.delete(klucz);
        wyzwalacze.set(`${nowa}#${w.nazwa}`, { ...w, tabela: nowa });
      }
      return;
    }
    if ((m = RE_USUN_TABELE.exec(s))) {
      for (const t of m[1].split(',')) usunWyzwalaczeTabeli(nazwa(t.trim()));
      return;
    }
    if ((m = RE_DO.exec(s))) {
      for (const w of instrukcje(m[2])) {
        const b = bezTresci(w);
        const start = b.search(RE_SLOWO_WYZWALACZ);
        if (start >= 0) {
          // `IF NOT EXISTS (… pg_trigger …) THEN CREATE TRIGGER …`: od słowa kluczowego.
          obsluz(w.slice(start), plik);
        } else if (/\bEXECUTE\b/i.test(b) && /\bTRIGGER\b/i.test(w)) {
          nierozpoznane.push(`${plik}: DO z EXECUTE i wyzwalaczem: ${skrot(w)}`);
        } else if (RE_NIEOBSLUGIWANE.test(b) || /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.test(b.replace(/^(?:BEGIN|DECLARE)\s+/i, ''))) {
          nierozpoznane.push(`${plik}: DO z poleceniem spoza spisu: ${skrot(w)}`);
        }
      }
      return;
    }
    if (RE_SLOWO_WYZWALACZ.test(bez)) nierozpoznane.push(`${plik}: ${skrot(s)}`);
  };

  for (const { plik, sql } of migracje) for (const s of instrukcje(sql)) obsluz(s, plik);
  for (const w of wyzwalacze.values()) {
    if (!funkcje.has(w.funkcja)) nierozpoznane.push(`${w.plik}: wyzwalacz ${w.tabela}#${w.nazwa} bez funkcji ${w.funkcja} w migracjach`);
  }
  return { wyzwalacze: [...wyzwalacze.values()], funkcje, nierozpoznane };
}

/** Spis z katalogu migracji repozytorium. */
export function spisWyzwalaczy(katalog = join(process.cwd(), 'supabase/migrations')): Spis {
  const pliki = readdirSync(katalog)
    .filter((f) => /^\d{5}_.+\.sql$/.test(f))
    .sort();
  return spisZMigracji(pliki.map((plik) => ({ plik, sql: readFileSync(join(katalog, plik), 'utf8') })));
}

/** Ciało funkcji bez komentarzy (`--` do końca linii, `/* … *\/`); napisy zostają, także z `--` w środku. */
export function bezKomentarzy(cialo: string): string {
  let wynik = '';
  let i = 0;
  while (i < cialo.length) {
    if (cialo[i] === "'") {
      let j = i + 1;
      while (j < cialo.length && !(cialo[j] === "'" && cialo[j + 1] !== "'")) j += cialo[j] === "'" ? 2 : 1;
      wynik += cialo.slice(i, j + 1);
      i = j + 1;
    } else if (cialo.startsWith('--', i)) {
      while (i < cialo.length && cialo[i] !== '\n') i += 1;
    } else if (cialo.startsWith('/*', i)) {
      const koniec = cialo.indexOf('*/', i + 2);
      wynik += ' ';
      i = koniec < 0 ? cialo.length : koniec + 2;
    } else {
      wynik += cialo[i];
      i += 1;
    }
  }
  return wynik;
}

/** Poziomy `RAISE`, które nie przerywają zapisu. */
const BEZ_BLEDU = /^\s*(?:DEBUG|LOG|INFO|NOTICE|WARNING)\b/i;

/**
 * Wyjątki w ciele funkcji: każde `RAISE` poza poziomami bez błędu i gołym
 * `RAISE;` (ponowienie w obsłudze wyjątku), także bez `EXCEPTION` (to poziom
 * domyślny), z nazwą warunku albo `SQLSTATE`, oraz `ASSERT`. Komunikat to
 * pierwszy napis albo `MESSAGE =`, kod to `ERRCODE` albo `SQLSTATE`.
 * Średnik w napisie nie kończy polecenia; komentarze się nie liczą.
 */
export function wyjatki(cialoZKomentarzami: string): Wyjatek[] {
  const cialo = bezKomentarzy(cialoZKomentarzami);
  // Słowa kluczowe szukane poza napisami (te same pozycje), napisy czytane z ciała.
  const maska = bezTresci(cialo);
  const wynik: Wyjatek[] = [];
  const re = /\b(RAISE|ASSERT)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(maska))) {
    let i = m.index + m[0].length;
    const asercja = m[1].toUpperCase() === 'ASSERT';
    if (!asercja) {
      const reszta = maska.slice(i);
      if (/^\s*;/.test(reszta) || BEZ_BLEDU.test(reszta)) continue;
      const poziom = /^\s*EXCEPTION\b/i.exec(reszta);
      if (poziom) i += poziom[0].length;
    }
    let przed = '';
    const napisy: Array<{ wartosc: string; przed: string }> = [];
    while (i < cialo.length && cialo[i] !== ';') {
      if (cialo[i] !== "'") {
        przed += cialo[i];
        i += 1;
        continue;
      }
      let j = i + 1;
      let wartosc = '';
      while (j < cialo.length) {
        if (cialo[j] === "'" && cialo[j + 1] === "'") {
          wartosc += "'";
          j += 2;
          continue;
        }
        if (cialo[j] === "'") break;
        wartosc += cialo[j];
        j += 1;
      }
      napisy.push({ wartosc, przed });
      przed += "''";
      i = j + 1;
    }
    if (asercja) {
      // `ASSERT warunek, 'komunikat'`: komunikat to ostatni napis po przecinku.
      const ostatni = napisy.at(-1);
      wynik.push({ komunikat: ostatni && /,\s*$/.test(ostatni.przed) ? ostatni.wartosc : null, kod: 'P0004', podpowiedz: null, szczegoly: null });
      continue;
    }
    const opcja = (nazwaOpcji: string) =>
      napisy.find((x) => new RegExp(String.raw`\b${nazwaOpcji}\s*=\s*$`, 'i').test(x.przed))?.wartosc ?? null;
    const sqlstate = napisy[0] !== undefined && /^\s*SQLSTATE\s*$/i.test(napisy[0].przed);
    const pierwszy = napisy[0] && !sqlstate && !/=\s*$/.test(napisy[0].przed) ? napisy[0].wartosc : null;
    wynik.push({
      komunikat: opcja('MESSAGE') ?? pierwszy,
      kod: opcja('ERRCODE') ?? (sqlstate ? napisy[0].wartosc : null),
      podpowiedz: opcja('HINT'),
      szczegoly: opcja('DETAIL'),
    });
  }
  return wynik;
}

/**
 * Funkcja cicho cofa albo pomija zmianę (bez wyjątku): przypisanie starej
 * wartości (`NEW.x := OLD.x`, `NEW.x = OLD.x`, `NEW := OLD` na początku
 * polecenia), `RETURN NULL` w wyzwalaczu BEFORE albo `RETURN OLD` w BEFORE
 * UPDATE bez DELETE (przy DELETE `RETURN OLD` przepuszcza usunięcie). Takiej
 * dziś nie ma; gdyby powstała, test filtra traktuje ją jak strażnika bez
 * komunikatu.
 */
export function cichoBlokuje(cialoZKomentarzami: string, kiedy: string, zdarzenia = ''): boolean {
  const cialo = bezTresci(bezKomentarzy(cialoZKomentarzami));
  const przypisanie = /(?:^|;|\bTHEN\b|\bELSE\b|\bBEGIN\b|\bLOOP\b)\s*NEW(?:\.\w+)?\s*:?=\s*OLD(?:\.\w+)?\s*;/im;
  if (/\bNEW\.\w+\s*:=\s*OLD\.\w+/i.test(cialo) || przypisanie.test(cialo)) return true;
  if (kiedy !== 'BEFORE') return false;
  if (/\bRETURN\s+NULL\b/i.test(cialo)) return true;
  return /\bUPDATE\b/i.test(zdarzenia) && !/\bDELETE\b/i.test(zdarzenia) && /\bRETURN\s+OLD\b/i.test(cialo);
}

/**
 * Funkcja woła inną funkcję z `public` (`PERFORM public.f(…)`, `SELECT
 * public.f(…)`, `x := public.f(…)`): strażnik może być w tamtej funkcji.
 */
export function wolaFunkcje(cialoZKomentarzami: string): string[] {
  const cialo = bezTresci(bezKomentarzy(cialoZKomentarzami));
  return [...new Set([...cialo.matchAll(/(?:\bPERFORM|\bSELECT|:=|\bRETURN)\s+(?:\(\s*)?public\.(\w+)\s*\(/gi)].map((x) => x[1].toLowerCase()))];
}
