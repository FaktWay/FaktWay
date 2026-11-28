'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { dodajFakturaSpozaKsefAction } from '@/app/actions/faktury-spoza-ksef';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  bruttoPozycji,
  PUSTA_POZYCJA,
  sprawdzFormularz,
  vatPozycji,
  type FormularzSpozaKsef,
  type PozycjaFormularza,
} from '@/lib/import/outside-ksef-formularz';
import { PDF_SPOZA_KSEF_LIMIT_LABEL, PDF_SPOZA_KSEF_ZAPIS_PLIKU } from '@/lib/import/outside-ksef-pdf';
import { OUTSIDE_KSEF_ISSUE_DATE_MAX, OUTSIDE_KSEF_ISSUE_DATE_MIN, OUTSIDE_KSEF_VAT_RATES } from '@/lib/import/outside-ksef-schema';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import { postSpozaKsefOdczyt, postSpozaKsefOryginal } from '@/lib/uploads/client';

/** Rodzaje, których FaktWay nie ujmie w księgach (D22): wybór kończy się odmową z wyjściem, bez zapisu. */
const RODZAJE: Array<{ value: string; label: string }> = [
  { value: 'faktura_vat', label: 'Faktura VAT w złotych' },
  { value: 'faktura_do_paragonu', label: 'Faktura do paragonu' },
  { value: 'korekta', label: 'Faktura korygująca' },
  { value: 'zaliczka', label: 'Faktura zaliczkowa' },
  { value: 'rozliczenie', label: 'Faktura rozliczająca zaliczkę' },
  { value: 'waluta', label: 'Faktura w walucie obcej' },
  { value: 'procedura_marzy', label: 'Procedura marży' },
  { value: 'oo', label: 'Odwrotne obciążenie' },
  { value: 'metoda_kasowa', label: 'Metoda kasowa' },
  { value: 'samofakturowanie', label: 'Samofakturowanie' },
];

const POLE =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm shadow-xs focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none';

const STAWKA_ETYKIETA: Record<string, string> = { '0': '0%', zw: 'zw', np: 'np' };

const zl = (v: number | null) => (v === null ? 'brak' : v.toFixed(2).replace('.', ',') + ' zł');

/**
 * Formularz wpisu faktury wystawionej poza KSeF (krok 1.6, PR C; D22-D24).
 * Walidacja tym samym schematem co akcja serwera (`sprawdzFormularz`); zapis
 * robi `dodajFakturaSpozaKsefAction` (wyłącznik, rola i audyt po stronie serwera).
 */
