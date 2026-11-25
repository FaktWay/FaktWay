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
import { formatPlMoney } from '@/lib/format/pl';

/**
 * FZ-022, decyzja D29 (00215): kopia faktury z KSeF na stronie kosztu. Przy
 * koszcie z KSeF zadanie „Połącz koszty” (wybór kopii albo „To osobne
 * dokumenty”) i „Rozłącz” przy połączeniu; przy kopii informacja z odesłaniem
 * do faktury z KSeF. Wzór i miejsce jak `ReceiptMatchAlert` (00175).
 */

const ZRODLA: Readonly<Record<string, string>> = {
  ocr_photo: 'Zdjęcie',
  manual: 'Wpis ręczny',
  import: 'Import',
  ksef_inbox: 'Faktura z KSeF',
};

const docLine = (doc: KsefCopyDoc) =>
  `${ZRODLA[doc.source] ?? 'Koszt'}${doc.number ? ` ${doc.number}` : ''} z ${plDate(doc.issueDate)}, ${formatPlMoney(doc.gross)} zł`;

export const KOPIA_KSEF_TEXTS = {
  ksefCandidatesTitle: 'Ta faktura jest w kosztach także jako kopia',
  ksefCandidatesBody:
    'W kosztach jest też kopia tej faktury spoza KSeF: ten sam NIP sprzedawcy, numer i rok. Dopóki oba koszty liczą się w KPiR, ' +
    'KPiR, VAT i JPK_V7M tego okresu się nie liczą, żeby nie wpisać kosztu ani VAT podwójnie. Po połączeniu koszt, VAT i numer ' +
    'KSeF idą z tej faktury, a kopia zostaje na liście poza KPiR.',
  ksefCandidatesSeparate:
    'Gdy to inny dokument, wystarczy poprawić numer albo datę w kopii. „To osobne dokumenty” zamyka zadanie, ale przy tym samym ' +
    'numerze okres dalej się nie liczy, dopóki przy jednym z kosztów nie wyłączy się „Uwzględnij w KPiR”.',
  ksefLinkedTitle: 'Kopia tej faktury jest połączona',
  ksefLinkedBody:
    'Koszt, VAT i numer KSeF liczą się z tej faktury, a kopia jest na liście poza KPiR i poza odliczeniem VAT. Jeśli to inny ' +
    'dokument, koszty można rozłączyć: kopia wróci do KPiR, a przy tym samym numerze okres znowu przestanie się liczyć, dopóki przy ' +
    'jednym z kosztów nie wyłączy się „Uwzględnij w KPiR” albo nie poprawi numeru w kopii.',
  copyCandidatesTitle: 'Możliwa kopia faktury z KSeF',
  copyCandidatesBody:
    'Z KSeF przyszła faktura od tego sprzedawcy z tym samym numerem. Czy to ten sam dokument, wybiera się na stronie faktury ' +
    'z KSeF. Do tego czasu KPiR, VAT i JPK_V7M tego okresu się nie liczą.',
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
  const title = isKsef ? (linked ? t.ksefLinkedTitle : t.ksefCandidatesTitle) : linked ? t.copyLinkedTitle : t.copyCandidatesTitle;
  const body = isKsef ? (linked ? t.ksefLinkedBody : t.ksefCandidatesBody) : linked ? t.copyLinkedBody : t.copyCandidatesBody;

  return (
    <Alert role="alert" className="border-amber-600/30">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{body}</p>
        <ul className="space-y-2">
          {copy.docs.map((doc) => (
            <li key={doc.expenseId} className="flex flex-wrap items-center gap-2">
              <Link href={`/expenses/${doc.expenseId}`} className="text-foreground underline underline-offset-2">
                {docLine(doc)}
              </Link>
              {isKsef && !linked ? (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(doc.expenseId)}>
                  Połącz koszty
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
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
