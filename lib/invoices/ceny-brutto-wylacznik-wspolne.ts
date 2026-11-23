/**
 * Wyłącznik faktury w cenach brutto (RP-FA-BRUTTO-01): części wspólne dla
 * serwera i przeglądarki, bez bazy, Next i Sentry. Formularz i schemat
 * formularza cen brutto (PR (b)) wczytuje też przeglądarka, więc biorą stałe
 * i `czyFakturaWCenachBrutto` stąd; stan wyłącznika czyta tylko serwer
 * (`lib/invoices/ceny-brutto-wylacznik.ts`, opis miejsc odmowy tamże)
 * i podaje go formularzowi.
 */

import type { GlobalFlag } from '@/lib/feature-flags/types';

export const FLAGA_CEN_BRUTTO = 'grossPricesEnabled' as const satisfies GlobalFlag;

/** Odmowa w jobie wysyłki (klient widzi ją po „Faktura nie trafiła do KSeF.”, z powrotem do szkicu). */
export const CENY_BRUTTO_WYLACZONE =
  'Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay. Wystaw fakturę od nowa w cenach netto.';

/** Podkład z dokumentu w cenach brutto przy wyłączonym wyłączniku: pozycje bez ceny netto w dokumencie wracają z pustą ceną. */
export const CENY_BRUTTO_PODKLAD =
  'Faktura, z której wypełniliśmy formularz, ma ceny brutto, a faktury w cenach brutto FaktWay jeszcze nie wystawia. Ceny tych pozycji zostawiliśmy puste: wpisz je w cenach netto.';

/** Podkład z dokumentu z pozycją bez ceny netto i bez ceny brutto (np. import bez `P_9A` i `P_9B`): też pusta cena, nigdy 0 zł. */
export const PODKLAD_BEZ_CENY_NETTO =
  'Faktura, z której wypełniliśmy formularz, ma pozycje bez ceny netto. Ceny tych pozycji zostawiliśmy puste: wpisz je w cenach netto.';

/** Gdzie pada odmowa; od tego zależy, co się stało z fakturą. */
export type EtapOdmowyCenBrutto = 'zapis' | 'wysylka' | 'ponowienie';

export interface OdmowaCenBrutto {
  /** `wylaczone`: wyłącznik zdjęty; `nieznany`: nie udało się go odczytać. */
  powod: 'wylaczone' | 'nieznany';
  tekst: string;
}

const CO_SIE_STALO: Record<EtapOdmowyCenBrutto, string> = {
  zapis: 'więc faktury nie zapisaliśmy',
  wysylka: 'więc tego szkicu nie wysłaliśmy do KSeF',
  ponowienie: 'więc tej wysyłki nie wykonaliśmy i faktura zostaje z błędem wysyłki',
};

/**
 * „Wyślij ponownie” dotyczy faktury z błędem wysyłki, której plik mógł już dotrzeć
 * do KSeF (np. przerwa po wysłaniu). Odmowa w kolejce pada przed jobem, więc nic
 * jej nie uzgadnia; faktura wystawiona od nowa mogłaby być drugą fakturą w KSeF.
 * Wyjście: pomoc FaktWay, operator najpierw uzgadnia (runbook
 * `docs/runbooks/ceny-brutto-wylacznik.md`, „Jak wyłączyć”).
 */
const WYJSCIE: Record<EtapOdmowyCenBrutto, string> = {
  zapis: 'Wystaw fakturę w cenach netto.',
  wysylka: 'Wystaw fakturę od nowa w cenach netto, a szkic usuń.',
  ponowienie:
    'Nie wystawiaj jej od nowa, zanim sprawdzimy, czy KSeF jej nie przyjął: napisz do nas, a sprawdzimy to i powiemy, co dalej.',
};

/** Tekst odmowy dla klienta: nazwa dokumentu, co się stało i wyjście (protokół napraw, pkt 4). */
export function tekstOdmowyCenBrutto(etap: EtapOdmowyCenBrutto, powod: OdmowaCenBrutto['powod']): string {
  return powod === 'nieznany'
    ? `Nie udało się sprawdzić, czy faktura w cenach brutto jest dostępna w FaktWay, ${CO_SIE_STALO[etap]}. Spróbuj ponownie za chwilę.`
    : `Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay, ${CO_SIE_STALO[etap]}. ${WYJSCIE[etap]}`;
}

/**
 * Czy dokument (faktura, wartości formularza, `fa3_data`) jest w cenach
 * brutto. Tylko `pricesGross === true`, tak jak czytają go generator FA(3)
 * i bramka wysyłki (`validateInvoice`): napis albo liczba to faktura w cenach
 * netto i taki plik powstanie.
 */
export function czyFakturaWCenachBrutto(dokument: unknown): boolean {
  return typeof dokument === 'object' && dokument !== null && (dokument as { pricesGross?: unknown }).pricesGross === true;
}
