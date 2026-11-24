import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { cichoBlokuje, spisWyzwalaczy, spisZMigracji, wolaFunkcje, wyjatki, type Spis } from '../sql/wyzwalacze';

/**
 * NZ-SQL-01 (żelazny filtr, uzupełnienie po spisie luk z 16.11): wyzwalacze
 * niezmienności i przejść stanów są sprawdzone na prawdziwej bazie (job
 * „RLS isolation”, testy `tests/rls-*.test.ts`).
 *
 * 1. Spis wyzwalaczy po wszystkich migracjach (`tests/filtr/sql/wyzwalacze.ts`)
 *    czyta każde polecenie o wyzwalaczach; to, czego nie umie, jest czerwone.
 *    Zgodność spisu z bazą po migracjach (te same wyzwalacze i ciała funkcji)
 *    sprawdza `tests/rls-spis-wyzwalaczy.test.ts`.
 * 2. Strażnik to funkcja wyzwalacza z wyjątkiem (każde `RAISE` poza poziomami
 *    bez błędu i gołym `RAISE;`, także `ASSERT`) albo z cichym cofnięciem
 *    zmiany. Jednostką jest funkcja: wyzwalacze tej samej funkcji (np. osobno
 *    UPDATE i DELETE) liczą się razem. Strażnik ma test na bazie, gdy któryś
 *    `tests/rls-*.test.ts` sprawdza jego komunikat, HINT albo DETAIL w
 *    argumencie dopasowania `expect(…)` bez `.not` (napis, wyrażenie regularne
 *    albo stała z napisem z góry pliku). Sam kod błędu nie wystarcza, bo 42501
 *    daje też odmowa RLS i brak uprawnień, więc taki test nie odróżnia
 *    strażnika od polityki. Wzorzec pasujący do tekstów więcej niż trzech
 *    funkcji się nie liczy; pasujący do dwóch albo trzech liczy się, gdy plik
 *    testu wymienia tabelę tylko jednej z nich. Fragment liczy się od 12 znaków
 *    i dwóch słów; jedno słowo (także z polskimi literami) i nazwa techniczna
 *    tylko jako cały tekst.
 * 3. `BEZ_KOMUNIKATU`: strażnicy bez takiego testu dziś. `kod`: test na bazie
 *    robi zabroniony zapis i sprawdza tylko kod błędu albo tylko to, że jest
 *    błąd (plik musi istnieć i wymieniać tabelę). `brak`: żaden test nie
 *    próbuje zabronionego zapisu albo zapis zatrzymuje wcześniej inny
 *    strażnik (FZ-024). Lista jest dokładna: strażnik z testem tekstu z niej
 *    schodzi. Zapadka: nazwy z list bez testu stoją w jednej linii
 *    (`ZAPADKA_*`) i muszą się zgadzać z listami co do nazwy, więc nowy wpis
 *    nie przejdzie jako sama dopisana linia: zmiana linii zapadki (jak każda
 *    zmieniona albo usunięta linia w `tests/filtr`) wymaga etykiety
 *    `zgoda:zmiana-filtra`.
 * 4. `SKUTKI`: wyzwalacze bez wyjątku (znacznik czasu, audyt, wpłaty,
 *    numeracja, harmonogram) z testem na bazie albo powodem; funkcja, która
 *    woła inną funkcję z `public` (tam może być strażnik), tylko z testem.
 *
 * Ograniczenia (drugi czytelnik, 22.11): pokrycie liczy się na funkcję, nie
 * na parę funkcja i tabela ani na każdą gałąź wyjątku; wpis `kod` sprawdza
 * tylko, że plik testu wymienia tabelę; literał w bloku pomijanym w CI też się
 * liczy; formy migracji, których spis nie czyta (np. `DO LANGUAGE`, DDL
 * w bloku `DO`, `SET SCHEMA`), zatrzymuje dopiero test na bazie
 * (`tests/rls-spis-wyzwalaczy.test.ts`).
 *
 * Mapowanie `kod` i `brak` z odczytu testów 17.11.2026 (który zapis, jaką
 * rolą, czy trafia w strażnika, a nie w RLS albo wcześniejszy wyzwalacz).
 */

const MIGRACJE = join(process.cwd(), 'supabase/migrations');
const TESTY = join(process.cwd(), 'tests');

type BezKomunikatu = { stan: 'kod'; test: string; uwaga: string } | { stan: 'brak'; uwaga: string };

