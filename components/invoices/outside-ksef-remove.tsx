'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { removeOutsideKsefInvoiceAction } from '@/app/actions/faktury-spoza-ksef';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Usunięcie wpisu spoza KSeF z historii (krok 1.6, PR C; D23). Poprawka wpisu to
 * usunięcie i dodanie od nowa. Gdy miesiąc faktury ma wysłany JPK_V7M albo
 * zatwierdzone rozliczenie, akcja nie usuwa za pierwszym razem, tylko zwraca
 * ostrzeżenie z nazwą miesiąca; dopiero drugie kliknięcie z potwierdzeniem usuwa.
 * Tylko właściciel i administrator (`canRemove`); inni nie widzą przycisku.
 */
export function OutsideKsefRemove({
  invoiceId,
  number,
  canRemove,
}: {
  invoiceId: string;
  number: string | null;
  canRemove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [ostrzezenie, setOstrzezenie] = useState<string | null>(null);

  if (!canRemove) return null;

  function usun(potwierdzam: boolean) {
    startTransition(async () => {
      const wynik = await removeOutsideKsefInvoiceAction(invoiceId, potwierdzam ? { potwierdzam: true } : {});
      if (wynik.success) {
        toast.success(number ? `Faktura ${number} usunięta z historii FaktWay.` : 'Faktura usunięta z historii FaktWay.');
        router.push('/invoices');
        router.refresh();
        return;
      }
      if (wynik.wymagaPotwierdzenia) {
        setOstrzezenie(wynik.error);
        return;
      }
      setOstrzezenie(null);
      toast.error(wynik.error);
    });
  }

  return (
    <Card data-testid="poza-ksef-usun" className="shadow-none print:hidden">
      <CardHeader>
        <CardTitle>Wpis spoza KSeF</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Gdy w tym wpisie jest błąd, usuń go z historii i dodaj od nowa.
        </p>
        {ostrzezenie ? (
          <div role="alert" className="border-destructive/40 bg-destructive/5 space-y-3 rounded-md border p-3">
            <p>{ostrzezenie}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" disabled={pending} onClick={() => usun(true)}>
                Usuń mimo to
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setOstrzezenie(null)}>
                Zostaw fakturę
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" disabled={pending} onClick={() => usun(false)}>
            Usuń z historii
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
