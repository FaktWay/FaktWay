'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { discardInvoiceAutosaveAction, saveInvoiceAutosaveAction } from '@/app/actions/invoice-autosave';
import { restorableValues } from '@/lib/invoices/form-autosave';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/** Cisza po ostatniej zmianie, po której zapisujemy kopię roboczą. */
export const AUTOSAVE_DEBOUNCE_MS = 4000;
/** Najdłuższe czekanie przy ciągłym pisaniu: zapis najpóźniej tyle po pierwszej niezapisanej zmianie. */
export const AUTOSAVE_MAX_WAIT_MS = 15_000;

export type AutosaveStatus = { kind: 'idle' } | { kind: 'saved'; at: string } | { kind: 'failed' };

/**
 * Autozapis formularza zwykłej faktury (plan kompletnej aplikacji, krok 2.8).
 * Zmiana wartości planuje zapis kopii roboczej (`saveInvoiceAutosaveAction`)
 * po `AUTOSAVE_DEBOUNCE_MS` ciszy, a przy ciągłym pisaniu najpóźniej po
 * `AUTOSAVE_MAX_WAIT_MS`. Zapis idzie pod kluczem `numberRequestKey` formularza,
 * więc kolejne zapisy tego samego otwarcia nadpisują jedną kopię. Zmiany samego
 * numeru, serii i dat (nie wracają z kopii) nie uruchamiają zapisu. Ukrycie
 * karty zapisuje od razu. Błąd zapisu tylko zmienia status: formularz działa dalej.
 *
 * `finish()`: faktura zapisana albo wysłana: koniec autozapisu i kasowanie kopii.
 */
export function useFormAutosave({
  form,
  tenantId,
  enabled,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  tenantId: string;
  enabled: boolean;
}) {
  const [status, setStatus] = useState<AutosaveStatus>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSince = useRef<number | null>(null);
  const lastSaved = useRef<string | null>(null);
  const stopped = useRef(false);
  const inFlight = useRef(false);
  const changedWhileSaving = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    stopped.current = false;
    const signature = () => JSON.stringify(restorableValues(form.getValues() as Record<string, unknown>));
    lastSaved.current = signature();

    const schedule = (delay: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    };
    const flush = async () => {
      timer.current = null;
      pendingSince.current = null;
      if (stopped.current) return;
      if (inFlight.current) {
        changedWhileSaving.current = true;
        return;
      }
      const sig = signature();
      if (sig === lastSaved.current) return;
      inFlight.current = true;
      changedWhileSaving.current = false;
      try {
        const result = await saveInvoiceAutosaveAction(form.getValues(), tenantId);
        if (stopped.current) return;
        if (result.ok) {
          lastSaved.current = sig;
          setStatus({ kind: 'saved', at: result.savedAt });
        } else {
          setStatus({ kind: 'failed' });
        }
      } catch {
        if (!stopped.current) setStatus({ kind: 'failed' });
      } finally {
        inFlight.current = false;
        if (changedWhileSaving.current && !stopped.current) {
          changedWhileSaving.current = false;
          pendingSince.current = Date.now();
          schedule(AUTOSAVE_DEBOUNCE_MS);
        }
      }
    };

    const subscription = form.watch(() => {
      if (stopped.current || signature() === lastSaved.current) return;
      const now = Date.now();
      pendingSince.current ??= now;
      schedule(Math.max(0, Math.min(AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS - (now - pendingSince.current))));
    });
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onHidden);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pendingSince.current = null;
    };
  }, [enabled, form, tenantId]);

  const finish = useCallback(() => {
    stopped.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!enabled) return;
    const key = form.getValues('numberRequestKey');
    if (typeof key === 'string' && key) {
      discardInvoiceAutosaveAction(key, tenantId).catch(() => {});
    }
  }, [enabled, form, tenantId]);

  return { status, finish };
}
