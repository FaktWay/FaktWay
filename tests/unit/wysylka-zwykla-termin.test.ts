import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { operatorRequeueButton } from '@/lib/admin/ksef-operator-policy';
import { buildKsefRequeueEvent, ksefResendFacts, type KsefRequeueSourceRow } from '@/lib/invoices/ksef-requeue-event';
import {
  automaticResendExpected,
  decideResend,
  failedInvoiceButtons,
  resetDoneMessage,
} from '@/lib/invoices/ksef-send-policy';
import { SEND_ERROR_CODES } from '@/lib/ksef/send-error-classes';
import {
  regularIssueDateSendable,
  regularSendableIssueDateFrom,
  regularSendDeadlineDay,
} from '@/lib/ksef/special-issue-date';

/**
 * B2a (plan „zero zgubionych faktur”, założenie robocze B1(a)): zwykła
 * faktura, która nie wyszła w dniu wystawienia (P_1), może wyjść bez zmian do
 * końca następnego dnia roboczego w czasie polskim (art. 106nda ust. 2; sobota
 * i święta nie są dniami roboczymi). Potem `ISSUE_DATE_PASSED`: bez ponowienia
 * klienta, operatora i automatu, wyjściem jest szkic i nowa faktura. KSeF sam
 * terminu nie pilnuje (scenariusz 13b), więc pilnuje go aplikacja — wszędzie
 * tak samo: fakty ponowienia (cron, operator, klient), przyciski i teksty.
 *
 * Bez atrap: moduły czyste, czas podany jawnie (`now`).
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';

function regularRow(issueDate: string): KsefRequeueSourceRow {
  return {
    id: ID,
    tenant_id: TENANT,
    tenants: { nip: '5260001246' },
    invoice_kind: 'regular',
    issue_date: issueDate,
    special_data: null,
    fa3_data: { type: 'VAT', internalNumber: 'FV/1', issueDate, lines: [{ ordinal: 1 }], seller: { nip: '5260001246' } },
  };
}

/** Chwila sprawdzenia: [opis, znacznik czasu ISO]. */
type Moment = readonly [label: string, at: string];

interface DeadlineCase {
  name: string;
  issueDate: string;
  allowed: readonly Moment[];
  refused: readonly Moment[];
}

/** Listopad 2026 to czas zimowy (UTC+1): 23:59:59.999 w Polsce = 22:59:59.999Z. */
const CASES: readonly DeadlineCase[] = [
  {
    name: 'P_1 w piątek 13.11.2026',
    issueDate: '2026-11-13',
    allowed: [
      ['sobota 14.11, południe', '2026-11-14T11:00:00.000Z'],
      ['poniedziałek 16.11, ostatnia chwila dnia', '2026-11-16T22:59:59.999Z'],
    ],
    refused: [
      ['wtorek 17.11, pierwsza chwila dnia', '2026-11-16T23:00:00.000Z'],
      ['wtorek 17.11, południe', '2026-11-17T11:00:00.000Z'],
    ],
  },
  {
    name: 'P_1 we wtorek 10.11.2026, w środę święto (11 listopada)',
    issueDate: '2026-11-10',
    allowed: [
      ['środa 11.11 (święto), południe', '2026-11-11T11:00:00.000Z'],
      ['czwartek 12.11, ostatnia chwila dnia', '2026-11-12T22:59:59.999Z'],
    ],
    refused: [['piątek 13.11, pierwsza chwila dnia', '2026-11-12T23:00:00.000Z']],
  },
];

function input(issueDate: string, now: Date, errorCode: string = SEND_ERROR_CODES.INFRA) {
  return {
    direction: 'outgoing',
    status: 'failed',
    errorCode,
    invoiceKind: 'regular',
    facts: ksefResendFacts(regularRow(issueDate), 'test', now),
    environmentKnown: true,
  };
}

/** Klient widzi, dlaczego (termin minął) i co zrobić (szkic, usunięcie, nowa faktura z dzisiejszą datą). */
const WHY = /termin/i;
const RULE = /następn\w* dni\w* robocz/;
const WHAT = /usuń go i wystaw fakturę od nowa z dzisiejszą datą/;

