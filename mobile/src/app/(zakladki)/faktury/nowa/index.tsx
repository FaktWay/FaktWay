import { useRouter } from 'expo-router';

import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';

/**
 * Wybór rodzaju faktury: odpowiednik `components/invoices/invoice-type-selector.tsx`.
 * Wszystkie cztery rodzaje otwierają formularz w telefonie: zwykłą fakturę
 * wystawia się z telefonu od M8, zaliczkę, rozliczenie i korektę od M8b. Czego
 * telefon nie zrobi (wysyłki rozliczenia albo korekty, gdy serwer ją wstrzymał
 * tak samo jak na stronie: `wysylkaWstrzymana` z podpowiedzi), mówi sam
 * formularz: główny przycisk zmienia się wtedy na „Zapisz szkic”. Ten ekran
 * niczego nie obiecuje ani nie odsyła na stronę.
 */
export default function EkranRodzajuFaktury() {
  const router = useRouter();
  const otworz = (rodzaj: string) => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj } });
  return (
    <>
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.dismissTo('/faktury')} />
      <EkranListy>
        <Sekcja naglowek="Rodzaj faktury">
          <Wiersz tytul="Faktura zwykła" podtytul="Standardowa faktura sprzedażowa B2B lub B2C" ikona="file-text-line" strzalka onPress={() => otworz('vat')} />
          <Wiersz tytul="Faktura korygująca" podtytul="Korekta wystawionej faktury (dane, kwoty, anulowanie)" ikona="arrow-go-back-line" strzalka onPress={() => otworz('korygujaca')} />
          <Wiersz tytul="Faktura zaliczkowa" podtytul="Zaliczka na poczet przyszłej dostawy lub usługi" ikona="cash-line" strzalka onPress={() => otworz('zaliczkowa')} />
          <Wiersz tytul="Faktura rozliczająca" podtytul="Rozliczenie wcześniej wystawionych zaliczek" ikona="checkbox-multiple-line" strzalka onPress={() => otworz('rozliczajaca')} />
        </Sekcja>
      </EkranListy>
    </>
  );
}