const BEZ_KOMUNIKATU: Record<string, BezKomunikatu> = {};

/** Wyzwalacze bez wyjątku: funkcja, test na bazie (plik w `tests/`) albo powód braku. */
const SKUTKI: Record<string, { test?: string; uwaga: string }> = {
  set_updated_at: { uwaga: 'znacznik czasu updated_at, bez znaczenia dla treści dokumentów' },
  handle_new_user: { uwaga: 'profil public.users po rejestracji; testy na bazie dopisują profil same (upsert), więc wyzwalacz nie jest sprawdzony wprost' },
  audit_api_key_change: { test: 'rls-api-klucze.test.ts', uwaga: 'wpisy audytu api_key.created i api_key.revoked' },
  audit_webhook_endpoint_change: { test: 'rls-webhooki.test.ts', uwaga: 'wpisy audytu webhook.*' },
  update_invoice_payment_status: { test: 'rls-zaplacone.test.ts', uwaga: 'payment_status z wpłat i terminu' },
  recalculate_invoice_paid_amount: { test: 'rls-wplaty-czesciowe.test.ts', uwaga: 'paid_amount z sumy wpłat' },
  invoice_number_release: { test: 'rls-numeracja.test.ts', uwaga: 'numer wraca po usunięciu ostatniego szkicu' },
  ksef_inbox_schedule_on_tenant_change: { test: 'rls-skrzynka-harmonogram.test.ts', uwaga: 'harmonogram skrzynki KSeF po zapisaniu poświadczeń' },
  reopen_reviewed_financial_cases_for_payment: { uwaga: 'bez testu na bazie: ponowne otwarcie sprawy finansowej abonamentu po zmianie płatności Stripe' },
};

/**
 * Zapadka list bez testu (drugi czytelnik, Z3 i Z10): nazwy stoją w jednej
 * linii i muszą się zgadzać z listami, więc dopisanie strażnika albo skutku
 * bez testu zmienia tę linię (etykieta `zgoda:zmiana-filtra`). Zejście
 * z listy też ją zmienia, ale usunięcie wpisu z listy i tak wymaga tej
 * etykiety (usunięta linia w `tests/filtr`).
 */
// prettier-ignore
const ZAPADKA_BEZ_KOMUNIKATU = '';
// prettier-ignore
const ZAPADKA_SKUTKI_BEZ_TESTU = 'handle_new_user reopen_reviewed_financial_cases_for_payment set_updated_at';

// ─── Pokrycie: teksty strażników w testach na bazie ──────────────────────

interface Straznik {
  funkcja: string;
  tabele: string[];
  /** Komunikaty, HINT i DETAIL (`%` to miejsce na wartość). */
  teksty: string[];
}

interface PlikTestu {
  plik: string;
  kod: string;
}

type Literal = { napis: string } | { wzorzec: RegExp };

/** Dopasowania `expect`, których argumenty sprawdzają tekst (tytuły i opisy `expect(x, '…')` to nie sprawdzenie). */
const DOPASOWANIA = new Set(['toMatch', 'toContain', 'toContainEqual', 'toBe', 'toEqual', 'toStrictEqual', 'toThrow', 'toThrowError', 'toMatchObject', 'toHaveProperty']);

/** Czy wywołanie dopasowania stoi w łańcuchu `expect(…)` (także `.rejects`, `.resolves`, `expect.soft`) i czy ma w nim `.not`. */
function lancuchExpect(wywolanie: ts.CallExpression): { expect: boolean; not: boolean } {
  let not = false;
  let w: ts.Expression = wywolanie.expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(w)) {
      if (w.name.text === 'not') not = true;
      w = w.expression;
    } else if (ts.isCallExpression(w)) {
      const c = w.expression;
      if (ts.isIdentifier(c) && c.text === 'expect') return { expect: true, not };
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'expect') return { expect: true, not };
      w = c;
    } else if (ts.isNonNullExpression(w) || ts.isParenthesizedExpression(w) || ts.isAwaitExpression(w)) {
      w = w.expression;
    } else {
      return { expect: false, not };
    }
  }
}

/**
 * Napisy i wyrażenia regularne z argumentów dopasowań `expect` bez `.not`
 * (także zagnieżdżone, np. `expect.stringMatching`); stała z napisem
 * zadeklarowana na górze pliku (`const ODMOWA = '…'`) liczy się jak jej napis.
 */
