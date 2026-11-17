'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';
import type { z } from 'zod';

import { createManualExpenseAction } from '@/app/actions/expenses';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import { MANUAL_EXPENSE_CATEGORIES, manualExpenseSchema, type ManualExpenseInput } from '@/lib/expenses/manual-expense';

const SAVE_FAILED = 'Nie udało się zapisać kosztu. Sprawdź połączenie i spróbuj ponownie za chwilę.';

const DOCUMENT_TYPES = [
  { value: 'other', label: 'Inny dokument (opłata, składka, rachunek)' },
  { value: 'receipt', label: 'Paragon' },
  { value: 'invoice', label: 'Faktura' },
] as const;

const KPIR_COLUMNS = [
  { value: 'col_10', label: 'Kol. 10: towary handlowe i materiały' },
  { value: 'col_11', label: 'Kol. 11: koszty uboczne zakupu' },
  { value: 'col_12', label: 'Kol. 12: wynagrodzenia' },
  { value: 'col_13', label: 'Kol. 13: pozostałe wydatki' },
  { value: 'col_15', label: 'Kol. 15: koszty B+R' },
] as const;

const selectClass =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none';

const errId = (id: string) => `${id}-error`;
const describe = (id: string, hasError: boolean) => (hasError ? { 'aria-invalid': true as const, 'aria-describedby': errId(id) } : {});

/**
 * Koszt wpisany ręcznie (plan kompletnej aplikacji, krok 3.8, część 1):
 * opłata bez faktury, składka członkowska, zakup bez zdjęcia. Te same pola co
 * odczyt zdjęcia, z kolumną KPiR wybraną przez człowieka. Walidacja ta sama co
 * na serwerze (`manualExpenseSchema`); zasady zapisu i odliczenia VAT:
 * `lib/expenses/manual-expense.ts`.
 */