describe.each(CASES)('B2a: zwykła faktura failed INFRA, $name', ({ issueDate, allowed, refused }) => {
  it.each(allowed)('%s → ponowienie przechodzi wszędzie (fakty, zdarzenie, klient, automat, operator)', (_label, at) => {
    const now = new Date(at);
    const facts = ksefResendFacts(regularRow(issueDate), 'test', now);
    expect(facts).toEqual({ sendData: 'stored', kindHeld: false, issueDatePassed: false });
    expect(buildKsefRequeueEvent(regularRow(issueDate), 'test', ATTEMPT, { reconcileOnly: false, now })).toMatchObject({ ok: true });
    expect(decideResend(input(issueDate, now))).toEqual({ allowed: true, errorClass: 'transient' });
    expect(automaticResendExpected(input(issueDate, now))).toBe(true);
    expect(operatorRequeueButton(input(issueDate, now))).toEqual({ enabled: true, reason: null });
    const buttons = failedInvoiceButtons({ ...input(issueDate, now), canManage: true });
    expect(buttons).toMatchObject({ resend: true, reset: true });
    // Obietnica automatu ma granicę: termin przesłania, nie „kiedyś”.
    expect(buttons?.info).toMatch(RULE);
  });

  it.each(refused)('%s → po terminie: odmowa wszędzie, klient widzi dlaczego i co zrobić', (_label, at) => {
    const now = new Date(at);
    expect(ksefResendFacts(regularRow(issueDate), 'test', now).issueDatePassed).toBe(true);
    // Cron I6/I7, operator i od A4b PR2b klient: zdarzenia z kopii po terminie nie ma.
    expect(buildKsefRequeueEvent(regularRow(issueDate), 'test', ATTEMPT, { reconcileOnly: false, now }))
      .toEqual({ ok: false, reason: 'issue-date' });
    // „Tylko uzgodnij” nie wysyła — data nie ma znaczenia.
    expect(buildKsefRequeueEvent(regularRow(issueDate), 'test', ATTEMPT, { reconcileOnly: true, now })).toMatchObject({ ok: true });

    const decision = decideResend(input(issueDate, now));
    expect(decision).toMatchObject({ allowed: false, reason: 'issue-date' });
    const message = (decision as { message: string }).message;
    expect(message).toMatch(WHY);
    expect(message).toMatch(RULE);
    expect(message).toMatch(WHAT);
    expect(automaticResendExpected(input(issueDate, now))).toBe(false);

    const buttons = failedInvoiceButtons({ ...input(issueDate, now), canManage: true });
    expect(buttons).toMatchObject({ resend: false, reset: true, info: message });

    const operator = operatorRequeueButton(input(issueDate, now));
    expect(operator.enabled).toBe(false);
    expect(operator.reason).toMatch(/ISSUE_DATE_PASSED/);
    expect(operator.reason).toMatch(RULE);
  });
});

describe('B2a: teksty dla zwykłej faktury po odmowie workera (kod ISSUE_DATE_PASSED)', () => {
  const now = new Date('2026-11-17T11:00:00.000Z');

  it('„Wyślij ponownie” zablokowane, tekst mówi o terminie zwykłej faktury, nie o dniu wysyłki dokumentu specjalnego', () => {
    const decision = decideResend(input('2026-11-13', now, SEND_ERROR_CODES.ISSUE_DATE_PASSED));
    expect(decision).toMatchObject({ allowed: false, reason: 'terminal' });
    const message = (decision as { message: string }).message;
    expect(message).toMatch(RULE);
    expect(message).toMatch(WHAT);
    expect(message).not.toMatch(/w dniu wysyłki/);
  });

  it('toast po „Wróć do szkicu” po terminie: usuń szkic i wystaw od nowa, bez „popraw i wyślij ponownie”', () => {
    const facts = ksefResendFacts(regularRow('2026-11-13'), 'test', now);
    const toast = resetDoneMessage('regular', facts, SEND_ERROR_CODES.INFRA);
    expect(toast).toMatch(/usuń/i);
    expect(toast).toMatch(/od nowa z dzisiejszą datą/);
    expect(toast).not.toMatch(/Popraw/);
  });
});

