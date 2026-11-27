'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { decideKsefCopyAction } from '@/app/actions/kopia-faktury-ksef';
import { plDate } from '@/components/expenses/finora/labels';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { KsefCopyDoc, KsefCopyView } from '@/lib/expenses/kopia-faktury-ksef-view';
import { monthLabel } from '@/lib/expenses/month';
import { formatPlMoney } from '@/lib/format/pl';

/**
 * FZ-022, decyzja D29 (00215, 00217): kopia faktury z KSeF na stronie kosztu.
 * Przy koszcie z KSeF zadanie „Połącz koszty” (wybór kopii albo „To osobne
 * dokumenty”) i „Rozłącz” przy połączeniu; przy kopii informacja z odesłaniem
 * do faktury z KSeF. Teksty mówią, co naprawdę liczą odczyty: odmowa okresu
 * (#839) zatrzymuje tylko miesiąc, w którym są oba koszty, więc przy kopii
 * z innego miesiąca oba koszty liczą się, każdy w swoim miesiącu. Wzór i miejsce
 * jak `ReceiptMatchAlert` (00175).
 */

const ZRODLA: Readonly<Record<string, string>> = {
  ocr_photo: 'Zdjęcie',
  manual: 'Wpis ręczny',
  import: 'Import',
  ksef_inbox: 'Faktura z KSeF',
};

const docLine = (doc: KsefCopyDoc) =>
  `${ZRODLA[doc.source] ?? 'Koszt'}${doc.number ? ` ${doc.number}` : ''} z ${plDate(doc.issueDate)}, ${formatPlMoney(doc.gross)} zł`;