function literaly(plik: PlikTestu): Literal[] {
  const wynik: Literal[] = [];
  const zrodlo = ts.createSourceFile(plik.plik, plik.kod, ts.ScriptTarget.Latest, true);
  const stale = new Map<string, ts.Node>();
  for (const w of zrodlo.statements) {
    if (!ts.isVariableStatement(w) || !(w.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of w.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) stale.set(d.name.text, d.initializer);
  }
  const zbierz = (wezel: ts.Node): void => {
    const nazwaWlasciwosci = ts.isPropertyAccessExpression(wezel.parent) && wezel.parent.name === wezel;
    if (ts.isIdentifier(wezel) && !nazwaWlasciwosci) {
      const stala = stale.get(wezel.text);
      if (stala && (ts.isStringLiteralLike(stala) || stala.kind === ts.SyntaxKind.RegularExpressionLiteral)) zbierz(stala);
    }
    if (ts.isStringLiteral(wezel) || ts.isNoSubstitutionTemplateLiteral(wezel)) wynik.push({ napis: wezel.text });
    else if (ts.isTemplateExpression(wezel)) {
      wynik.push({ napis: wezel.head.text });
      for (const czesc of wezel.templateSpans) wynik.push({ napis: czesc.literal.text });
    } else if (wezel.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const tekst = wezel.getText(zrodlo);
      const koniec = tekst.lastIndexOf('/');
      try {
        wynik.push({ wzorzec: new RegExp(tekst.slice(1, koniec), tekst.slice(koniec + 1).replace(/[gy]/g, '')) });
      } catch {
        // Wzorzec, którego ten Node nie zbuduje, nie jest sprawdzeniem komunikatu strażnika.
      }
    }
    ts.forEachChild(wezel, zbierz);
  };
  const odwiedz = (wezel: ts.Node): void => {
    if (ts.isCallExpression(wezel) && ts.isPropertyAccessExpression(wezel.expression) && DOPASOWANIA.has(wezel.expression.name.text)) {
      const l = lancuchExpect(wezel);
      if (l.expect && !l.not) for (const a of wezel.arguments) zbierz(a);
    }
    ts.forEachChild(wezel, odwiedz);
  };
  odwiedz(zrodlo);
  return wynik;
}

/** Część tekstu, która coś mówi: co najmniej 12 znaków i dwa słowa (jedno słowo, także z polskimi literami, liczy się tylko jako cały tekst). */
const dwaSlowa = (t: string) => t.trim().length >= 12 && /\S\s+\S/.test(t.trim());

/** Literał z testu sprawdza ten tekst strażnika. */
function pasuje(literal: Literal, tekst: string): boolean {
  const czesci = tekst.split('%').filter(dwaSlowa);
  if ('napis' in literal) {
    const n = literal.napis;
    if (n === tekst) return true;
    if (!dwaSlowa(n)) return false;
    return tekst.replace(/%/g, '\u0000').includes(n) || czesci.some((c) => n.includes(c.trim()));
  }
  const w = literal.wzorzec;
  const bezEskejpow = w.source.replace(/\\s[+*]?/g, ' ').replace(/\\(.)/g, '$1');
  if (!dwaSlowa(bezEskejpow)) return new RegExp(`^(?:${w.source})$`, w.flags).test(tekst);
  return w.test(tekst.replace(/%/g, 'X')) || czesci.some((c) => bezEskejpow.includes(c.trim()));
}

/** Funkcja strażnika → pliki testów, które sprawdzają jej tekst. */
function pokrycie(straznicy: Straznik[], pliki: PlikTestu[]): Map<string, Set<string>> {
  const wynik = new Map<string, Set<string>>();
  for (const plik of pliki) {
    for (const literal of literaly(plik)) {
      const trafione = straznicy.filter((s) => s.teksty.some((t) => pasuje(literal, t)));
      if (trafione.length === 0 || trafione.length > 3) continue;
      const zTabela = trafione.filter((s) => s.tabele.some((t) => plik.kod.includes(`'${t}'`)));
      const liczone = trafione.length === 1 ? trafione : zTabela.length === 1 ? zTabela : [];
      for (const s of liczone) {
        if (!wynik.has(s.funkcja)) wynik.set(s.funkcja, new Set());
        wynik.get(s.funkcja)!.add(plik.plik);
      }
    }
  }
  return wynik;
}

function straznicy(spis: Spis): Straznik[] {
  const wynik = new Map<string, Straznik>();
  for (const w of spis.wyzwalacze) {
    const funkcja = spis.funkcje.get(w.funkcja);
    if (!funkcja) continue;
    const wy = wyjatki(funkcja.cialo);
    if (wy.length === 0 && !cichoBlokuje(funkcja.cialo, w.kiedy, w.zdarzenia)) continue;
    const s = wynik.get(w.funkcja) ?? { funkcja: w.funkcja, tabele: [], teksty: [] };
    if (!s.tabele.includes(w.tabela.split('.')[1])) s.tabele.push(w.tabela.split('.')[1]);
    for (const x of wy) for (const t of [x.komunikat, x.podpowiedz, x.szczegoly]) if (t && !s.teksty.includes(t)) s.teksty.push(t);
    wynik.set(w.funkcja, s);
  }
  return [...wynik.values()].sort((a, b) => a.funkcja.localeCompare(b.funkcja));
}

const bezSchematu = (f: string) => f.replace(/^public\./, '');

// ─── Dane ────────────────────────────────────────────────────────────────

const SPIS = spisWyzwalaczy(MIGRACJE);
const STRAZNICY = straznicy(SPIS);
const PLIKI_TESTOW: PlikTestu[] = readdirSync(TESTY)
  .filter((f) => /^rls-.+\.test\.ts$/.test(f))
  .sort()
  .map((plik) => ({ plik, kod: readFileSync(join(TESTY, plik), 'utf8') }));
const POKRYCIE = pokrycie(STRAZNICY, PLIKI_TESTOW);

describe('NZ-SQL-01: spis wyzwalaczy z migracji', () => {
  it('spis czyta każde polecenie o wyzwalaczach i każdy wyzwalacz ma funkcję z migracji', () => {
    expect(SPIS.nierozpoznane).toEqual([]);
    expect(SPIS.wyzwalacze.length).toBeGreaterThan(80);
    expect(STRAZNICY.length).toBeGreaterThan(50);
  });

  it('kolejność migracji, DO, zmiana nazwy tabeli, usunięcia i przeciążenia na przykładzie', () => {
    const spis = spisZMigracji([
      {
        plik: '00001_a.sql',
        sql: `
          -- CREATE TRIGGER w komentarzu się nie liczy;
          CREATE TABLE public.t (id int);
          CREATE OR REPLACE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'Wiersz % jest niezmienny; zostaje', OLD.id USING ERRCODE = '42501', HINT = 't_niezmienny';
          END $$;
          CREATE FUNCTION public.f(x int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
          CREATE FUNCTION public.g() RETURNS TRIGGER AS $fn$ BEGIN RETURN OLD; END $fn$ LANGUAGE plpgsql;
          CREATE TRIGGER a BEFORE UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION public.f();
          CREATE TRIGGER b AFTER INSERT ON t FOR EACH ROW EXECUTE PROCEDURE f();
          COMMENT ON TABLE public.t IS 'CREATE TRIGGER x; w napisie';
          SELECT E'zawiera \\' ; CREATE TRIGGER nie_ma ON x';
        `,
      },
      {
        plik: '00002_b.sql',
        sql: `
          DROP TRIGGER IF EXISTS b ON public.t;
          DO $do$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'c') THEN
              CREATE TRIGGER c BEFORE DELETE ON public.t FOR EACH ROW EXECUTE FUNCTION public.g();
            END IF;
          END $do$;
          ALTER TABLE public.t RENAME TO u;
          CREATE TABLE public.v (id int);
          CREATE TRIGGER d BEFORE UPDATE ON public.v FOR EACH ROW EXECUTE FUNCTION public.g();
          DROP TABLE public.v;
        `,
      },
    ]);
    expect(spis.nierozpoznane).toEqual([]);
    expect(spis.wyzwalacze.map((w) => `${w.tabela}#${w.nazwa} ${w.kiedy} ${w.zdarzenia} -> ${w.funkcja} (${w.plik})`).sort()).toEqual([
      'public.u#a BEFORE UPDATE -> public.f (00001_a.sql)',
      'public.u#c BEFORE DELETE -> public.g (00002_b.sql)',
    ]);
    expect(wyjatki(spis.funkcje.get('public.f')!.cialo)).toEqual([
      { komunikat: 'Wiersz % jest niezmienny; zostaje', kod: '42501', podpowiedz: 't_niezmienny', szczegoly: null },
    ]);
  });

  it('inne postaci strażnika: RAISE bez EXCEPTION, warunek, SQLSTATE, ASSERT i ciche cofnięcie; komentarz, napis i poziom bez błędu się nie liczą', () => {
    const cialo = (x: string) => `BEGIN ${x} RETURN NEW; END`;
    expect(wyjatki(cialo("RAISE 'Bez poziomu %', NEW.id;"))).toEqual([{ komunikat: 'Bez poziomu %', kod: null, podpowiedz: null, szczegoly: null }]);
    expect(wyjatki(cialo("RAISE check_violation USING MESSAGE = 'Warunek', HINT = 'h';"))).toEqual([{ komunikat: 'Warunek', kod: null, podpowiedz: 'h', szczegoly: null }]);
    expect(wyjatki(cialo("RAISE SQLSTATE '42501' USING MESSAGE = 'Stan';"))).toEqual([{ komunikat: 'Stan', kod: '42501', podpowiedz: null, szczegoly: null }]);
    expect(wyjatki(cialo("ASSERT NEW.x = 'a', 'Asercja';"))).toEqual([{ komunikat: 'Asercja', kod: 'P0004', podpowiedz: null, szczegoly: null }]);
    expect(
      wyjatki(cialo("RAISE NOTICE 'informacja'; RAISE WARNING 'ostrzezenie'; -- RAISE EXCEPTION 'w komentarzu';\n /* RAISE 'blok' */ PERFORM log('nie RAISE tutaj'); EXCEPTION WHEN others THEN RAISE;")),
    ).toEqual([]);
    expect(cichoBlokuje(cialo('NEW.status = OLD.status;'), 'BEFORE', 'UPDATE')).toBe(true);
    expect(cichoBlokuje(cialo('IF NEW.status = OLD.status THEN RETURN NEW; END IF;'), 'BEFORE', 'UPDATE')).toBe(false);
    expect(cichoBlokuje('BEGIN NEW := OLD; RETURN NEW; END', 'BEFORE', 'UPDATE')).toBe(true);
    expect(cichoBlokuje('BEGIN RETURN OLD; END', 'BEFORE', 'UPDATE')).toBe(true);
    expect(cichoBlokuje('BEGIN RETURN OLD; END', 'BEFORE', 'UPDATE OR DELETE')).toBe(false);
    expect(cichoBlokuje('BEGIN RETURN OLD; END', 'AFTER', 'UPDATE')).toBe(false);
    expect(wolaFunkcje('BEGIN PERFORM public.sprawdz(NEW, OLD); INSERT INTO public.audit_logs (a) VALUES (1); RETURN NEW; END')).toEqual(['sprawdz']);
  });

  it('nieczytelne polecenia o wyzwalaczach są na liście nierozpoznanych', () => {
    const spis = spisZMigracji([
      {
        plik: '00003_c.sql',
        sql: `
          CREATE FUNCTION public.h() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
          DO $$ BEGIN EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION public.h()', 'x'); END $$;
          ALTER TABLE public.t DISABLE TRIGGER a;
          ALTER TRIGGER a ON public.t RENAME TO b;
          CREATE FUNCTION public.obejscie() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET session_replication_role = replica; END $$;
          CREATE TRIGGER e BEFORE UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION public.nie_ma();
        `,
      },
    ]);
    expect(spis.nierozpoznane).toHaveLength(5);
    expect(spis.nierozpoznane.join('\n')).toMatch(/EXECUTE i wyzwalaczem[\s\S]*DISABLE TRIGGER[\s\S]*ALTER TRIGGER[\s\S]*session_replication_role[\s\S]*bez funkcji public\.nie_ma/);
  });
});

describe('NZ-SQL-01: strażnicy mają test na bazie', () => {
  it('wzorzec ogólny albo nazwa techniczna nie liczy się jako test tekstu', () => {
    const s = (funkcja: string, tabela: string, ...teksty: string[]): Straznik => ({ funkcja, tabele: [tabela], teksty });
    const lista = [
      s('a', 'notes', 'Note % is issued and cannot be changed'),
      s('b', 'quotes', 'Quote % is issued and cannot be changed'),
      s('c', 'shares', 'share_link_revoked'),
      s('d', 'docs', 'Document cannot be changed'),
      s('e', 'regs', 'Register cannot be changed'),
    ];
    const wynik = pokrycie(lista, [
      { plik: 'notes.test.ts', kod: `from('notes'); expect(e).toMatch(/issued and cannot be changed/);` },
      { plik: 'oba.test.ts', kod: `from('notes'); from('quotes'); expect(e).toMatch(/issued and cannot be changed/);` },
      { plik: 'ogolny.test.ts', kod: `from('notes'); from('docs'); expect(e).toMatch(/cannot be changed/);` },
      // Wzorzec pasujący do tekstów czterech strażników nie liczy się nawet przy jednej tabeli w pliku.
      { plik: 'ogolny-jedna-tabela.test.ts', kod: `from('docs'); expect(e).toMatch(/cannot be changed/);` },
      { plik: 'nazwa.test.ts', kod: `from('shares'); expect(e.message).toBe('share_link_revoked'); from('notes'); x('notes');` },
      { plik: 'wartosc.test.ts', kod: `from('quotes'); expect(e.message).toContain('Quote PF/1 is issued and cannot be changed');` },
      { plik: 'tytul.test.ts', kod: `from('docs'); it('Document cannot be changed', () => {});` },
    ]);
    expect(Object.fromEntries([...wynik].map(([f, p]) => [f, [...p].sort()]))).toEqual({
      a: ['notes.test.ts'],
      b: ['wartosc.test.ts'],
      c: ['nazwa.test.ts'],
    });
  });

  it('słowo bez spacji, także z polskimi literami, szablon, dopasowanie z .not i napis poza dopasowaniem się nie liczą; stała z pliku tak', () => {
    const s = (funkcja: string, tabela: string, ...teksty: string[]): Straznik => ({ funkcja, tabele: [tabela], teksty });
    const lista = [
      s('w', 'archives', 'Archiwum może zmienić tylko właściciel firmy'),
      s('x', 'audit_logs', 'audit_logs is append-only (% blocked)'),
      s('y', 'invoices', 'faktura % jest wycofana'),
      s('z', 'notes', 'Note special data is written once'),
    ];
    const wynik = pokrycie(lista, [
      { plik: 'slowo.test.ts', kod: "from('archives'); expect(rola).toBe('właściciel');" },
      { plik: 'lacznik.test.ts', kod: "from('audit_logs'); expect(e.message).toContain('append-only');" },
      { plik: 'szablon.test.ts', kod: "from('invoices'); expect(e.message).toContain(`faktura ${numer}`);" },
      { plik: 'not.test.ts', kod: "from('archives'); expect(e.message).not.toMatch(/tylko właściciel firmy/);" },
      { plik: 'opis.test.ts', kod: "from('archives'); expect(e, 'Archiwum może zmienić tylko właściciel firmy').toBeNull();" },
      { plik: 'poza.test.ts', kod: "from('archives'); const blad = 'Archiwum może zmienić tylko właściciel firmy'; log(blad);" },
      { plik: 'stala.test.ts', kod: "const RAZ = 'written once';\nfrom('notes'); expect(e.message).toContain(RAZ);" },
      { plik: 'dlugi.test.ts', kod: "from('audit_logs'); await expect(zapis()).rejects.toThrow('audit_logs is append-only');" },
    ]);
    expect(Object.fromEntries([...wynik].map(([f, p]) => [f, [...p].sort()]))).toEqual({ x: ['dlugi.test.ts'], z: ['stala.test.ts'] });
  });

  it('każdy strażnik ma test tekstu albo dokładny wpis w BEZ_KOMUNIKATU', () => {
    const bledy: string[] = [];
    for (const s of STRAZNICY) {
      const nazwa = bezSchematu(s.funkcja);
      const pliki = POKRYCIE.get(s.funkcja);
      const wpis = BEZ_KOMUNIKATU[nazwa];
      if (pliki && wpis) bledy.push(`${nazwa}: test tekstu już jest (${[...pliki].sort().join(', ')}), usuń wpis z BEZ_KOMUNIKATU`);
      if (!pliki && !wpis) {
        bledy.push(
          `${nazwa} (${s.tabele.join(', ')}): brak testu na bazie, który sprawdza komunikat, HINT albo DETAIL; dopisz go w tests/rls-*.test.ts (${s.teksty.slice(0, 2).join(' | ')})`,
        );
      }
    }
    const funkcje = new Set(STRAZNICY.map((s) => bezSchematu(s.funkcja)));
    for (const nazwa of Object.keys(BEZ_KOMUNIKATU)) if (!funkcje.has(nazwa)) bledy.push(`${nazwa}: nie ma takiego strażnika, usuń wpis z BEZ_KOMUNIKATU`);
    expect(bledy).toEqual([]);
  });

  it('zapadka: listy bez testu zgadzają się z linią zapadki, więc nie rosną bez etykiety zgoda:zmiana-filtra', () => {
    const posortowane = (xs: Iterable<string>) => [...xs].sort();
    expect(posortowane(Object.keys(BEZ_KOMUNIKATU))).toEqual(posortowane(ZAPADKA_BEZ_KOMUNIKATU.split(' ').filter(Boolean)));
    expect(posortowane(Object.entries(SKUTKI).filter(([, w]) => !w.test).map(([n]) => n))).toEqual(posortowane(ZAPADKA_SKUTKI_BEZ_TESTU.split(' ')));
  });

  it('wpisy kod wskazują istniejący test na bazie, który wymienia tabelę strażnika', () => {
    const bledy: string[] = [];
    for (const [nazwa, wpis] of Object.entries(BEZ_KOMUNIKATU)) {
      if (wpis.stan !== 'kod') continue;
      const s = STRAZNICY.find((x) => bezSchematu(x.funkcja) === nazwa);
      const plik = PLIKI_TESTOW.find((p) => p.plik === wpis.test);
      if (!plik) bledy.push(`${nazwa}: nie ma tests/${wpis.test}`);
      else if (s && !s.tabele.some((t) => plik.kod.includes(`'${t}'`))) bledy.push(`${nazwa}: ${wpis.test} nie wymienia tabeli ${s.tabele.join(', ')}`);
    }
    expect(bledy).toEqual([]);
  });

  // FZ-024: ostatnie wpisy `brak` zeszły w paczce 3 (abonament); zostają tylko wpisy `kod` z listy wyżej.
  it('każdy strażnik ma na bazie test zabronionego zapisu (FZ-024)', () => {
    const bezTestu = Object.entries(BEZ_KOMUNIKATU)
      .filter(([, wpis]) => wpis.stan === 'brak')
      .map(([nazwa]) => nazwa);
    expect(bezTestu).toEqual([]);
  });
});

describe('NZ-SQL-01: wyzwalacze bez wyjątku', () => {
  it('każda funkcja wyzwalacza bez wyjątku ma wpis w SKUTKI z testem na bazie albo powodem', () => {
    const funkcje = new Map<string, Set<string>>();
    for (const w of SPIS.wyzwalacze) {
      const f = SPIS.funkcje.get(w.funkcja);
      if (!f || wyjatki(f.cialo).length > 0 || cichoBlokuje(f.cialo, w.kiedy, w.zdarzenia)) continue;
      const nazwa = bezSchematu(w.funkcja);
      if (!funkcje.has(nazwa)) funkcje.set(nazwa, new Set());
      funkcje.get(nazwa)!.add(w.tabela.split('.')[1]);
    }
    const bledy: string[] = [];
    for (const [nazwa, tabele] of funkcje) {
      const wpis = SKUTKI[nazwa];
      if (!wpis) {
        bledy.push(`${nazwa} (${[...tabele].join(', ')}): dopisz do SKUTKI test na bazie albo powód`);
        continue;
      }
      const f = SPIS.funkcje.get(`public.${nazwa}`);
      const wolane = f ? wolaFunkcje(f.cialo) : [];
      if (!wpis.test) {
        if (wolane.length > 0) bledy.push(`${nazwa}: woła ${wolane.join(', ')} (tam może być strażnik), więc w SKUTKI potrzebny test na bazie, nie sam powód`);
        continue;
      }
      const plik = PLIKI_TESTOW.find((p) => p.plik === wpis.test);
      if (!plik) bledy.push(`${nazwa}: nie ma tests/${wpis.test}`);
      else if (![...tabele].some((t) => plik.kod.includes(`'${t}'`))) bledy.push(`${nazwa}: ${wpis.test} nie wymienia tabeli ${[...tabele].join(', ')}`);
    }
    for (const nazwa of Object.keys(SKUTKI)) if (!funkcje.has(nazwa)) bledy.push(`${nazwa}: nie ma takiej funkcji wyzwalacza bez wyjątku, usuń wpis ze SKUTKI`);
    expect(bledy).toEqual([]);
    expect(existsSync(join(TESTY, 'rls-spis-wyzwalaczy.test.ts'))).toBe(true);
  });
});
