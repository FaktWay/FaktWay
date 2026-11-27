/**
 * Teksty ekranów potwierdzenia salda (PR C, D26-D28, D58). Treść dokumentu
 * (dopisek, przypis, zdanie o saldzie, powody pominięć, odmowy) zostaje
 * w `lib/saldo/teksty.ts`; tu tylko opisy ekranów.
 */
export const BALANCE_SCREEN = {
  contractorButton: 'Potwierdzenie salda',
  issueTitle: 'Potwierdzenie salda',
  issueIntro:
    'Zestawienie nieopłaconych faktur sprzedaży w złotych, które kontrahent ma potwierdzić. Dokument dostaje numer i od tej chwili nie można go zmienić ani usunąć.',
  omittedTitle: 'Pominięte dokumenty',
  omittedIntro:
    'Tych faktur nie ma w zestawieniu. Jeśli mają w nim być, wystaw zestawienie później albo uzgodnij je z kontrahentem poza FaktWay.',
  omittedConfirm: 'Wystaw bez tych dokumentów',
  issue: 'Wystaw potwierdzenie salda',
  issueConfirmTitle: 'Wystawić potwierdzenie salda?',
  issueConfirmBody:
    'Dokument dostanie kolejny numer PS z serii i od tej chwili nie można go zmienić ani usunąć. Poprawka to nowe potwierdzenie.',
  issueConfirmBodyOmitted:
    'Dokument wyjdzie bez pominiętych dokumentów z listy powyżej, z kolejnym numerem PS z serii. Nie można go potem zmienić ani usunąć.',
  listTab: 'Potwierdzenia sald',
  notesTab: 'Noty',
  listEmptyTitle: 'Nie masz jeszcze potwierdzeń salda',
  listEmptyDescription: 'Potwierdzenie wystawisz w tabeli Kontrahenci, przyciskiem przy kontrahencie z należnościami.',
  listReadFailedTitle: 'Nie udało się wczytać potwierdzeń salda',
  listReadFailedBody: 'Odśwież stronę za chwilę. Jeśli błąd wróci, napisz do pomocy FaktWay.',
  noRole: 'Twoja rola w tej firmie nie pozwala wystawiać potwierdzeń salda.',
  emailsTitle: 'Wysyłki mailem',
  emailsEmpty: 'To potwierdzenie nie było jeszcze wysyłane mailem.',
  emailsFailed: 'Nie udało się wczytać historii wysyłek. Odśwież stronę za chwilę.',
  sendDescription:
    'Wyślemy wiadomość FaktWay z potwierdzeniem salda w PDF. Treść i temat są stałe. Ponowna wysyłka na ten sam adres wysyła dokument jeszcze raz.',
} as const;