export function OutsideKsefForm({ opis }: { opis: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rodzaj, setRodzaj] = useState('faktura_vat');
  const [blad, setBlad] = useState<string | null>(null);
  /** PDF wskazany przez klienta: czytany do formularza (D25 a) i zapisywany przy fakturze po jej dodaniu (D25 b, D40). */
  const [plik, setPlik] = useState<File | null>(null);
  const [odczytuje, setOdczytuje] = useState(false);
  const [ostrzezenia, setOstrzezenia] = useState<string[]>([]);
  const [f, setF] = useState<FormularzSpozaKsef>({
    number: '',
    issueDate: '',
    saleDate: '',
    buyerName: '',
    buyerNip: '',
    lines: [{ ...PUSTA_POZYCJA }],
  });

  const ustaw = <K extends keyof FormularzSpozaKsef>(k: K, v: FormularzSpozaKsef[K]) => setF((p) => ({ ...p, [k]: v }));
  const ustawPozycje = (i: number, zmiana: Partial<PozycjaFormularza>) =>
    setF((p) => ({ ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, ...zmiana } : l)) }));

  async function wybierzPlik(nowy: File | null) {
    setPlik(nowy);
    setOstrzezenia([]);
    setBlad(null);
    if (!nowy) return;
    setOdczytuje(true);
    const wynik = await postSpozaKsefOdczyt(nowy);
    setOdczytuje(false);
    if (!wynik.success) {
      // Odczyt nie wyszedł: plik nadal zostanie zapisany przy fakturze, a dane klient wpisuje ręcznie.
      setBlad(wynik.error);
      return;
    }
    const w = wynik.wypelnienie;
    setRodzaj(w.rodzaj);
    setF({ ...w.pola, lines: w.pola.lines.length > 0 ? w.pola.lines : [{ ...PUSTA_POZYCJA }] });
    setOstrzezenia(w.ostrzezenia);
    if (w.odmowa) setBlad(w.odmowa);
  }

  function zapisz(e: React.FormEvent) {
    e.preventDefault();
    setBlad(null);
    const sprawdzenie = sprawdzFormularz(f);
    // Odmowa rodzaju (D22) pada w akcji serwera, więc przy rodzaju innym niż zwykła faktura
    // idzie tam nawet z niepełnymi danymi: klient dostaje wyjaśnienie, nie błąd pola.
    if (!sprawdzenie.ok && rodzaj === 'faktura_vat') {
      setBlad(sprawdzenie.blad);
      return;
    }
    startTransition(async () => {
      const wynik = await dodajFakturaSpozaKsefAction(sprawdzenie.ok ? sprawdzenie.wpis : {}, rodzaj);
      if (wynik.success) {
        toast.success('Faktura dodana do historii FaktWay.');
        if (plik) {
          const zapisPliku = await postSpozaKsefOryginal(wynik.id, plik);
          if (!zapisPliku.success) toast.error(zapisPliku.error);
        }
        router.push(`/invoices/${wynik.id}`);
        router.refresh();
        return;
      }
      setBlad(wynik.error);
    });
  }

  return (
    <form onSubmit={zapisz} className="mx-auto w-full max-w-3xl space-y-6 p-4" noValidate>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Dodaj fakturę wystawioną poza KSeF</h1>
        <p className="text-muted-foreground text-sm">{opis}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sk-pdf">Wczytaj dane z PDF faktury (opcjonalnie)</Label>
        <input
          id="sk-pdf"
          type="file"
          accept="application/pdf,.pdf"
          disabled={odczytuje || pending}
          className="text-sm"
          onChange={(e) => void wybierzPlik(e.target.files?.[0] ?? null)}
        />
        <p className="text-muted-foreground text-xs">
          {PDF_SPOZA_KSEF_ZAPIS_PLIKU} Plik do {PDF_SPOZA_KSEF_LIMIT_LABEL}.
        </p>
        {odczytuje ? <p className="text-sm">Odczytuję PDF…</p> : null}
        {ostrzezenia.length > 0 ? (
          <Alert role="status">
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {ostrzezenia.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="sk-rodzaj">Rodzaj dokumentu</Label>
        <select id="sk-rodzaj" className={POLE} value={rodzaj} onChange={(e) => setRodzaj(e.target.value)}>
          {RODZAJE.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="sk-numer">Numer faktury</Label>
          <Input id="sk-numer" value={f.number} onChange={(e) => ustaw('number', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sk-data">Data wystawienia</Label>
          <Input
            id="sk-data"
            type="date"
            min={OUTSIDE_KSEF_ISSUE_DATE_MIN}
            max={OUTSIDE_KSEF_ISSUE_DATE_MAX}
            value={f.issueDate}
            onChange={(e) => ustaw('issueDate', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sk-sprzedaz">Data sprzedaży (jeśli inna)</Label>
          <Input id="sk-sprzedaz" type="date" value={f.saleDate} onChange={(e) => ustaw('saleDate', e.target.value)} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <Label htmlFor="sk-nabywca">Nabywca</Label>
          <Input id="sk-nabywca" value={f.buyerName} onChange={(e) => ustaw('buyerName', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sk-nip">NIP nabywcy (puste dla osoby prywatnej)</Label>
          <Input id="sk-nip" inputMode="numeric" value={f.buyerNip} onChange={(e) => ustaw('buyerNip', e.target.value)} />
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-base font-medium">Pozycje (kwoty w złotych)</h2>
        {f.lines.map((l, i) => (
          <fieldset key={i} className="space-y-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Pozycja {i + 1}</legend>
            <div className="space-y-2">
              <Label htmlFor={`sk-nazwa-${i}`}>Nazwa</Label>
              <Input id={`sk-nazwa-${i}`} value={l.name} onChange={(e) => ustawPozycje(i, { name: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor={`sk-netto-${i}`}>Netto</Label>
                <Input id={`sk-netto-${i}`} inputMode="decimal" value={l.net} onChange={(e) => ustawPozycje(i, { net: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`sk-stawka-${i}`}>Stawka VAT</Label>
                <select id={`sk-stawka-${i}`} className={POLE} value={l.vatRate} onChange={(e) => ustawPozycje(i, { vatRate: e.target.value })}>
                  {OUTSIDE_KSEF_VAT_RATES.map((s) => (
                    <option key={s} value={s}>
                      {STAWKA_ETYKIETA[s] ?? `${s}%`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`sk-vat-${i}`}>Kwota VAT</Label>
                <Input
                  id={`sk-vat-${i}`}
                  inputMode="decimal"
                  placeholder={zl(vatPozycji({ ...l, vat: '' }))}
                  value={l.vat}
                  onChange={(e) => ustawPozycje(i, { vat: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Brutto</p>
                <p className="flex h-9 items-center text-sm tabular-nums">{zl(bruttoPozycji(l))}</p>
              </div>
            </div>
            {l.vatRate === 'zw' ? (
              <div className="space-y-2">
                <Label htmlFor={`sk-zw-${i}`}>Podstawa zwolnienia z VAT</Label>
                <Input id={`sk-zw-${i}`} value={l.exemptionBasis} onChange={(e) => ustawPozycje(i, { exemptionBasis: e.target.value })} />
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Label htmlFor={`sk-gtu-${i}`}>Oznaczenie GTU (opcjonalnie)</Label>
                <select id={`sk-gtu-${i}`} className={POLE} value={l.gtuCode} onChange={(e) => ustawPozycje(i, { gtuCode: e.target.value })}>
                  <option value="">brak</option>
                  {GTU_CODES.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" checked={l.tp} onChange={(e) => ustawPozycje(i, { tp: e.target.checked })} />
                Oznaczenie TP (podmioty powiązane)
              </label>
              {f.lines.length > 1 ? (
                <Button type="button" variant="ghost" onClick={() => setF((p) => ({ ...p, lines: p.lines.filter((_, j) => j !== i) }))}>
                  Usuń pozycję
                </Button>
              ) : null}
            </div>
          </fieldset>
        ))}
        <Button type="button" variant="outline" onClick={() => setF((p) => ({ ...p, lines: [...p.lines, { ...PUSTA_POZYCJA }] }))}>
          Dodaj pozycję
        </Button>
      </div>

      {blad ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{blad}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || odczytuje}>
          Dodaj do historii
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => router.push('/invoices')}>
          Anuluj
        </Button>
      </div>
    </form>
  );
}
