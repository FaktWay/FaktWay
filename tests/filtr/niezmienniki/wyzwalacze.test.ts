import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { cichoBlokuje, spisWyzwalaczy, spisZMigracji, wyjatki, type Spis } from '../sql/wyzwalacze';

/**
 * NZ-SQL-01 (żelazny filtr, uzupełnienie po spisie luk z 16.11): wyzwalacze
 * niezmienności i przejść stanów są sprawdzone na prawdziwej bazie (job
 * „RLS isolation”, testy `tests/rls-*.test.ts`).
 *
 * 1. Spis wyzwalaczy po wszystkich migracjach (`tests/filtr/sql/wyzwalacze.ts`)
 *    czyta każde polecenie o wyzwalaczach; to, czego nie umie, jest czerwone.
 *    Zgodność spisu z bazą po migracjach (te same wyzwalacze i ciała funkcji)
 *    sprawdza `tests/rls-spis-wyzwalaczy.test.ts`.
 * 2. Strażnik to funkcja wyzwalacza z `RAISE EXCEPTION` albo z cichym
 *    cofnięciem zmiany. Jednostką jest funkcja: wyzwalacze tej samej funkcji
 *    (np. osobno UPDATE i DELETE) liczą się razem. Strażnik ma test na bazie,
 *    gdy któryś `tests/rls-*.test.ts` sprawdza jego komunikat, HINT albo
 *    DETAIL: napis albo wyrażenie regularne, które do niego pasuje. Sam kod
 *    błędu nie wystarcza, bo 42501 daje też odmowa RLS i brak uprawnień, więc
 *    taki test nie odróżnia strażnika od polityki. Wzorzec pasujący do tekstów
 *    więcej niż trzech funkcji się nie liczy; pasujący do dwóch albo trzech
 *    liczy się, gdy plik testu wymienia tabelę tylko jednej z nich. Pojedyncze
 *    słowo albo nazwa techniczna liczy się tylko jako cały tekst.
 * 3. `BEZ_KOMUNIKATU`: strażnicy bez takiego testu dziś. `kod`: test na bazie
 *    robi zabroniony zapis i sprawdza tylko kod błędu (plik musi istnieć
 *    i wymieniać tabelę). `brak`: żaden test nie próbuje zabronionego zapisu
 *    (FZ-024). Lista jest dokładna: strażnik z testem tekstu z niej schodzi,
 *    nowy strażnik bez testu nie przejdzie.
 * 4. `SKUTKI`: wyzwalacze bez wyjątku (znacznik czasu, audyt, wpłaty,
 *    numeracja, harmonogram) z testem na bazie albo powodem.
 *
 * Mapowanie `kod` i `brak` z odczytu testów 17.11.2026 (który zapis, jaką
 * rolą, czy trafia w strażnika, a nie w RLS albo wcześniejszy wyzwalacz).
 */

const MIGRACJE = join(process.cwd(), 'supabase/migrations');
const TESTY = join(process.cwd(), 'tests');

type BezKomunikatu = { stan: 'kod'; test: string; uwaga: string } | { stan: 'brak'; uwaga: string };

