'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { czyFakturaWCenachBrutto } from '@/lib/invoices/ceny-brutto-wylacznik-wspolne';
import {
  invoiceFormSchemaFor,
  lineItemSchema,
  unitPriceGrossSchema,
  type InvoiceFormValues,
} from '@/lib/schemas/invoice-form';
import { calculateInvoiceTotals, GROSS_PRICES_UNTAXED_RATES } from '@/lib/xml/invoice-calculator';
import {
  saveAndSendInvoiceAction,
  saveDraftAction,
  type PrefillFromLastInvoice,
} from './actions';
import type { CachedValidationResult } from '@/lib/validation/cache';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { InvoiceTotals } from '@/components/invoices/invoice-totals';
import { suggestsSplitPayment } from '@/lib/invoices/annotations';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { formDefaultsOf, type InvoiceDefaults } from '@/lib/invoices/invoice-defaults';
import type { SellerData } from '@/types/invoice-types';
import { Separator } from '@/components/ui/separator';
import { InvoiceCreateActions } from '@/components/invoices/finora/invoice-create-actions';
import {
  DocumentColumns,
  InvoiceCreateGrid,
  InvoiceCreatePageHeading,
  InvoiceDocumentCard,
  InvoiceDocumentHeader,
} from '@/components/invoices/finora/invoice-document';
import { BuyerSection } from './invoice-form-parts/buyer-section';
import { toLineItems } from './invoice-form-parts/calculations';
import { defaultLine, labelClass, type BuyerKind } from './invoice-form-parts/constants';
import { DocumentHeaderFields } from './invoice-form-parts/document-header-fields';
import { RecurringActionsCard, StickyFormActions } from './invoice-form-parts/form-actions';
import { MobileFormHeader, PrefillBanner } from './invoice-form-parts/form-header';
import { LineItemsSection } from './invoice-form-parts/line-items-section';
import { OrderNumberField } from './invoice-form-parts/order-number-field';
import { PaymentSection } from './invoice-form-parts/payment-section';
import { ReceiptInvoiceFields } from './invoice-form-parts/receipt-invoice-fields';
import { useLinesDesktopLayout } from './invoice-form-parts/use-lines-desktop-layout';
import { ERROR_TOAST_MS, FormErrorSummary, type FormErrorState } from './invoice-form-parts/form-error-summary';
import { collectValidationIssues } from './invoice-form-parts/validation-issues';
import { numberingDefaults, SeriesSelectRow, useSeriesNumber } from './numeracja/series-select-row';
import type { InvoiceNumbering } from '@/lib/numeracja/model';
import { firstValidationMessage } from './invoice-form-parts/validation-message';
import { AutosaveRestoreBanner, AutosaveStatusLine } from './invoice-form-parts/autosave-banner';
import { useFormAutosave } from './invoice-form-parts/use-form-autosave';
import { discardInvoiceAutosaveAction } from '@/app/actions/invoice-autosave';
import { restorableValues, type LoadedAutosave } from '@/lib/invoices/form-autosave';

/**
 * Formularz zwykłej faktury. Ten plik trzyma stan (React Hook Form, watche,
 * stan białej listy), zapis i wysyłkę; sekcje są w `invoice-form-parts/`.
 * Niezmienniki podziału: `docs/koordynacja/PLAN-USPRAWNIENIA-PRACY.md`, 3.7c.
 */
