/**
 * Plan usunięcia paczki faktur po terminie przechowywania (FZ-005,
 * `cron.retention-delete`). Pliki faktury usuwa się tylko wtedy, gdy baza da
 * usunąć także jej wiersz, więc plan rozstrzyga przed usunięciem plików.
 * Wiersz trzymają:
 *
 * - korekta: `invoices.parent_invoice_id ... ON DELETE RESTRICT` (00012,
 *   00118); oryginał czeka, dopóki któraś jego korekta zostaje, a gdy korekta
 *   też jest po terminie, idzie przed oryginałem (także łańcuch korekt);
 * - koszt z KSeF: `expenses.ksef_invoice_id` bez `ON DELETE` (00034, 00121);
 * - import płatności z banku: `payment_imports.matched_payment_id` bez
 *   `ON DELETE` (00014, 00073) przy płatności, którą faktura kasuje kaskadą;
 * - strażnik cyklu KSeF (`guard_ksef_lifecycle`, 00119, 00132): wiersza nie
 *   usunie żadna rola, także klucz serwisowy, gdy faktura była wysłana do KSeF
 *   (`submitted_to_ksef_at`), ma klucz trybu offline albo jest w trakcie
 *   wysyłki (`blokadaKsef`); FZ-016.
 *
 * Czekająca faktura dostaje nowy termin: najpóźniejszy termin korekty (także
 * nowy termin korekty, która sama czeka), ale nie bliżej niż za 30 dni, żeby
 * nie zajmowała paczki co noc. Funkcja czysta, bez bazy.
 */

/** Ile dni czeka faktura, której nie da się jeszcze usunąć (najmniej). */
export const DNI_ODROCZENIA = 30;

export type PowodOdroczenia = 'korekta' | 'koszt' | 'platnosc' | 'ksef';

export interface KorektaTrzymajaca {
  id: string;
  parent_invoice_id: string;
  scheduled_deletion_at: string | null;
}

export interface Odroczenie {
  id: string;
  /** Nowy `scheduled_deletion_at` (ISO). */
  termin: string;
  powod: PowodOdroczenia;
}

export interface PlanUsuniecia {
  /** Do usunięcia teraz, w tej kolejności: korekta przed fakturą, którą koryguje. */
  kolejnosc: string[];
  /** Zostają (pliki i wiersz) z nowym terminem. */
  odroczone: Odroczenie[];
}

/** Statusy, w których strażnik cyklu KSeF (00132) nie da usunąć faktury. */
const W_WYSYLCE = new Set(['queued', 'offline_queued', 'sending']);

/** Ten sam warunek co gałąź DELETE w `guard_ksef_lifecycle` (00132): wiersza nie usunie żadna rola. */
export function blokadaKsef(f: { ksef_status?: unknown; submitted_to_ksef_at?: unknown; offline_idempotency_key?: unknown }): boolean {
  return W_WYSYLCE.has(String(f.ksef_status)) || f.submitted_to_ksef_at != null || f.offline_idempotency_key != null;
}

export function planUsuniecia(w: {
  kandydaci: readonly string[];
  /** Korekty, których `parent_invoice_id` to któryś z kandydatów (także same kandydatki). */
  korekty: readonly KorektaTrzymajaca[];
  /** Kandydaci trzymani czym innym niż korekta. */
  blokady: ReadonlyArray<{ id: string; powod: Exclude<PowodOdroczenia, 'korekta'> }>;
  teraz: Date;
}): PlanUsuniecia {
  const kandydaci = new Set(w.kandydaci);
  const dzieci = new Map<string, KorektaTrzymajaca[]>();
  for (const k of w.korekty) dzieci.set(k.parent_invoice_id, [...(dzieci.get(k.parent_invoice_id) ?? []), k]);

  const powod = new Map<string, PowodOdroczenia>();
  for (const b of w.blokady) if (kandydaci.has(b.id) && !powod.has(b.id)) powod.set(b.id, b.powod);
  // Oryginał czeka, gdy któraś korekta nie jest kandydatem albo sama czeka (do skutku).
  for (let zmiana = true; zmiana; ) {
    zmiana = false;
    for (const id of kandydaci) {
      if (powod.has(id)) continue;
      if ((dzieci.get(id) ?? []).some((k) => !kandydaci.has(k.id) || powod.has(k.id))) {
        powod.set(id, 'korekta');
        zmiana = true;
      }
    }
  }

  // Kolejność: faktura dopiero wtedy, gdy wszystkie jej korekty są już na liście.
  const kolejnosc: string[] = [];
  const zostaje = new Set([...kandydaci].filter((id) => !powod.has(id)));
  for (let postep = true; zostaje.size > 0 && postep; ) {
    postep = false;
    for (const id of [...zostaje]) {
      if ((dzieci.get(id) ?? []).every((k) => !zostaje.has(k.id))) {
        kolejnosc.push(id);
        zostaje.delete(id);
        postep = true;
      }
    }
  }
  // Pętla w `parent_invoice_id` (dane niespójne): nic z niej nie usuwamy.
  for (const id of zostaje) powod.set(id, 'korekta');

  // Terminy: najpierw 30 dni dla wszystkich, potem w górę do terminów korekt
  // (nowych, gdy korekta też czeka), aż się ustalą (pętla danych: najwyżej tyle przejść, ile faktur).
  const najblizej = w.teraz.getTime() + DNI_ODROCZENIA * 86_400_000;
  const termin = new Map([...powod.keys()].map((id) => [id, najblizej]));
  for (let przejscie = 0, zmiana = true; zmiana && przejscie <= powod.size; przejscie++) {
    zmiana = false;
    for (const [id, p] of powod) {
      if (p !== 'korekta') continue;
      const terminyKorekt = (dzieci.get(id) ?? []).map((k) => termin.get(k.id) ?? (k.scheduled_deletion_at ? Date.parse(k.scheduled_deletion_at) : NaN));
      const nowy = Math.max(najblizej, ...terminyKorekt.filter(Number.isFinite));
      if (nowy > termin.get(id)!) {
        termin.set(id, nowy);
        zmiana = true;
      }
    }
  }
  const odroczone = [...powod].map(([id, p]): Odroczenie => ({ id, termin: new Date(termin.get(id)!).toISOString(), powod: p }));
  return { kolejnosc, odroczone };
}
