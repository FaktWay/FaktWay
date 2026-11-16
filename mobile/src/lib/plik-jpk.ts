/**
 * Plik JPK z serwera w systemowym arkuszu udostępniania (M10d), jak PDF faktury
 * w M10a (`lib/pdf-faktury.ts`): ten sam plik co „Pobierz” na stronie, zapisany
 * w `Paths.cache/faktway-dane/jpk/`, więc wylogowanie czyści go razem z danymi
 * konta. Arkusz iOS daje Pocztę, komunikatory i „Zachowaj w Plikach”. Telefon
 * pliku nie składa ani nie zmienia.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Share } from 'react-native';

/** Nazwa pliku bez znaków, których system plików nie przyjmie. */
export function nazwaPlikuXml(nazwa: string): string {
  const czysta = nazwa.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'JPK';
  return /\.xml$/i.test(czysta) ? czysta : `${czysta}.xml`;
}

/** Zapisuje XML (UTF-8) i otwiera arkusz udostępniania. Błąd zapisu wraca do ekranu. */
export async function udostepnijXml(nazwa: string, xml: string): Promise<void> {
  const katalog = new Directory(Paths.cache, 'faktway-dane', 'jpk');
  if (!katalog.exists) katalog.create({ intermediates: true, idempotent: true });
  const plik = new File(katalog, nazwaPlikuXml(nazwa));
  if (plik.exists) plik.delete();
  plik.create();
  plik.write(xml);
  await Share.share({ url: plik.uri, title: plik.name });
}