const miesiac = (isoDate: string) => isoDate.slice(0, 7);
/** Lista po polsku: „a”, „a i b”, „a, b i c”. */
const lista = (xs: readonly string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} i ${xs.at(-1)}`);

export const KOPIA_KSEF_TEXTS = {
  ksefCandidatesTitle: 'Ta faktura jest w kosztach także jako kopia',
  ksefCandidatesSameMonth:
    'W kosztach jest też kopia tej faktury spoza KSeF: ten sam NIP sprzedawcy, numer i rok. Dopóki oba koszty liczą się w KPiR, ' +
    'koszty, VAT i JPK_V7M tego okresu się nie liczą, żeby nie wpisać kosztu ani VAT podwójnie. Po połączeniu koszt, VAT i numer KSeF ' +
    'idą z tej faktury, a kopia zostaje na liście poza KPiR.',
  ksefCandidatesOtherMonth:
    'W kosztach jest też kopia tej faktury spoza KSeF z innego miesiąca: ten sam NIP sprzedawcy, numer i rok. Odmowa okresu dotyczy ' +
    'tylko miesiąca, w którym są oba koszty, więc teraz oba liczą się w KPiR i VAT, każdy w swoim miesiącu: ten sam koszt i VAT są ' +
    'w kosztach dwa razy. Po połączeniu koszt, VAT i numer KSeF idą z tej faktury, a kopia zostaje na liście poza KPiR.',
  ksefCandidatesMixedMonths:
    'W kosztach jest też kilka kopii tej faktury spoza KSeF: ten sam NIP sprzedawcy, numer i rok, z różnych miesięcy. Odmowa okresu ' +
    'dotyczy tylko miesiąca, w którym są oba koszty, więc kopia z tego samego miesiąca zatrzymuje okres, a kopia z innego miesiąca ' +
    'liczy się obok tej faktury, każda w swoim miesiącu (ten sam koszt i VAT dwa razy). Po połączeniu z wybraną kopią koszt, VAT i ' +
    'numer KSeF idą z tej faktury, a ta kopia zostaje na liście poza KPiR.',
  ksefOutsideKpir:
    'Ten koszt z KSeF jest wyłączony z KPiR, więc liczy się kopia. Połączenie wyjęłoby z KPiR oba koszty, dlatego go tu nie ma. Żeby ' +
    'koszt, VAT i numer KSeF szły z tej faktury, najpierw włącza się przy niej „Uwzględnij w KPiR”.',
  ksefCandidatesSeparate:
    'Gdy to inny dokument, poprawienie numeru w kopii kończy odmowę, a „To osobne dokumenty” zamyka zadanie. Przy tym samym numerze ' +
    'okres dalej się nie liczy, dopóki przy kopii nie wyłączy się „Uwzględnij w KPiR”.',
  reasonFiled: (miesiace: readonly string[]) =>
    `${miesiace.length > 1 ? `Miesiące ${lista(miesiace)} są już złożone` : `Miesiąc ${miesiace[0] ?? ''} jest już złożony`} ` +
    '(rozliczenie w module, wysyłka JPK_V7M albo eksport KPiR lub JPK). Połączenie zmieni koszty i VAT złożonego okresu, ' +
    'więc połącz koszty tylko wtedy, gdy ta zmiana ma trafić do korekty.',
  reasonFiledUnknown:
    'Nie udało się sprawdzić, czy miesiące tych kosztów są już złożone (rozliczenie w module, JPK_V7M, eksport KPiR lub JPK). ' +
    'Połączenie zmieni koszty i VAT złożonego okresu, więc przed połączeniem sprawdź to w rozliczeniach.',
  reasonAmount: 'Koszty nie połączyły się same, bo kwota brutto kopii jest inna niż na fakturze z KSeF.',
  ksefLinkedTitle: 'Kopia tej faktury jest połączona',
  ksefLinkedBody:
    'Koszt, VAT i numer KSeF liczą się z tej faktury, a kopia jest na liście poza KPiR i poza odliczeniem VAT. Po rozłączeniu kopia ' +
    'wraca do stanu sprzed połączenia, a kategoria przejęta od kopii zostaje przy tym koszcie (można ją zmienić w formularzu). Przy ' +
    'tym samym numerze okres znowu przestanie się liczyć, dopóki przy kopii nie wyłączy się „Uwzględnij w KPiR” albo nie poprawi się ' +
    'numeru w kopii.',
  ksefLinkedOutsideKpir:
    'Kopia jest połączona i poza KPiR, a ten koszt z KSeF też jest wyłączony z KPiR, więc ten dokument nie wchodzi teraz ani do KPiR, ' +
    'ani do VAT. Wystarczy włączyć przy tym koszcie „Uwzględnij w KPiR” albo rozłączyć koszty.',
  ksefRemaining: (n: number) =>
    `${n === 1 ? 'Pozostała kopia z zadania została' : 'Pozostałe kopie z zadania zostały'} w KPiR. Przy tym samym numerze okres się ` +
    `nie liczy, dopóki przy ${n === 1 ? 'niej' : 'nich'} nie wyłączy się „Uwzględnij w KPiR”:`,
  copyCandidatesTitle: 'Możliwa kopia faktury z KSeF',
  copyCandidatesSameMonth:
    'Z KSeF przyszła faktura od tego sprzedawcy z tym samym numerem. Czy to ten sam dokument, wybiera się na stronie faktury z KSeF. ' +
    'Do tego czasu koszty, VAT i JPK_V7M tego okresu się nie liczą.',
  copyCandidatesOtherMonth:
    'Z KSeF przyszła faktura od tego sprzedawcy z tym samym numerem, z innego miesiąca. Oba koszty liczą się teraz w KPiR i VAT, ' +
    'każdy w swoim miesiącu, więc ten sam koszt i VAT są w kosztach dwa razy, dopóki koszty nie zostaną połączone na stronie faktury ' +
    'z KSeF albo przy tej kopii nie wyłączy się „Uwzględnij w KPiR”.',
  copyLinkedTitle: 'Kopia faktury z KSeF',
  copyLinkedBody:
    'Ten koszt to kopia faktury, która jest w kosztach z KSeF, więc nie wchodzi do KPiR ani do odliczenia VAT. Rozłączenie jest ' +
    'na stronie faktury z KSeF.',
} as const;

export function KopiaKsefAlert({ copy }: { copy: KsefCopyView }) {
  const router = useRouter();
  const [pending, startDecision] = useTransition();

  const decide = (copyExpenseId: string | null) => {
    const ksefExpenseId = copy.ksefExpenseId;
    if (!ksefExpenseId) return;
    startDecision(async () => {
      const result = await decideKsefCopyAction(ksefExpenseId, copyExpenseId);
      if (result.success) {
        toast.success(result.result === 'linked' ? 'Połączono kopię z fakturą z KSeF' : 'Zapisano decyzję o kosztach');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const t = KOPIA_KSEF_TEXTS;
  const isKsef = copy.role === 'ksef';
  const linked = copy.state === 'linked';
  const selfMonth = copy.self ? miesiac(copy.self.issueDate) : null;
  const innych = selfMonth === null ? 0 : copy.docs.filter((d) => miesiac(d.issueDate) !== selfMonth).length;
  // Kilka kopii z różnych miesięcy: tekst „z innego miesiąca” byłby nieprawdziwy dla części z nich, więc neutralny.
  const mixedMonths = innych > 0 && innych < copy.docs.length;
  const otherMonth = innych > 0 && !mixedMonths;
  // Koszt z KSeF poza KPiR: połączenie wyjęłoby z KPiR oba koszty (00217 odmawia tego też w bazie).
  const ksefOutside = isKsef && copy.self !== null && !copy.self.deductible;

  const title = isKsef ? (linked ? t.ksefLinkedTitle : t.ksefCandidatesTitle) : linked ? t.copyLinkedTitle : t.copyCandidatesTitle;
  const body = isKsef
    ? linked
      ? ksefOutside ? t.ksefLinkedOutsideKpir : t.ksefLinkedBody
      : ksefOutside ? t.ksefOutsideKpir : mixedMonths ? t.ksefCandidatesMixedMonths : otherMonth ? t.ksefCandidatesOtherMonth : t.ksefCandidatesSameMonth
    : linked
      ? t.copyLinkedBody
      : otherMonth ? t.copyCandidatesOtherMonth : t.copyCandidatesSameMonth;
  // Ostrzeżenie o złożonym okresie z aktualnego stanu, a nie z przyczyny zadania (ta jest migawką z chwili jego utworzenia).
  const filed =
    isKsef && !linked && !ksefOutside
      ? copy.filedMonths === null
        ? t.reasonFiledUnknown
        : copy.filedMonths.length > 0
          ? t.reasonFiled(copy.filedMonths.map((m) => monthLabel(m)))
          : null
      : null;
  const reason = isKsef && !linked && copy.reason?.code === 'amount_differs' ? t.reasonAmount : null;
  const canLink = isKsef && !linked && !ksefOutside;

  return (
    <Alert role="alert" className="border-amber-600/30">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{body}</p>
        {reason ? <p>{reason}</p> : null}
        {filed ? <p className="font-medium text-foreground">{filed}</p> : null}
        <ul className="space-y-2">
          {copy.docs.map((doc) => (
            <li key={doc.expenseId} className="flex flex-wrap items-center gap-2">
              <Link href={`/expenses/${doc.expenseId}`} className="text-foreground underline underline-offset-2">
                {docLine(doc)}
              </Link>
              {canLink ? (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(doc.expenseId)}>
                  Połącz koszty
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {isKsef && linked && copy.remaining.length > 0 ? (
          <div className="space-y-2">
            <p>{t.ksefRemaining(copy.remaining.length)}</p>
            <ul className="space-y-2">
              {copy.remaining.map((doc) => (
                <li key={doc.expenseId}>
                  <Link href={`/expenses/${doc.expenseId}`} className="text-foreground underline underline-offset-2">
                    {docLine(doc)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {isKsef && !linked ? <p>{t.ksefCandidatesSeparate}</p> : null}
        {isKsef ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(null)}>
            {linked ? 'Rozłącz' : 'To osobne dokumenty'}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