const BEZ_KOMUNIKATU: Record<string, BezKomunikatu> = {
  // Faktury i cykl KSeF
  guard_invoice_delivery_history: {
    stan: 'kod',
    test: 'rls-cykl-wyzwalacze.test.ts',
    uwaga: 'klient: draft na queued, diagnostyka, treść failed (42501); INSERT z historią dostawy bez testu',
  },
  guard_invoice_pending_content: {
    stan: 'kod',
    test: 'rls-cykl-wyzwalacze.test.ts',
    uwaga: 'ten sam zapis klienta blokuje najpierw guard_invoice_delivery_history (kolejność nazw), więc niepewne; INSERT nie-szkicu i edycja treści w queued bez testu',
  },
  guard_invoice_payment_evidence: {
    stan: 'kod',
    test: 'rls-isolation.test.ts',
    uwaga: 'klient zmienia paid_amount, payment_status, paid_at (42501); gałąź faktury przyjętej łapie wcześniej guard_invoice_delivery_history',
  },
  guard_invoice_send_owner: { stan: 'kod', test: 'rls-uprawnienia.test.ts', uwaga: 'administrator ustawia ksef_send_owner na fakturze w wysyłce (42501)' },
  guard_invoice_number_series_update: { stan: 'kod', test: 'rls-numeracja.test.ts', uwaga: 'klient zmienia licznik i serię po zapisie (42501)' },
  guard_invoice_recurring_link: { stan: 'kod', test: 'rls-faktury-cykliczne.test.ts', uwaga: 'klient przepina cykl i okres na szkicu (42501)' },
  guard_invoice_sales_quote_update: { stan: 'kod', test: 'rls-proformy.test.ts', uwaga: 'właściciel zmienia powiązanie z proformą na szkicu (42501)' },
  guard_roz_advance_single_settlement: {
    stan: 'kod',
    test: 'rls-uprawnienia.test.ts',
    uwaga: 'druga faktura rozliczeniowa z tą samą zaliczką i zdublowana zaliczka (23505), serwis i klient',
  },
  guard_invoice_correction_parent: { stan: 'brak', uwaga: 'korekty tylko z przyjętym rodzicem; nikt nie zmienia rodzaju, rodzica ani podstaw prawnych przyjętej faktury' },
  guard_invoice_ksef_environment: { stan: 'brak', uwaga: 'serwis ustawia accepted ze środowiskiem (ścieżka dozwolona); brak zmiany środowiska, statusu przyjętej faktury ani accepted bez środowiska' },
  guard_accepted_ksef_invoice_line: { stan: 'brak', uwaga: 'pozycje wstawia tylko serwis w przygotowaniu; brak zapisu pozycji przyjętej faktury sesją klienta' },
  guard_historical_ksef_invoice_lines: { stan: 'brak', uwaga: 'brak zapisu pozycji faktury z historią dostawy sesją klienta' },
  guard_pending_invoice_lines: { stan: 'brak', uwaga: 'brak zapisu pozycji faktury w queued albo sending sesją klienta' },
  guard_upo_ksef_environment: { stan: 'brak', uwaga: 'UPO wstawia tylko serwis z przyjętą fakturą i środowiskiem (ścieżka dozwolona)' },
  guard_ksef_offline_queue_environment: { stan: 'brak', uwaga: 'kolejkę Offline24 zapisuje test surowym SQL jako właściciel bazy; brak odmowy' },
  guard_tenant_ksef_claim_fields: { stan: 'brak', uwaga: 'pola KSeF firmy zapisuje tylko serwis w przygotowaniu; brak zapisu klienta ani zmiany NIP przy poświadczeniach' },
  // KSeF: uprawnienia i identyfikatory zbiorcze
  guard_ksef_permission_grant: { stan: 'kod', test: 'rls-uprawnienia-ksef.test.ts', uwaga: 'serwis: skok stanu, zmiana NIP, zakresu i środowiska (23514), trzy gałęzie' },
  guard_ksef_collective_identifier: { stan: 'kod', test: 'rls-identyfikator-zbiorczy.test.ts', uwaga: 'serwis zmienia gotowy identyfikator (23514); zestaw faktur i przejścia stanów bez testu' },
  // Koszty, wpłaty, wyciągi, kasa
  guard_expense_payment_columns: { stan: 'kod', test: 'rls-koszty-do-zaplaty.test.ts', uwaga: 'klient zmienia paid_at i termin płatności kosztu (42501)' },
  guard_expense_provenance: { stan: 'brak', uwaga: 'klient edytuje tylko zwykły koszt (notes); brak zmiany źródła ani kosztu z KSeF' },
  guard_ksef_expense_provenance: { stan: 'brak', uwaga: 'brak zapisu ani usunięcia kosztu z KSeF sesją klienta' },
  guard_payment_voided: { stan: 'kod', test: 'rls-wplaty-czesciowe.test.ts', uwaga: 'serwis zmienia cofniętą wpłatę, test sprawdza tylko, że jest błąd; klucz i autor bez testu' },
  guard_payment_import_update: { stan: 'kod', test: 'rls-wyciag-koszty.test.ts', uwaga: 'serwis zmienia koszty operacji z wyciągu (42501); gałąź usuniętych danych bez testu' },
  guard_cash_document_update: { stan: 'kod', test: 'rls-kasa.test.ts', uwaga: 'zmiana wystawionego dokumentu kasowego, wzorzec /cannot be changed/ wspólny z sześcioma innymi strażnikami' },
  guard_cash_register_update: { stan: 'kod', test: 'rls-kasa.test.ts', uwaga: 'zmiana salda początkowego, wzorzec /locked/ (jedno słowo); zmiana danych kasy bez testu' },
  // Firma
  guard_tenant_first_invoice_accepted_at: { stan: 'kod', test: 'rls-lejek-analityka.test.ts', uwaga: 'właściciel ustawia i zmienia datę pierwszej faktury (42501)' },
  guard_tenant_logo_storage_key: { stan: 'kod', test: 'rls-logo-firmy.test.ts', uwaga: 'właściciel zmienia i czyści klucz logo (42501)' },
  // Abonament FaktWay (Stripe)
  guard_tenant_stripe_customer_id: { stan: 'brak', uwaga: 'stripe_customer_id ustawia serwis albo właściciel bazy (ścieżka dozwolona)' },
  guard_billing_invoice_identity: { stan: 'brak', uwaga: 'faktura abonamentu powstaje tylko przez RPC albo jako właściciel bazy (ścieżka dozwolona)' },
  guard_billing_invoice_line: { stan: 'brak', uwaga: 'brak zapisu pozycji faktury abonamentu' },
  guard_billing_invoice_financial_case: { stan: 'brak', uwaga: 'faktura abonamentu z poprawną referencją płatności (ścieżka dozwolona)' },
  guard_admin_refund_financial_case: { stan: 'brak', uwaga: 'żaden test nie dotyka stripe_refund_operations' },
  guard_stripe_payment_financial_refs: { stan: 'brak', uwaga: 'płatności Stripe tylko z poprawnymi referencjami; brak zmiany ani usunięcia' },
  guard_stripe_payment_vat_invoice_link: { stan: 'brak', uwaga: 'powiązanie z fakturą VAT robi tylko RPC (ścieżka dozwolona)' },
  enforce_stripe_payment_subscription_tenant: { stan: 'brak', uwaga: 'brak płatności z subskrypcją innej firmy' },
  enforce_stripe_subscription_customer_tenant: { stan: 'brak', uwaga: 'subskrypcje z dopasowanym klientem Stripe (ścieżka dozwolona)' },
  lock_stripe_subscription_tenant_for_checkout: { stan: 'brak', uwaga: 'brak przepięcia firmy subskrypcji ani firmy, której nie ma' },
  preserve_canceled_stripe_subscription: { stan: 'brak', uwaga: 'status subskrypcji zmienia test jako właściciel bazy (ścieżka dozwolona)' },
  preserve_stripe_payment_refund_status: { stan: 'brak', uwaga: 'brak zmiany firmy ani statusu zwróconej płatności' },
  prevent_financial_case_review_mutation: { stan: 'brak', uwaga: 'żaden test nie dotyka stripe_financial_case_reviews ani stripe_financial_case_reopenings' },
};

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