export function InvoiceForm({
  tenantId,
  prefill = null,
  vatExempt = false,
  vatExemptSubjective = false,
  suggestedNumber = null,
  numbering = null,
  seller = null,
  initialValues = null,
  defaults = null,
  recurringInvoiceId = null,
  recurringPeriod = null,
  salesQuoteId = null,
  salesQuoteSeq = null,
  restoredDraft = null,
  grossPricesAvailable = false,
}: {
  /**
   * Firma, dla której strona wyrenderowała formularz (UX-01). Zapis odsyła ją
   * jako `expectedTenantId`; akcja odmawia, gdy w innej karcie przełączono
   * firmę. Tylko do porównania — firmą faktury jest firma z sesji.
   */
  tenantId: string;
  /**
   * Dane sprzedawcy do nagłówka dokumentu (P5) — tylko do wyświetlenia.
   * Faktura i tak bierze sprzedawcę z profilu firmy po stronie serwera.
   */
  seller?: SellerData | null;
  /** Podkład z ostatniej faktury — `null`, gdy tenant nie ma jeszcze żadnej. */
  prefill?: PrefillFromLastInvoice | null;
  /** Podpowiedź kolejnego numeru (F-015) — pole pozostaje edytowalne. */
  suggestedNumber?: string | null;
  /**
   * Krok 2.5: serie numeracji firmy z serią domyślną zwykłej faktury
   * i podpowiedzią z jej licznika. Wybór serii pojawia się przy co najmniej
   * dwóch seriach; numer z pola zostaje edytowalny.
   */
  numbering?: InvoiceNumbering | null;
  /**
   * Firma zwolniona z VAT (ustawiona podstawa w Ustawieniach → Podatek VAT).
   * Nowe pozycje dostają wtedy „zw” — inaczej z przyzwyczajenia wpada 23%.
   */
  vatExempt?: boolean;
  /**
   * Zwolnienie podmiotowe (art. 113, `isSubjectiveVatExemption`): firma nie
   * wystawi faktury w cenach brutto (pozycje „zw”, #880), więc formularz nie
   * pokazuje wyboru metody cen. Zwolnienie przedmiotowe (art. 43) go zostawia:
   * czynny podatnik sprzedaje też ze stawką 23, 8 albo 5 %.
   */
  vatExemptSubjective?: boolean;
  /**
   * Podkład wpisany od razu w formularz (plan Finora N1: `?wzor=` i
   * `?cykliczna=` — `prefillFromInvoiceAction`). Bez niego formularz pusty.
   */
  initialValues?: Partial<InvoiceFormValues> | null;
  /**
   * Krok 2.8: domyślne ustawienia firmy dla nowej faktury (forma płatności,
   * termin w dniach). Startowe wartości formularza; podkład (`initialValues`)
   * wpisuje własne wartości po nich, więc ma pierwszeństwo. Brak: przelew, 14 dni.
   */
  defaults?: Partial<InvoiceDefaults> | null;
  /**
   * Pozycja cykliczna (`?cykliczna=`) — ukryte pole; „Wystaw i wyślij” zajmuje
   * nim okres. W tym trybie nie ma „Zapisz szkic” (C2): szkic nie zamyka okresu.
   */
  recurringInvoiceId?: string | null;
  /** Okres z banera strony (np. `2026-11`) — ukryte pole; zapis sprawdza, czy pozycja go nie zmieniła (C3). */
  recurringPeriod?: string | null;
  /**
   * Proforma albo oferta (krok 2.4, `?proforma=`), z której stronę otwarto:
   * ukryte pola; zapis wpisuje powiązanie w tym samym INSERT co fakturę.
   * Numer kolejnej zamiany nadaje strona (druga faktura tylko po potwierdzeniu).
   */
  salesQuoteId?: string | null;
  salesQuoteSeq?: string | null;
  /**
   * Krok 2.8: niezakończona praca z autozapisu (kopia robocza tej osoby),
   * którą strona proponuje przywrócić. Tylko przy pustym formularzu.
   */
  restoredDraft?: LoadedAutosave | null;
  /**
   * Plan cen brutto, PR (b): wyłącznik faktury w cenach brutto
   * (`cenyBruttoDostepne()` na serwerze strony; domyślnie wyłączony). Przy
   * `false` formularz nie ma wyboru „Ceny brutto”, faktura do paragonu nie
   * przechodzi na ceny brutto, a podkład i kopia robocza zostają w cenach
   * netto; schemat odmawia faktury w cenach brutto, a zapis na serwerze
   * sprawdza wyłącznik sam.
   */
  grossPricesAvailable?: boolean;
}) {
  const newLine: InvoiceFormValues['lines'][number] = vatExempt
    ? { ...defaultLine, vatRate: 'zw' }
    : defaultLine;
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();
  const [isSending, startSending] = useTransition();
  // Stały blok błędów nad akcjami (A-05): toast znika, blok zostaje i bierze fokus.
  const [blad, setBlad] = useState<FormErrorState | null>(null);
  const pokazBlad = (zmiana: Partial<Omit<FormErrorState, 'nonce'>>) =>
    setBlad((poprzedni) => ({
      issues: [],
      saveError: null,
      ...zmiana,
      nonce: (poprzedni?.nonce ?? 0) + 1,
    }));
  const [buyerVatStatus, setBuyerVatStatus] =
    useState<CachedValidationResult | null>(null);

  // Synchroniczny re-entry guard — `isSaving`/`isSending` z `useTransition`
  // ustawia się dopiero po async-walidacji RHF/Zod (kilka ms okna), przez co
  // szybkie podwójne kliknięcie "Wystaw i wyślij" potrafiło stworzyć dwie
  // faktury z tym samym `internal_number` (audyt #11). Ten ref blokuje submit
  // od razu na pierwszym kliknięciu, jeszcze zanim transition pendinguje.
  // Stanowi PIERWSZĄ warstwę ochrony — drugą jest unique index z migracji
  // 00028, trzecią mapowanie 23505 → friendly error w `actions.ts`.
  const submitInFlightRef = useRef(false);

  // Wiersze siatki od 1360 px albo karty, nigdy oba naraz (powód w hooku).
  const linesDesktopLayout = useLinesDesktopLayout();

  // Daty w czasie polskim, nie UTC (F-013): po północy „dziś” to nowy dzień.
  const today = todayInWarsaw();
  // Krok 2.8: forma i termin płatności firmy (bez ustawień: przelew i 14 dni, jak dotąd).
  const paymentDefaults = formDefaultsOf(defaults, today);

  // Krok 2.5: seria domyślna i jej podpowiedź; klucz zapisu jeden na otwarcie
  // formularza (drugi zapis po podwójnym kliknięciu nie tworzy drugiej faktury).
  const numberDefaults = numberingDefaults(numbering);
  const [numberRequestKey] = useState(() => crypto.randomUUID());

  // Ten sam schemat co serwer, z wyłącznikiem cen brutto (stan z serwera strony, stały przez życie formularza).
  const schema = useMemo(() => invoiceFormSchemaFor({ cenyBrutto: grossPricesAvailable }), [grossPricesAvailable]);
  // Osobne ustalenie 13: firma zwolniona podmiotowo (art. 113, pozycje „zw”) nie wystawi faktury
  // w cenach brutto (stawki bez podatku, #880), więc bez wyboru metody i bez podkładu w cenach brutto.
  const cenyBruttoWFormularzu = grossPricesAvailable && !vatExemptSubjective;
  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(schema),
    // Fokus po nieudanym zapisie bierze blok błędów (A-05), z odnośnikami do pól.
    shouldFocusError: false,
    defaultValues: {
      internalNumber: suggestedNumber ?? '',
      issueDate: today,
      saleDate: today,
      buyerNip: '',
      buyerName: '',
      buyerAddressLine1: '',
      buyerAddressLine2: '',
      buyerEmail: '',
      buyerIsConsumer: false,
      buyerConsumerIdType: undefined,
      buyerPesel: '',
      buyerIdDocument: '',
      buyerIsEu: false,
      buyerVatUe: '',
      buyerCountryCode: '',
      lines: [newLine],
      paymentMethod: paymentDefaults.paymentMethod,
      paymentDueDate: paymentDefaults.paymentDueDate,
      bankAccount: '',
      notes: '',
      // Numer zamówienia (krok 2.8): domyślnie bez, pola zwinięte pod przyciskiem.
      orderNumber: '',
      orderDate: '',
      splitPayment: false,
      // Faktura do paragonu (krok 1.2): domyślnie wyłączona, pola puste.
      receiptInvoice: false,
      receiptNumber: '',
      receiptDate: '',
      cashRegisterNumber: '',
      receiptRequestDate: '',
      buyerNipOnReceipt: false,
      ...initialValues,
      // Numer z serii firmy (także przy podkładzie z innej faktury: numer ma być nowy).
      ...(numbering ? { internalNumber: numberDefaults.preview ?? initialValues?.internalNumber ?? '' } : {}),
      numberSeriesId: numberDefaults.numberSeriesId,
      numberPreview: numberDefaults.numberPreview,
      numberRequestKey,
      ...(recurringInvoiceId ? { recurringInvoiceId } : {}),
      ...(recurringInvoiceId && recurringPeriod ? { recurringPeriod } : {}),
      ...(salesQuoteId && salesQuoteSeq ? { salesQuoteId, salesQuoteSeq } : {}),
      // Plan cen brutto, PR (b): ceny netto domyślnie, jak dotąd; ceny brutto tylko z podkładu
      // w cenach brutto i przy włączonym wyłączniku (bez niego zawsze ceny netto).
      pricesGross: cenyBruttoWFormularzu && czyFakturaWCenachBrutto(initialValues),
    },
  });
  /** Tryb „Wystaw teraz” z faktury cyklicznej — bez szkicu (C2). */
  const recurringMode = Boolean(recurringInvoiceId);

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: 'lines',
  });

  // Krok 2.8: autozapis kopii roboczej. Faktura cykliczna i proforma mają
  // własną drogę zapisu (bez szkicu), więc tam autozapisu nie ma.
  const autosave = useFormAutosave({ form, tenantId, enabled: !recurringMode && !salesQuoteId });
  // Plan cen brutto, PR (b): ceny brutto ustawiła faktura do paragonu, nie klient
  // (odznaczenie paragonu może je wtedy cofnąć).
  const cenyBruttoOdParagonu = useRef(false);
  const [restoreOffer, setRestoreOffer] = useState<LoadedAutosave | null>(restoredDraft);
  const restoreAutosave = () => {
    if (!restoreOffer) return;
    const { lines, ...rest } = restorableValues(restoreOffer.values as Record<string, unknown>);
    for (const [name, value] of Object.entries(rest)) {
      form.setValue(name as keyof InvoiceFormValues, value as never);
    }
    if (Array.isArray(lines) && lines.length > 0 && lines.every((l) => typeof l === 'object' && l !== null)) replace(lines);
    // Metoda cen z kopii; kopia sprzed cen brutto (bez metody) była w cenach netto,
    // a bez wyłącznika cen brutto formularz zostaje w cenach netto.
    form.setValue('pricesGross', cenyBruttoWFormularzu && czyFakturaWCenachBrutto(rest));
    cenyBruttoOdParagonu.current = false;
    // Kolejne autozapisy nadpisują tę samą kopię, a zapis faktury niesie jej klucz.
    form.setValue('numberRequestKey', restoreOffer.requestKey);
    setRestoreOffer(null);
    toast.success('Przywróciłem niezapisaną fakturę');
  };
  const discardAutosave = () => {
    if (!restoreOffer) return;
    discardInvoiceAutosaveAction(restoreOffer.requestKey, tenantId).catch(() => {});
    setRestoreOffer(null);
  };

  const watchedLines = useWatch({ control: form.control, name: 'lines' });
  const buyerNipWatch = useWatch({ control: form.control, name: 'buyerNip' });
  const buyerIsConsumer = useWatch({ control: form.control, name: 'buyerIsConsumer' });
  const buyerConsumerIdType = useWatch({
    control: form.control,
    name: 'buyerConsumerIdType',
  });
  const buyerIsEu = useWatch({ control: form.control, name: 'buyerIsEu' });
  const buyerVatUeWatch = useWatch({ control: form.control, name: 'buyerVatUe' }) ?? '';
  const buyerCountryCode = useWatch({ control: form.control, name: 'buyerCountryCode' }) ?? '';
  const buyerKind: BuyerKind = buyerIsEu ? 'eu' : buyerIsConsumer ? 'consumer' : 'pl';
  const receiptInvoice = useWatch({ control: form.control, name: 'receiptInvoice' }) === true;
  // Plan cen brutto, PR (b): ceny netto albo brutto dla całej faktury (jedna metoda na fakturę).
  const pricesGross = useWatch({ control: form.control, name: 'pricesGross' }) === true;
  const issueDateWatch = useWatch({ control: form.control, name: 'issueDate' }) ?? today;

  // Krok 2.5: zmiana serii albo daty wystawienia podpowiada numer z tej serii,
  // o ile w polu nie ma numeru wpisanego ręcznie.
  const series = useSeriesNumber({
    numbering,
    issueDate: issueDateWatch,
    read: () => ({ number: form.getValues('internalNumber') ?? '', preview: form.getValues('numberPreview') || undefined }),
    write: ({ seriesId, preview, number }) => {
      form.setValue('numberSeriesId', seriesId);
      form.setValue('numberPreview', preview);
      if (number !== undefined) form.setValue('internalNumber', number, { shouldValidate: form.formState.isSubmitted });
    },
  });

  // Faktura do paragonu (krok 1.2): data paragonu ustawia datę sprzedaży. Po
  // odznaczeniu FP wraca data sprzedaży sprzed zaznaczenia, jeśli od tamtej
  // pory zmieniła ją tylko data paragonu: zwykła faktura nie może po cichu
  // zostać z datą sprzedaży z paragonu (P_6).
  const saleDateBeforeReceipt = useRef<string | null>(null);

  // Plan cen brutto, PR (b): zmiana metody cen całej faktury. Ceny nie są
  // przeliczane: każda metoda ma swoje pole, a powrót pokazuje wpisaną cenę.
  // Pole metody, której nie widać, nie może zatrzymać zapisu, więc
  // nieprawidłowa cena netto wraca do 0, a nieprawidłowa cena brutto do pustego pola.
  const ustawCenyBrutto = (gross: boolean) => {
    (form.getValues('lines') ?? []).forEach((l, i) => {
      if (gross && !lineItemSchema.shape.unitPriceNet.safeParse(l?.unitPriceNet).success) {
        form.setValue(`lines.${i}.unitPriceNet`, 0);
      }
      if (!gross && l?.unitPriceGross !== undefined && !unitPriceGrossSchema.safeParse(l.unitPriceGross).success) {
        form.setValue(`lines.${i}.unitPriceGross`, undefined);
      }
    });
    form.setValue('pricesGross', gross, { shouldDirty: true });
    if (form.formState.isSubmitted) void form.trigger();
  };
  const onPricesGrossChange = (gross: boolean) => {
    cenyBruttoOdParagonu.current = false;
    ustawCenyBrutto(gross);
  };

  const onReceiptInvoiceChange = (checked: boolean) => {
    const lines = form.getValues('lines') ?? [];
    if (checked) {
      saleDateBeforeReceipt.current = form.getValues('saleDate') ?? '';
      // Paragon ma kwoty brutto, a kasa liczy PTU od sumy brutto stawki, więc faktura
      // do paragonu domyślnie idzie w cenach brutto. Tylko przy pozycjach bez ceny netto
      // i bez stawki bez podatku: wpisanych cen nie przestawiamy.
      // Bez wyłącznika cen brutto faktura do paragonu zostaje w cenach netto.
      const bezCen = lines.every(
        (l) => !(Number(l?.unitPriceNet) > 0) && !(l?.vatRate !== undefined && GROSS_PRICES_UNTAXED_RATES.has(l.vatRate)),
      );
      if (cenyBruttoWFormularzu && bezCen && form.getValues('pricesGross') !== true) {
        ustawCenyBrutto(true);
        cenyBruttoOdParagonu.current = true;
      }
      return;
    }
    // Odznaczenie FP: ceny netto wracają, jeśli przestawił je paragon, a ceny brutto nikt nie wpisał.
    if (cenyBruttoOdParagonu.current && lines.every((l) => l?.unitPriceGross === undefined)) {
      ustawCenyBrutto(false);
    }
    cenyBruttoOdParagonu.current = false;
    const before = saleDateBeforeReceipt.current;
    saleDateBeforeReceipt.current = null;
    const receiptDate = form.getValues('receiptDate');
    if (before !== null && receiptDate && form.getValues('saleDate') === receiptDate) {
      form.setValue('saleDate', before, { shouldValidate: form.formState.isSubmitted });
    }
  };
  const onReceiptDateChange = (value: string) =>
    form.setValue('saleDate', value, { shouldValidate: form.formState.isSubmitted });

  // Ta sama tablica idzie do sum i do `InvoiceTotals` (rozbicie VAT na stawki).
  const lineItems = toLineItems(watchedLines, pricesGross);

  const totals = calculateInvoiceTotals(lineItems);
  const splitPayment = useWatch({ control: form.control, name: 'splitPayment' });
  // MPP dotyczy firm z Polski — nie osoby prywatnej ani firmy z UE (AUD-70).
  const podpowiedzMpp = !splitPayment && suggestsSplitPayment(totals.grossTotal, buyerKind !== 'pl');

  const [prefillUzyty, setPrefillUzyty] = useState(false);

  /**
   * Wypełnienie z ostatniej faktury.
   *
   * NIE RUSZAMY numeru ani żadnej daty — te pola formularz wypełnił sam
   * wartościami na dziś i przepisanie starych byłoby cofnięciem faktury
   * w czasie. Reszta to podmiana wartości: nabywca, pozycje i sposób zapłaty.
   */
  const wypelnijZOstatniej = () => {
    if (!prefill) return;
    const v = prefill.values;
    // Nabywca z UE (AUD-70) wraca z numerem VAT-UE i krajem zamiast NIP-u.
    const ue = v.buyerIsEu === true;
    form.setValue('buyerIsConsumer', false);
    form.setValue('buyerIsEu', ue);
    form.setValue('buyerVatUe', ue ? v.buyerVatUe ?? '' : '');
    form.setValue('buyerCountryCode', ue ? v.buyerCountryCode ?? '' : '');
    if (ue) setBuyerVatStatus(null);
    form.setValue('buyerNip', v.buyerNip, { shouldValidate: !ue });
    form.setValue('buyerName', v.buyerName);
    form.setValue('buyerAddressLine1', v.buyerAddressLine1);
    form.setValue('buyerAddressLine2', v.buyerAddressLine2);
    form.setValue('buyerEmail', v.buyerEmail);
    form.setValue('paymentMethod', v.paymentMethod);
    if (v.bankAccount) form.setValue('bankAccount', v.bankAccount);
    // Faktura-podkład w cenach brutto wraca w cenach brutto, z ceną brutto pozycji (N1);
    // bez wyłącznika cen brutto podkład jest w cenach netto (serwer daje go wtedy bez cen brutto).
    form.setValue('pricesGross', cenyBruttoWFormularzu && czyFakturaWCenachBrutto(v));
    cenyBruttoOdParagonu.current = false;
    replace(v.lines);
    setPrefillUzyty(true);
    toast.success(`Wypełniłem na podstawie faktury dla ${prefill.contractorName}`);
  };

  const handleSaveDraft = form.handleSubmit(
    (values) => {
      if (submitInFlightRef.current) return;
      setBlad(null);
      submitInFlightRef.current = true;
      startSaving(async () => {
        try {
          const result = await saveDraftAction(values, tenantId);
          if (result.success) {
            autosave.finish();
            toast.success('Szkic zapisany');
            router.push(`/invoices/${result.invoiceId}`);
          } else {
            toast.error(result.error, { duration: ERROR_TOAST_MS });
            pokazBlad({ saveError: result.error });
          }
        } catch (e) {
          const komunikat = e instanceof Error ? e.message : 'Błąd zapisu';
          toast.error(komunikat, { duration: ERROR_TOAST_MS });
          pokazBlad({ saveError: komunikat });
        } finally {
          submitInFlightRef.current = false;
        }
      });
    },
    (errors) => {
      submitInFlightRef.current = false;
      toast.error(firstValidationMessage(errors), { duration: ERROR_TOAST_MS });
      pokazBlad({ issues: collectValidationIssues(errors) });
    }
  );

  const handleSend = form.handleSubmit(
    (values) => {
      if (submitInFlightRef.current) return;

      // BUG-010 (audyt przedlaunchowy): ostrzeżenie o fakturze bezpłatnej.
      // Puste pole ceny jest blokowane przez walidację Zod. Cena 0.00 zł jest
      // dozwolona (faktura bezpłatna jest legalna), ale wymaga świadomego
      // potwierdzenia, żeby user nie wysłał przypadkiem faktury na 0 zł.
      // Przy cenach brutto liczy się cena brutto pozycji (plan cen brutto, PR (b)).
      const hasZeroPriceLine = (values.lines ?? []).some(
        (l) => Number(czyFakturaWCenachBrutto(values) ? l.unitPriceGross : l.unitPriceNet) === 0,
      );
      if (hasZeroPriceLine) {
        const proceed =
          typeof window !== 'undefined' &&
          confirm(
            'Co najmniej jedna pozycja ma cenę 0.00 zł. Czy na pewno chcesz wystawić fakturę bezpłatną?',
          );
        if (!proceed) return;
      }

      // Biała lista zna tylko polskie NIP-y — nie pytamy przy osobie prywatnej
      // ani firmie z UE.
      if (
        buyerKind === 'pl' &&
        buyerVatStatus &&
        !buyerVatStatus.isValid
      ) {
        const label =
          buyerVatStatus.legalName?.trim() ||
          `(NIP ${buyerVatStatus.nip ?? '?'})`;
        const proceed =
          typeof window !== 'undefined' &&
          confirm(
            `Uwaga: kontrahent ${label} ma status "${buyerVatStatus.vatStatus}". KSeF może odrzucić fakturę. Kontynuować?`,
          );
        if (!proceed) {
          return;
        }
      }

      setBlad(null);
      submitInFlightRef.current = true;
      startSending(async () => {
        try {
          const result = await saveAndSendInvoiceAction(values, tenantId);
          if (result.success) {
            autosave.finish();
            toast.success('Wysyłanie faktury do KSeF rozpoczęte');
            router.push(`/invoices/${result.invoiceId}`);
          } else {
            toast.error(result.error, { duration: ERROR_TOAST_MS });
            pokazBlad({ saveError: result.error });
            if (result.invoiceId) {
              autosave.finish();
              router.push(`/invoices/${result.invoiceId}`);
            }
          }
        } catch (e) {
          const komunikat = e instanceof Error ? e.message : 'Błąd wysyłki';
          toast.error(komunikat, { duration: ERROR_TOAST_MS });
          pokazBlad({ saveError: komunikat });
        } finally {
          submitInFlightRef.current = false;
        }
      });
    },
    (errors) => {
      submitInFlightRef.current = false;
      toast.error(firstValidationMessage(errors), { duration: ERROR_TOAST_MS });
      pokazBlad({ issues: collectValidationIssues(errors) });
    }
  );

  // Odczyt w renderze subskrybuje RHF na zmianę — handlery dostają świeżą wartość.
  const wyslanoRaz = form.formState.isSubmitted;

  // react-hook-form: watch() jest celowo niememoizowalny — React Compiler pomija ten hook.
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch dla warunkowego UI
  const paymentMethod = form.watch('paymentMethod');

  const busy = isSaving || isSending;

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6 pb-32 lg:pb-10">
      {recurringInvoiceId ? <input type="hidden" {...form.register('recurringInvoiceId')} /> : null}
      {recurringInvoiceId && recurringPeriod ? <input type="hidden" {...form.register('recurringPeriod')} /> : null}
      {salesQuoteId && salesQuoteSeq ? <input type="hidden" {...form.register('salesQuoteId')} /> : null}
      {salesQuoteId && salesQuoteSeq ? <input type="hidden" {...form.register('salesQuoteSeq')} /> : null}
      {/* NAGŁÓWEK — dwa układy.
          Na telefonie pasek z makiety: strzałka wstecz, tytuł z podtytułem,
          „Szkic” po prawej. Zapis szkicu wchodzi tu z dolnego paska, żeby
          zostawić mu miejsce na dwa przyciski zamiast trzech.
          Od `sm` nagłówek strony jak na liście faktur (P3). */}
      <MobileFormHeader
        recurringMode={recurringMode}
        busy={busy}
        isSaving={isSaving}
        onSaveDraft={handleSaveDraft}
      />

      <InvoiceCreatePageHeading
        className="hidden sm:block"
        title="Nowa faktura"
        description="Wystaw fakturę B2B lub B2C i wyślij do KSeF jednym kliknięciem"
      />

      {/* PODPOWIEDŹ FLO — tylko gdy jest z czego wypełniać.
          Zniknie po użyciu: baner, który po kliknięciu zostaje, wygląda jakby
          nic się nie stało, a formularz jest już wypełniony. */}
      {prefill && !prefillUzyty ? (
        <PrefillBanner contractorName={prefill.contractorName} onFill={wypelnijZOstatniej} />
      ) : null}

      {restoreOffer ? (
        <AutosaveRestoreBanner savedAt={restoreOffer.savedAt} onRestore={restoreAutosave} onDiscard={discardAutosave} />
      ) : null}

      <FormErrorSummary state={blad} />

      {recurringMode || salesQuoteId ? null : <AutosaveStatusLine status={autosave.status} />}

      <InvoiceCreateGrid>
        <InvoiceDocumentCard
          header={
            <InvoiceDocumentHeader seller={seller}>
              <DocumentHeaderFields
                form={form}
                seriesRow={
                  <SeriesSelectRow
                    numbering={numbering}
                    seriesId={series.seriesId}
                    onSelect={series.selectSeries}
                    disabled={busy}
                  />
                }
              />
              <ReceiptInvoiceFields
                form={form}
                enabled={receiptInvoice}
                buyerKind={buyerKind}
                onToggle={onReceiptInvoiceChange}
                onReceiptDateChange={onReceiptDateChange}
              />
            </InvoiceDocumentHeader>
          }
        >
          <DocumentColumns>
            {/* NABYWCA (Finora: „Invoice To:”) */}
            <BuyerSection
              form={form}
              buyerKind={buyerKind}
              buyerNipWatch={buyerNipWatch}
              buyerConsumerIdType={buyerConsumerIdType}
              buyerVatUeWatch={buyerVatUeWatch}
              buyerCountryCode={buyerCountryCode}
              buyerVatStatus={buyerVatStatus}
              setBuyerVatStatus={setBuyerVatStatus}
              wyslanoRaz={wyslanoRaz}
            />

            {/* PŁATNOŚĆ (Finora: „Bill To:”) — termin jest w nagłówku, jak „Date Due”. */}
            <PaymentSection form={form} paymentMethod={paymentMethod} podpowiedzMpp={podpowiedzMpp} />
          </DocumentColumns>

          <Separator />

          <LineItemsSection
            form={form}
            fields={fields}
            linesDesktopLayout={linesDesktopLayout}
            remove={remove}
            onAddLine={() => append(newLine)}
            vatExempt={vatExempt}
            pricesGross={pricesGross}
            pricesModeAvailable={cenyBruttoWFormularzu}
            onPricesGrossChange={onPricesGrossChange}
            lineItems={lineItems}
          />

          <Separator />

          {/* Jedno podsumowanie pod oboma układami pozycji — po prawej, jak w Finorze. */}
          <InvoiceTotals totals={totals} lines={lineItems} />

          <Separator />

          <OrderNumberField form={form} />

          <div>
            <Label htmlFor="invoice-notes" className={labelClass}>
              Uwagi
            </Label>
            <Textarea id="invoice-notes" rows={3} {...form.register('notes')} />
          </div>
        </InvoiceDocumentCard>

        {recurringMode ? (
          <RecurringActionsCard busy={busy} isSending={isSending} onSend={handleSend} />
        ) : (
          <InvoiceCreateActions
            onSend={handleSend}
            onSave={handleSaveDraft}
            sending={isSending}
            saving={isSaving}
            disabled={busy}
          />
        )}
      </InvoiceCreateGrid>

      {/* STICKY FOOTER — tylko telefon i tablet; od `lg` akcje są w prawej kolumnie. */}
      <StickyFormActions
        recurringMode={recurringMode}
        busy={busy}
        isSaving={isSaving}
        isSending={isSending}
        onSaveDraft={handleSaveDraft}
        onSend={handleSend}
      />
    </form>
  );
}
