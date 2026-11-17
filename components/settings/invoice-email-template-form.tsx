'use client';

import { useRef, useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { resetInvoiceEmailTemplateAction, saveInvoiceEmailTemplateAction } from '@/app/actions/invoice-email-template';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DEFAULT_INVOICE_EMAIL_TEMPLATE,
  INVOICE_EMAIL_BODY_MAX,
  INVOICE_EMAIL_PLACEHOLDERS,
  INVOICE_EMAIL_SUBJECT_MAX,
  invoiceEmailBodyParagraphs,
  renderInvoiceEmailSubject,
  validateInvoiceEmailTemplate,
  type InvoiceEmailTemplate,
  type InvoiceEmailValues,
} from '@/lib/email/invoice-email-template';

const SAVE_FAILED = 'Nie udało się zapisać szablonu. Sprawdź połączenie i spróbuj ponownie.';
const RESET_FAILED = 'Nie udało się przywrócić szablonu domyślnego. Sprawdź połączenie i spróbuj ponownie.';

type Target = 'subject' | 'body';

/**
 * Własny szablon maila z fakturą w ustawieniach firmy (plan kompletnej aplikacji,
 * krok 2.8, 00208): temat i treść z polami, podgląd na przykładowych danych,
 * zapis i powrót do domyślnego. Nowa sekcja na końcu zakładki „Firma” (D1).
 * Zmienia właściciel i administrator (sprawdza też baza); pozostali widzą
 * szablon bez przycisków. Zasady składania maila: `lib/email/invoice-email-template.ts`.
 */
export function InvoiceEmailTemplateForm({
  initial,
  canEdit,
  sellerName,
  sampleDueDate,
}: {
  /** Własny szablon firmy; `null`: mail domyślny. */
  initial: InvoiceEmailTemplate | null;
  canEdit: boolean;
  sellerName: string;
  /** Przykładowy termin płatności do podglądu (dziś + 14 dni, liczone na serwerze). */
  sampleDueDate: string;
}) {
  const [saved, setSaved] = useState<InvoiceEmailTemplate | null>(initial);
  const [subject, setSubject] = useState(initial?.subject ?? DEFAULT_INVOICE_EMAIL_TEMPLATE.subject);
  const [body, setBody] = useState(initial?.body ?? DEFAULT_INVOICE_EMAIL_TEMPLATE.body);
  const [pending, startTransition] = useTransition();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastTarget = useRef<Target>('body');

  const checked = validateInvoiceEmailTemplate({ subject, body });
  const current = saved ?? DEFAULT_INVOICE_EMAIL_TEMPLATE;
  const unchanged = subject.trim() === current.subject && body.trim() === current.body;

  const sample: InvoiceEmailValues = {
    numer: 'FV/12/11/2026',
    sprzedawca: sellerName || 'Twoja firma',
    kwota: '1 230,00 PLN',
    termin: sampleDueDate,
    tytul_przelewu: 'Faktura FV/12/11/2026',
  };

  const insertField = (key: string) => {
    const token = `{${key}}`;
    const target = lastTarget.current;
    const el = target === 'subject' ? subjectRef.current : bodyRef.current;
    const text = target === 'subject' ? subject : body;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    if (target === 'subject') setSubject(next);
    else setBody(next);
    const caret = start + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const save = () => {
    if (!checked.ok) return;
    startTransition(async () => {
      const result = await saveInvoiceEmailTemplateAction({ subject, body }).catch(() => ({ success: false as const, error: SAVE_FAILED }));
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setSaved(result.template);
      setSubject(result.template.subject);
      setBody(result.template.body);
      toast.success('Szablon maila zapisany');
    });
  };

  const reset = () => {
    startTransition(async () => {
      const result = await resetInvoiceEmailTemplateAction().catch(() => ({ success: false as const, error: RESET_FAILED }));
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setSaved(null);
      setSubject(DEFAULT_INVOICE_EMAIL_TEMPLATE.subject);
      setBody(DEFAULT_INVOICE_EMAIL_TEMPLATE.body);
      toast.success('Przywrócono szablon domyślny');
    });
  };

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel>Mail z fakturą</FieldLabel>
        <FieldDescription>
          Temat i treść wiadomości, którą nabywca dostaje z fakturą w załączniku. Pola w nawiasach klamrowych zastępują się
          danymi faktury w chwili wysyłki. Kwota, termin płatności i tytuł przelewu oraz stopka o przetwarzaniu danych
          zostają w wiadomości zawsze, bez względu na szablon.
        </FieldDescription>
        <FieldDescription>{saved ? 'Stan: własny szablon.' : 'Stan: szablon domyślny.'}</FieldDescription>
        {canEdit ? null : <FieldDescription>Zmienić to może właściciel albo administrator firmy.</FieldDescription>}
      </FieldContent>
      <div className="flex w-full flex-col gap-3 sm:w-[28rem]">
        <div className="flex flex-col gap-1">
          <label htmlFor="invoice-email-subject" className="text-sm font-medium">
            Temat
          </label>
          <Input
            id="invoice-email-subject"
            ref={subjectRef}
            value={subject}
            maxLength={INVOICE_EMAIL_SUBJECT_MAX}
            readOnly={!canEdit}
            onFocus={() => (lastTarget.current = 'subject')}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="invoice-email-body" className="text-sm font-medium">
            Treść
          </label>
          <Textarea
            id="invoice-email-body"
            ref={bodyRef}
            rows={7}
            value={body}
            maxLength={INVOICE_EMAIL_BODY_MAX}
            readOnly={!canEdit}
            onFocus={() => (lastTarget.current = 'body')}
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">Pusty wiersz zaczyna nowy akapit.</p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Wstaw pole">
            {INVOICE_EMAIL_PLACEHOLDERS.map((p) => (
              <Button key={p.key} type="button" variant="outline" size="sm" title={p.label} onClick={() => insertField(p.key)} disabled={pending}>
                {`{${p.key}}`}
              </Button>
            ))}
          </div>
        ) : null}

        <div aria-label="Podgląd wiadomości" className="border bg-white p-3 text-sm text-neutral-800">
          {checked.ok ? (
            <>
              <p className="font-semibold">{renderInvoiceEmailSubject(checked.subject, sample)}</p>
              <div className="mt-2 space-y-2">
                {invoiceEmailBodyParagraphs(checked.body, sample).map((paragraph, i) => (
                  <p key={i} className="whitespace-pre-line">
                    {paragraph}
                  </p>
                ))}
              </div>
              <p className="mt-3 text-xs text-neutral-500">
                Podgląd z przykładowych danych. Pod treścią mail zawsze zawiera kwotę, termin płatności i tytuł przelewu z
                faktury oraz stopkę.
              </p>
            </>
          ) : (
            <p role="alert" className="text-destructive">
              {checked.error}
            </p>
          )}
        </div>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={save} disabled={pending || !checked.ok || unchanged} className="max-lg:min-h-[44px]">
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Zapisz szablon
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={pending || !saved} className="max-lg:min-h-[44px]">
              Przywróć domyślny
            </Button>
          </div>
        ) : null}
      </div>
    </Field>
  );
}