export function ManualExpenseForm({ tenantId, today, vatExempt }: { tenantId: string; today: string; vatExempt: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const grossTouched = useRef(false);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    watch,
    formState: { errors },
  } = useForm<z.input<typeof manualExpenseSchema>, unknown, ManualExpenseInput>({
    resolver: zodResolver(manualExpenseSchema),
    defaultValues: {
      sellerName: '',
      sellerNip: '',
      documentType: 'other',
      kpirColumn: 'col_13',
      categoryLabel: '',
      documentNumber: '',
      issueDate: today,
      vatAmount: 0,
      notes: '',
      isDeductible: true,
    },
  });

  // Brutto liczy się z netto i VAT, dopóki człowiek nie wpisze go sam.
  const recomputeGross = () => {
    if (grossTouched.current) return;
    const net = Number(getValues('netAmount'));
    const vat = Number(getValues('vatAmount') ?? 0);
    if (Number.isFinite(net) && Number.isFinite(vat)) setValue('grossAmount', roundToCents(net + vat));
  };
  const net = register('netAmount', { valueAsNumber: true });
  const vat = register('vatAmount', { valueAsNumber: true });
  const gross = register('grossAmount', { valueAsNumber: true });

  // react-hook-form: watch() jest niememoizowalny, czytamy go tylko do podpowiedzi o VAT.
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch dla warunkowej podpowiedzi
  const documentType = watch('documentType');

  const onSubmit = (values: ManualExpenseInput) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setServerError(null);
    startTransition(async () => {
      try {
        const result = await createManualExpenseAction(values, tenantId);
        if (!result.success) {
          setServerError(result.error);
          return;
        }
        toast.success(result.duplicate ? 'Ten koszt jest już zapisany.' : 'Koszt zapisany.');
        router.push(`/expenses/${result.expenseId}`);
      } catch {
        setServerError(SAVE_FAILED);
      } finally {
        inFlight.current = false;
      }
    });
  };

  const noVatDeduction = vatExempt || documentType !== 'invoice';

  return (
    <Card className="shadow-none">
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6" noValidate>
          <FieldGroup>
            {serverError ? (
              <Alert variant="destructive">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            ) : null}

            <p className="text-muted-foreground text-sm">
              Dla wydatku bez zdjęcia: opłata bez faktury, składka, zakup za gotówkę. Dla paragonu albo faktury łatwiej{' '}
              <Link href="/expenses" className="font-medium underline underline-offset-4">
                zrobić zdjęcie
              </Link>
              : dane odczytamy sami.
            </p>

            <Field data-invalid={!!errors.sellerName}>
              <FieldLabel htmlFor="manual-expense-seller">Sprzedawca lub odbiorca płatności</FieldLabel>
              <FieldContent>
                <Input id="manual-expense-seller" maxLength={500} {...describe('manual-expense-seller', !!errors.sellerName)} {...register('sellerName')} />
                <FieldError id={errId('manual-expense-seller')} errors={[errors.sellerName]} />
              </FieldContent>
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.sellerNip}>
                <FieldLabel htmlFor="manual-expense-nip">NIP (opcjonalnie)</FieldLabel>
                <FieldContent>
                  <Input id="manual-expense-nip" inputMode="numeric" {...describe('manual-expense-nip', !!errors.sellerNip)} {...register('sellerNip')} />
                  <FieldError id={errId('manual-expense-nip')} errors={[errors.sellerNip]} />
                </FieldContent>
              </Field>
              <Field data-invalid={!!errors.documentType}>
                <FieldLabel htmlFor="manual-expense-type">Rodzaj dokumentu</FieldLabel>
                <FieldContent>
                  <select id="manual-expense-type" className={selectClass} {...describe('manual-expense-type', !!errors.documentType)} {...register('documentType')}>
                    {DOCUMENT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {documentType === 'invoice' ? (
                    <FieldDescription>Faktura wystawiona w KSeF trafi do Kosztów sama ze Skrzynki KSeF.</FieldDescription>
                  ) : null}
                  <FieldError id={errId('manual-expense-type')} errors={[errors.documentType]} />
                </FieldContent>
              </Field>
              <Field data-invalid={!!errors.documentNumber}>
                <FieldLabel htmlFor="manual-expense-number">Numer dokumentu (opcjonalnie)</FieldLabel>
                <FieldContent>
                  <Input id="manual-expense-number" maxLength={200} {...describe('manual-expense-number', !!errors.documentNumber)} {...register('documentNumber')} />
                  <FieldError id={errId('manual-expense-number')} errors={[errors.documentNumber]} />
                </FieldContent>
              </Field>
              <Field data-invalid={!!errors.issueDate}>
                <FieldLabel htmlFor="manual-expense-date">Data wystawienia</FieldLabel>
                <FieldContent>
                  <Input id="manual-expense-date" type="date" max={today} {...describe('manual-expense-date', !!errors.issueDate)} {...register('issueDate')} />
                  <FieldError id={errId('manual-expense-date')} errors={[errors.issueDate]} />
                </FieldContent>
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field data-invalid={!!errors.netAmount}>
                <FieldLabel htmlFor="manual-expense-net">Kwota netto (zł)</FieldLabel>
                <FieldContent>
                  <Input
                    id="manual-expense-net"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    {...describe('manual-expense-net', !!errors.netAmount)}
                    {...net}
                    onChange={(e) => {
                      void net.onChange(e);
                      recomputeGross();
                    }}
                  />
                  <FieldError id={errId('manual-expense-net')} errors={[errors.netAmount]} />
                </FieldContent>
              </Field>
              <Field data-invalid={!!errors.vatAmount}>
                <FieldLabel htmlFor="manual-expense-vat">VAT (zł)</FieldLabel>
                <FieldContent>
                  <Input
                    id="manual-expense-vat"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    {...describe('manual-expense-vat', !!errors.vatAmount)}
                    {...vat}
                    onChange={(e) => {
                      void vat.onChange(e);
                      recomputeGross();
                    }}
                  />
                  <FieldError id={errId('manual-expense-vat')} errors={[errors.vatAmount]} />
                </FieldContent>
              </Field>
              <Field data-invalid={!!errors.grossAmount}>
                <FieldLabel htmlFor="manual-expense-gross">Kwota brutto (zł)</FieldLabel>
                <FieldContent>
                  <Input
                    id="manual-expense-gross"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    {...describe('manual-expense-gross', !!errors.grossAmount)}
                    {...gross}
                    onChange={(e) => {
                      grossTouched.current = true;
                      void gross.onChange(e);
                    }}
                  />
                  <FieldError id={errId('manual-expense-gross')} errors={[errors.grossAmount]} />
                </FieldContent>
              </Field>
            </div>

            {noVatDeduction ? (
              <FieldDescription role="status">
                {vatExempt
                  ? 'Firma jest zwolniona z VAT, więc FaktWay nie odlicza VAT z tego kosztu.'
                  : 'Z paragonu i innego dokumentu FaktWay nie odlicza VAT (odliczenie daje faktura), a w koszcie KPiR jest kwota brutto.'}
              </FieldDescription>
            ) : null}

            {documentType === 'other' ? (
              <FieldDescription>O ujęciu w KPiR wydatku bez faktury albo rachunku rozstrzyga księgowa.</FieldDescription>
            ) : null}

            <Field data-invalid={!!errors.categoryLabel}>
              <FieldLabel htmlFor="manual-expense-category">Kategoria</FieldLabel>
              <FieldContent>
                <Input
                  id="manual-expense-category"
                  list="manual-expense-categories"
                  maxLength={200}
                  {...describe('manual-expense-category', !!errors.categoryLabel)}
                  {...register('categoryLabel')}
                />
                <datalist id="manual-expense-categories">
                  {MANUAL_EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <FieldDescription>Nazwa kosztu w KPiR, np. Paliwo albo Składka członkowska. Można wpisać własną.</FieldDescription>
                <FieldError id={errId('manual-expense-category')} errors={[errors.categoryLabel]} />
              </FieldContent>
            </Field>

            <Field data-invalid={!!errors.kpirColumn}>
              <FieldLabel htmlFor="manual-expense-kpir">Kolumna KPiR</FieldLabel>
              <FieldContent>
                <select id="manual-expense-kpir" className={selectClass} {...describe('manual-expense-kpir', !!errors.kpirColumn)} {...register('kpirColumn')}>
                  <option value="">Wybierz kolumnę</option>
                  {KPIR_COLUMNS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <FieldDescription>Kolumnę wybierasz Ty; w razie wątpliwości rozstrzyga księgowa.</FieldDescription>
                <FieldError id={errId('manual-expense-kpir')} errors={[errors.kpirColumn]} />
              </FieldContent>
            </Field>

            <Field orientation="horizontal">
              <Checkbox
                id="manual-expense-deductible"
                defaultChecked
                onCheckedChange={(checked) => setValue('isDeductible', checked === true)}
              />
              <FieldLabel htmlFor="manual-expense-deductible">Wlicz do KPiR</FieldLabel>
            </Field>

            <Field data-invalid={!!errors.notes}>
              <FieldLabel htmlFor="manual-expense-notes">Uwagi (opcjonalnie)</FieldLabel>
              <FieldContent>
                <Textarea id="manual-expense-notes" rows={3} {...describe('manual-expense-notes', !!errors.notes)} {...register('notes')} />
                <FieldError id={errId('manual-expense-notes')} errors={[errors.notes]} />
              </FieldContent>
            </Field>
          </FieldGroup>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={isPending}>
              {isPending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Zapisz koszt
            </Button>
            <Link href="/expenses" className="text-muted-foreground text-sm underline underline-offset-4">
              Anuluj
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