const NAZWA_TECHNICZNA = /^[A-Za-z0-9_.]+$/;

/** Nazwa testu (`it`, `test`, `describe` i ich odmiany) to opis, nie sprawdzenie. */
function jestTytulem(wezel: ts.Node): boolean {
  const rodzic = wezel.parent;
  if (!rodzic || !ts.isCallExpression(rodzic) || rodzic.arguments[0] !== wezel) return false;
  let wywolany: ts.Expression = rodzic.expression;
  while (ts.isPropertyAccessExpression(wywolany) || ts.isCallExpression(wywolany)) wywolany = wywolany.expression;
  return ts.isIdentifier(wywolany) && ['it', 'test', 'describe'].includes(wywolany.text);
}

/** Napisy i wyrażenia regularne z pliku testu, bez nazw testów. */
function literaly(plik: PlikTestu): Literal[] {
  const wynik: Literal[] = [];
  const zrodlo = ts.createSourceFile(plik.plik, plik.kod, ts.ScriptTarget.Latest, true);
  const odwiedz = (wezel: ts.Node): void => {
    if (jestTytulem(wezel)) return;
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
    ts.forEachChild(wezel, odwiedz);
  };
  odwiedz(zrodlo);
  return wynik;
}

/** Literał z testu sprawdza ten tekst strażnika. */
function pasuje(literal: Literal, tekst: string): boolean {
  const czesci = tekst.split('%').filter((c) => c.trim().length >= 12 && !NAZWA_TECHNICZNA.test(c.trim()));
  if ('napis' in literal) {
    const n = literal.napis;
    if (n === tekst) return true;
    if (n.length < 8 || NAZWA_TECHNICZNA.test(n)) return false;
    return tekst.replace(/%/g, '\u0000').includes(n) || czesci.some((c) => n.includes(c.trim()));
  }
  const w = literal.wzorzec;
  if (NAZWA_TECHNICZNA.test(w.source)) return new RegExp(`^(?:${w.source})$`, w.flags).test(tekst);
  if (w.source.length < 6) return false;
  const bezEskejpow = w.source.replace(/\\(.)/g, '$1');
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
    if (wy.length === 0 && !cichoBlokuje(funkcja.cialo, w.kiedy)) continue;
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

  it.fails('każdy strażnik ma na bazie test zabronionego zapisu (FZ-024)', () => {
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
      if (!f || wyjatki(f.cialo).length > 0 || cichoBlokuje(f.cialo, w.kiedy)) continue;
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
      if (!wpis.test) continue;
      const plik = PLIKI_TESTOW.find((p) => p.plik === wpis.test);
      if (!plik) bledy.push(`${nazwa}: nie ma tests/${wpis.test}`);
      else if (![...tabele].some((t) => plik.kod.includes(`'${t}'`))) bledy.push(`${nazwa}: ${wpis.test} nie wymienia tabeli ${[...tabele].join(', ')}`);
    }
    for (const nazwa of Object.keys(SKUTKI)) if (!funkcje.has(nazwa)) bledy.push(`${nazwa}: nie ma takiej funkcji wyzwalacza bez wyjątku, usuń wpis ze SKUTKI`);
    expect(bledy).toEqual([]);
    expect(existsSync(join(TESTY, 'rls-spis-wyzwalaczy.test.ts'))).toBe(true);
  });
});
