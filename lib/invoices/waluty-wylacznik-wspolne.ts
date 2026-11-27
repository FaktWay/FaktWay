/**
 * Wyłącznik faktury w walucie obcej (plan kompletnej aplikacji, krok 2.1, część 3;
 * decyzja D56): części wspólne dla serwera i przeglądarki, bez bazy i Next.
 * Stan wyłącznika czyta tylko serwer (`lib/invoices/waluty-wylacznik.ts`).
 */

import type { GlobalFlag } from '@/lib/feature-flags/types';

export const FLAGA_WALUT = 'foreignCurrencyEnabled' as const satisfies GlobalFlag;

export type EtapOdmowyWaluty = 'zapis' | 'wysylka';

/**
 * Kod waluty faktury z wartości formularza (`currency`) albo zbudowanej faktury
 * (`payment.currency`); brak, pusty albo „PLN” to złote. Inna wartość to waluta obca.
 */
export function walutaDokumentu(dokument: unknown): string {
  if (typeof dokument !== 'object' || dokument === null) return 'PLN';
  const d = dokument as { currency?: unknown; payment?: { currency?: unknown } | null };
  const kod = typeof d.currency === 'string' && d.currency.trim() !== '' ? d.currency : d.payment?.currency;
  return typeof kod === 'string' && kod.trim() !== '' ? kod.trim().toUpperCase() : 'PLN';
}

export function czyFakturaWWalucie(dokument: unknown): boolean {
  return walutaDokumentu(dokument) !== 'PLN';
}

const CO_SIE_STALO: Record<EtapOdmowyWaluty, string> = {
  zapis: 'więc faktury nie zapisaliśmy',
  wysylka: 'więc tego szkicu nie wysłaliśmy do KSeF',
};

const WYJSCIE: Record<EtapOdmowyWaluty, string> = {
  zapis: 'Wystaw fakturę w złotych.',
  wysylka: 'Wystaw fakturę od nowa w złotych, a szkic usuń.',
};

/** Tekst odmowy dla klienta: nazwa dokumentu, co się stało i wyjście (protokół napraw, pkt 4). */
export function tekstOdmowyWaluty(etap: EtapOdmowyWaluty, powod: 'wylaczone' | 'nieznany'): string {
  return powod === 'nieznany'
    ? `Nie udało się sprawdzić, czy faktura w walucie obcej jest dostępna w FaktWay, ${CO_SIE_STALO[etap]}. Spróbuj ponownie za chwilę.`
    : `Faktura w walucie obcej nie jest jeszcze dostępna w FaktWay, ${CO_SIE_STALO[etap]}. ${WYJSCIE[etap]}`;
}