/**
 * Niezmiennik terminu (R1): wzorzec liczony w teście niezależnie od
 * `lib/ksef/idempotency.ts` — dni wolne od pracy 2026–2027 wypisane ręcznie
 * (ustawa z 18.01.1951 o dniach wolnych od pracy, art. 1; Wigilia od 2025),
 * dzień w Polsce z `Intl`. Sprawdza regułę dla każdej daty dwóch lat i filtr
 * kandydatów crona (`regularSendableIssueDateFrom`) dla losowych chwil.
 */
describe('B2a: niezmiennik terminu przesłania zwykłej faktury', () => {
  const HOLIDAYS = new Set([
    '2026-01-01', '2026-01-06', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-03', '2026-05-24', '2026-06-04',
    '2026-08-15', '2026-11-01', '2026-11-11', '2026-12-24', '2026-12-25', '2026-12-26',
    '2027-01-01', '2027-01-06', '2027-03-28', '2027-03-29', '2027-05-01', '2027-05-03', '2027-05-16', '2027-05-27',
    '2027-08-15', '2027-11-01', '2027-11-11', '2027-12-24', '2027-12-25', '2027-12-26',
  ]);
  const DAY_MS = 86_400_000;
  const FIRST = Date.parse('2026-01-01T00:00:00Z');
  const LAST = Date.parse('2027-12-20T00:00:00Z');
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const businessDay = (iso: string) => {
    const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(iso);
  };
  const nextBusinessDay = (iso: string) => {
    let ms = Date.parse(`${iso}T00:00:00Z`) + DAY_MS;
    while (!businessDay(isoDay(ms))) ms += DAY_MS;
    return isoDay(ms);
  };
  const warsawDay = (at: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  /** 23:59:59.999 czasu polskiego jako chwila UTC (zima UTC+1, lato UTC+2). */
  const endOfWarsawDayMs = (iso: string) => {
    const winter = Date.parse(`${iso}T22:59:59.999Z`);
    return warsawDay(new Date(winter)) === iso ? winter : Date.parse(`${iso}T21:59:59.999Z`);
  };

  it('każda data 2026–2027: termin to następny dzień roboczy, wysyłka do 23:59:59.999 czasu polskiego, milisekundę później nie', () => {
    let checked = 0;
    for (let ms = FIRST; ms <= LAST; ms += DAY_MS) {
      const issueDate = isoDay(ms);
      const deadline = nextBusinessDay(issueDate);
      const end = endOfWarsawDayMs(deadline);
      expect(regularSendDeadlineDay(issueDate)).toBe(deadline);
      expect(regularIssueDateSendable(issueDate, new Date(end))).toBe(true);
      expect(regularIssueDateSendable(issueDate, new Date(end + 1))).toBe(false);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(700);
  });

  it('losowe chwile: reguła = wzorzec, a filtr crona (data od ostatniego dnia roboczego przed dziś) = reguła', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: (LAST - FIRST) / DAY_MS }),
        // Chwila od dwóch dni przed datą wystawienia do sześciu po niej — wokół terminu (weekend, święta, zmiana czasu).
        fc.integer({ min: -2 * DAY_MS, max: 6 * DAY_MS }),
        (dayIndex, offset) => {
          const issueDate = isoDay(FIRST + dayIndex * DAY_MS);
          const now = new Date(FIRST + dayIndex * DAY_MS + offset);
          const sendable = regularIssueDateSendable(issueDate, now);
          expect(sendable).toBe(warsawDay(now) <= nextBusinessDay(issueDate));
          expect(sendable).toBe(issueDate >= regularSendableIssueDateFrom(now));
        },
      ),
      { numRuns: 3000 },
    );
  });

  it.each([
    ['dzień spoza kalendarza', '2026-02-30'],
    ['data z godziną', '2026-11-13T10:00:00'],
    ['pusty napis', ''],
    ['brak', null],
    ['liczba', 20261113],
  ])('nieczytelna data wystawienia (%s) → bez terminu, bez wysyłki', (_label, issueDate) => {
    const now = new Date('2026-11-14T11:00:00.000Z');
    expect(regularSendDeadlineDay(issueDate)).toBeNull();
    expect(regularIssueDateSendable(issueDate, now)).toBe(false);
  });
});
