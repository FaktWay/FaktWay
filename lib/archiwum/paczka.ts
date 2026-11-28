import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePagesByKey } from '@/lib/accounting/read-complete-pages';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { exportScopeFor } from '@/lib/exports/export-scope';
import { MissingIssuerAddressError, readIssuerRegisteredAddress } from '@/lib/exports/issuer-address';
import {
  generateJpkFa,
  JpkDocumentNotSupportedError,
  JpkFaCorrectionNotSupportedError,
  JpkFaForeignCurrencyNotSupportedError,
} from '@/lib/exports/jpk-fa-generator';
import { assertJpkMatchesSchema, JpkSchemaError } from '@/lib/exports/jpk-schema-check';
import { MissingTaxOfficeError, readTenantTaxOffice } from '@/lib/exports/tax-office';
import { packageZip, type PackagedFile } from '@/lib/exports/zip-packager';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { readAllByIdInList } from '@/lib/pagination/in-list';
import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { pobierzOryginalSpozaKsef } from '@/lib/import/outside-ksef-oryginal';
import { downloadExpensePhoto } from '@/lib/storage/expenses';
import { downloadFromR2, downloadInvoiceXml } from '@/lib/storage/r2';
import { createAdminClient } from '@/lib/supabase/admin';

import { archivePlDate, type ArchiveKind } from './okres';

/**
 * Paczka ZIP z dokumentami firmy za okres (plan kompletnej aplikacji, krok
 * 6.4, część 1): faktury sprzedaży (XML z KSeF, PDF, UPO), faktury zakupu
 * (XML z KSeF, PDF), zdjęcia kosztów, listy CSV i spis `CO-JEST-W-PACZCE.txt`.
 * Paczka na kontrolę ma dodatkowo JPK_FA z generatora eksportu.
 *
 * Fail-closed bez przemilczeń: brak pliku w magazynie, plik niezgodny ze
 * skrótem, faktura bez przyjęcia w KSeF albo JPK_FA, którego generator nie
 * obsłuży, trafia do spisu jako brak z powodem i wyjściem, a paczka powstaje
 * dalej. Inny błąd magazynu albo bazy rzuca: „nie wiem, czy plik jest” to nie
 * „pliku nie ma”, więc zadanie ponawia próbę.
 *
 * Plik powstaje w pamięci (`packageZip`), dlatego źródła mają limit
 * `ARCHIVE_MAX_SOURCE_BYTES`; większy okres dostaje odmowę z wyjściem.
 */

export const ARCHIVE_MAX_SOURCE_BYTES = 150 * 1024 * 1024;

export class ArchiveTooLargeError extends Error {
  constructor() {
    super('Paczka za ten okres przekracza 150 MB. Wybierz krótszy okres, na przykład kwartał albo miesiąc, i zleć ją ponownie.');
    this.name = 'ArchiveTooLargeError';
  }
}

export interface ArchiveOrderInput {
  id: string;
  tenantId: string;
  kind: ArchiveKind;
  periodStart: string;
  periodEnd: string;
}

export interface ArchiveMissing {
  dokument: string;
  plik: string;
  powod: string;
}

export interface BuiltArchive {
  fileName: string;
  zip: Buffer;
  /** Pliki dokumentów (faktury, UPO, koszty, JPK) bez spisu i list CSV. */
  filesCount: number;
  missing: ArchiveMissing[];
}

const XML_NO_FILE =
  'FaktWay nie ma zapisanego pliku XML tej faktury. Oryginał jest w KSeF: pobierzesz go po numerze KSeF w Aplikacji Podatnika KSeF.';
const XML_MISSING =
  'pliku nie ma w magazynie FaktWay. Oryginał jest w KSeF: pobierzesz go po numerze KSeF w Aplikacji Podatnika KSeF albo napisz do nas.';
const XML_NO_HASH =
  'w bazie nie ma skrótu pliku, więc nie da się potwierdzić, że to ten sam plik co w KSeF. Oryginał pobierzesz po numerze KSeF w Aplikacji Podatnika KSeF.';
const XML_HASH_MISMATCH =
  'plik w magazynie nie zgadza się ze skrótem zapisanym przy wysyłce, więc nie trafił do paczki. Napisz do nas; oryginał pobierzesz po numerze KSeF w Aplikacji Podatnika KSeF.';
const UPO_NOT_YET =
  'FaktWay jeszcze nie pobrał UPO z KSeF. Pobiera je sam; zleć paczkę ponownie za kilka godzin albo pobierz UPO na stronie faktury.';
const UPO_FOREIGN =
  'faktura trafiła do KSeF spoza FaktWay (pobrana z historii KSeF), więc UPO ma program, z którego ją wysłano.';
const UPO_MISSING = 'pliku UPO nie ma w magazynie FaktWay. Napisz do nas; UPO pobierzesz też na stronie faktury.';
const ORIGINAL_MISSING =
  'oryginału PDF nie ma w magazynie FaktWay. Napisz do nas, sprawdzimy kopię; oryginał masz też w programie, w którym wystawiono fakturę.';
const PHOTO_MISSING = 'zdjęcia nie ma w magazynie FaktWay. Napisz do nas, sprawdzimy kopię.';
/** FZ-032: faktura bez danych stron (np. zakup ze Skrzynki KSeF z samymi metadanymi). */
const PDF_NO_PARTIES =
  'w FaktWay nie ma pełnych danych sprzedawcy i nabywcy tej faktury (tak jest np. przy fakturze zakupu pobranej ze Skrzynki KSeF, która ma tylko dane z KSeF), więc nie zrobiliśmy jej wydruku PDF. Oryginałem faktury jest plik XML z KSeF.';
/** Nieprzewidziany błąd wydruku: PDF to wizualizacja, więc paczka powstaje bez niego. */
const PDF_FAILED =
  'nie udało się zrobić wydruku PDF tej faktury, więc nie trafił do paczki. Oryginałem faktury jest plik XML z KSeF. Napisz do nas, sprawdzimy wydruk.';
const PHOTO_NONE =
  'w FaktWay nie ma zdjęcia ani pliku tego dokumentu. Jeśli jest na papierze, trzeba go dołączyć do dokumentów osobno.';
const JPK_LATER =
  'JPK_PKPIR, JPK_EWP i JPK_ST nie wchodzą jeszcze do paczki: moduł księgowości FaktWay jest w pilotażu, a JPK_ST jeszcze nie powstaje. ' +
  'Na żądanie urzędu przygotuje je program, w którym prowadzone są księgi, albo biuro rachunkowe.';

function notInKsefReason(status: string | null): string {
  switch (status) {
    case 'queued':
    case 'sending':
      return 'faktura czeka na przyjęcie w KSeF, więc nie ma jeszcze pliku z KSeF ani UPO. Zleć paczkę ponownie, gdy KSeF ją przyjmie.';
    case 'offline_queued':
      return 'faktura wystawiona w trybie offline czeka na wysyłkę do KSeF. Zleć paczkę ponownie, gdy KSeF ją przyjmie.';
    case 'rejected':
    case 'failed':
      return 'KSeF nie przyjął tej faktury, więc nie jest fakturą w KSeF. Można ją poprawić i wysłać ponownie na stronie faktury.';
    default:
      return 'faktura nie ma stanu KSeF, którego FaktWay się spodziewa. Napisz do nas, sprawdzimy ją.';
  }
}

const STATUS_LABELS: Record<string, string> = {
  accepted: 'przyjęta w KSeF',
  received: 'przyjęta w KSeF',
  queued: 'w drodze do KSeF',
  sending: 'w drodze do KSeF',
  offline_queued: 'wystawiona offline, czeka na KSeF',
  rejected: 'odrzucona przez KSeF',
  failed: 'błąd wysyłki do KSeF',
};

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  invoice: 'faktura',
  simplified_invoice: 'faktura uproszczona',
  receipt: 'paragon',
  other: 'inny dokument',
};

interface InvoiceRow {
  id: string;
  direction: string;
  internal_number: string | null;
  ksef_number: string | null;
  ksef_status: string | null;
  ksef_environment: string | null;
  origin: string | null;
  issue_date: string;
  sale_date: string | null;
  payment_due_date: string | null;
  net_total: number | string | null;
  vat_total: number | string | null;
  gross_total: number | string | null;
  currency: string | null;
  seller_data: unknown;
  buyer_data: unknown;
  seller_nip: string | null;
  buyer_nip: string | null;
  xml_storage_path: string | null;
  outside_ksef_original_path: string | null;
}
const INVOICE_COLUMNS =
  'id, direction, internal_number, ksef_number, ksef_status, ksef_environment, origin, issue_date, sale_date, payment_due_date, ' +
  'net_total, vat_total, gross_total, currency, seller_data, buyer_data, seller_nip, buyer_nip, xml_storage_path, outside_ksef_original_path';

interface ExpenseRow {
  id: string;
  issue_date: string;
  document_number: string | null;
  document_type: string | null;
  seller_name: string | null;
  seller_nip: string | null;
  net_amount: number | string | null;
  vat_amount: number | string | null;
  gross_amount: number | string | null;
  source: string | null;
  source_file_path: string | null;
  source_file_mime: string | null;
  ksef_invoice_id: string | null;
}
const EXPENSE_COLUMNS =
  'id, issue_date, document_number, document_type, seller_name, seller_nip, net_amount, vat_amount, gross_amount, source, source_file_path, source_file_mime, ksef_invoice_id';

const XML_DOC_COLUMNS = 'id, invoice_id, storage_path, sha256_hash';
const UPO_COLUMNS = 'id, invoice_id, status, upo_xml_path, created_at';

interface XmlDocRow {
  id: string;
  invoice_id: string;
  storage_path: string;
  sha256_hash: string | null;
}
interface UpoRow {
  id: string;
  invoice_id: string;
  status: string;
  upo_xml_path: string | null;
  created_at: string | null;
}

/** Strona odczytu po kluczu w typie helpera: kolumny ze stałej sklejanej `+`, więc supabase-js nie zna typu wiersza. */
type KeyPage<T> = PromiseLike<{ data: T[] | null; count?: number | null; error: { message: string } | null }>;

/** Kolejność w paczce jak przed odczytem po kluczu: data wystawienia, potem `id`. */
function byIssueDate<T extends { id: string; issue_date: string }>(rows: T[]): T[] {
  return rows.sort((a, b) =>
    a.issue_date < b.issue_date ? -1 : a.issue_date > b.issue_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/*
 * Odczyty paczki: komplet albo wyjątek (FZ-033, ten sam wzór co FZ-018). Serwer
 * ucina odpowiedź do 1000 wierszy bez błędu, a dokument zapisany w trakcie
 * budowania paczki przesuwał strony zakresów (wypadał z ZIP albo był w nim dwa
 * razy). Wiersze okresu idą stronami po `id` z licznikiem (`readCompletePagesByKey`),
 * pliki faktur (XML, UPO) paczkami `in()`, każda stronami po `id`
 * (`readAllByIdInList`); zmiana w trakcie daje wyjątek i ponowienie joba.
 * „Nie wiem, jakie pliki ma faktura” to nie „nie ma plików”: błąd odczytu rzuca.
 * Jedna funkcja na tabelę z nazwą tabeli wprost, bo niezmiennik NZ-WSP-08
 * (`tests/filtr/niezmienniki/strony.test.ts`) sprawdza każde zapytanie po nazwie.
 */

async function readPeriodInvoices(db: SupabaseClient, order: ArchiveOrderInput): Promise<InvoiceRow[]> {
  const rows = await readCompletePagesByKey<InvoiceRow>('invoices', ({ afterId, limit, count, head }) => {
    let query = db
      .from('invoices')
      .select(INVOICE_COLUMNS, count ? { count: 'exact', head } : undefined)
      .eq('tenant_id', order.tenantId)
      .gte('issue_date', order.periodStart)
      .lte('issue_date', order.periodEnd);
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit) as unknown as KeyPage<InvoiceRow>;
  });
  return byIssueDate(rows);
}

async function readPeriodExpenses(db: SupabaseClient, order: ArchiveOrderInput): Promise<ExpenseRow[]> {
  const rows = await readCompletePagesByKey<ExpenseRow>('expenses', ({ afterId, limit, count, head }) => {
    let query = db
      .from('expenses')
      .select(EXPENSE_COLUMNS, count ? { count: 'exact', head } : undefined)
      .eq('tenant_id', order.tenantId)
      .gte('issue_date', order.periodStart)
      .lte('issue_date', order.periodEnd);
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit) as unknown as KeyPage<ExpenseRow>;
  });
  return byIssueDate(rows);
}

async function readXmlDocuments(db: SupabaseClient, tenantId: string, ids: string[]): Promise<XmlDocRow[]> {
  return readAllByIdInList<XmlDocRow>('xml_documents', ids, (values, afterId, limit) => {
    let query = db.from('xml_documents').select(XML_DOC_COLUMNS).eq('tenant_id', tenantId).in('invoice_id', values);
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit) as unknown as KeyPage<XmlDocRow>;
  });
}

async function readUpoReceipts(db: SupabaseClient, tenantId: string, ids: string[]): Promise<UpoRow[]> {
  return readAllByIdInList<UpoRow>('upo_receipts', ids, (values, afterId, limit) => {
    let query = db.from('upo_receipts').select(UPO_COLUMNS).eq('tenant_id', tenantId).in('invoice_id', values);
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit) as unknown as KeyPage<UpoRow>;
  });
}

/** Brak obiektu w magazynie (S3/MinIO) albo pusta odpowiedź: to brak, a nie awaria. */
function isMissingObject(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number } } | null;
  if (!e) return false;
  if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.Code === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return message.startsWith('R2 object not found') || message.startsWith('R2: empty body') ||
    // Klucz zapisany przy wierszu wskazuje poza katalog firmy: pliku nie wydajemy.
    message === 'Storage path does not belong to this organization';
}

function isHashMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes('hash mismatch');
}

function isJpkRefusal(error: unknown): error is Error {
  return (
    error instanceof MissingTaxOfficeError ||
    error instanceof MissingIssuerAddressError ||
    error instanceof JpkFaCorrectionNotSupportedError ||
    error instanceof JpkFaForeignCurrencyNotSupportedError ||
    error instanceof JpkDocumentNotSupportedError ||
    error instanceof JpkSchemaError ||
    error instanceof OutgoingInvoiceCurrencyNotSupportedError ||
    error instanceof KsefExpenseCurrencyNotSupportedError
  );
}

/** Część nazwy pliku: tylko litery ASCII, cyfry, kropka i łącznik (bez ścieżek). */
function safePart(raw: string | null | undefined, fallback: string): string {
  const ascii = (raw ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');
  const cleaned = ascii.replace(/[^A-Za-z0-9.-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60);
  return cleaned || fallback;
}

function photoExtension(mime: string | null | undefined): string {
  const map: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  return map[(mime ?? '').toLowerCase()] ?? 'bin';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function partyField(party: unknown, field: 'name' | 'nip'): string {
  return party && typeof party === 'object' && !Array.isArray(party) ? text((party as Record<string, unknown>)[field]) : '';
}

/** Strona faktury, którą wydrukuje renderer PDF: nazwa i adres (`lib/pdf/invoice-renderer.ts`, bloki stron). */
function isPrintableParty(party: unknown): boolean {
  if (!party || typeof party !== 'object' || Array.isArray(party)) return false;
  const p = party as Record<string, unknown>;
  return text(p.name) !== '' && !!p.address && typeof p.address === 'object' && !Array.isArray(p.address);
}

/** FZ-032: wydruk PDF tylko faktury z danymi sprzedawcy i nabywcy. */
function hasPrintableParties(inv: { seller_data: unknown; buyer_data: unknown }): boolean {
  return isPrintableParty(inv.seller_data) && isPrintableParty(inv.buyer_data);
}

/** Komórka CSV (separator „;”): cudzysłów przy „;” i „"”, bez formuł arkusza. */
function cell(value: string): string {
  let v = value.replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t]/.test(v)) v = `'${v}`;
  return /[;"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function amount(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2).replace('.', ',') : '';
}

function csv(header: string[], rows: string[][]): Buffer {
  const lines = [header, ...rows].map((r) => r.join(';'));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

/** Spis bez długich myślników (komunikaty generatorów eksportu je mają). */
function plainText(line: string): string {
  return line.replace(/\s*[—–]\s*/g, ', ');
}

interface JpkPart {
  file?: PackagedFile;
  missing?: ArchiveMissing;
  note: string;
}

/** JPK_FA tą samą drogą co Centrum eksportu: dane, urząd, adres z GUS, generator, XSD. */
async function buildJpkFa(db: SupabaseClient, order: ArchiveOrderInput, nip: string): Promise<JpkPart> {
  const scope = exportScopeFor('jpk_fa');
  try {
    const data = await fetchInvoicesForExport({
      tenantId: order.tenantId,
      periodStart: order.periodStart,
      periodEnd: order.periodEnd,
      direction: scope.invoiceDirection,
      includeCorrections: scope.includeCorrections,
      includeExpenses: false,
    });
    if (data.issuedInvoices.length === 0) {
      return { note: 'JPK_FA: w tym okresie nie ma faktur sprzedaży przyjętych w KSeF, więc plik nie powstał.' };
    }
    const taxOfficeCode = await readTenantTaxOffice(db, order.tenantId);
    const registeredAddress = await readIssuerRegisteredAddress(data.issuer.nip);
    const xml = generateJpkFa({
      issuer: { ...data.issuer, taxOfficeCode: taxOfficeCode ?? undefined, registeredAddress: registeredAddress ?? undefined },
      periodStart: order.periodStart,
      periodEnd: order.periodEnd,
      issuedInvoices: data.issuedInvoices,
    });
    await assertJpkMatchesSchema('JPK_FA', xml);
    const filename = `JPK_FA_${nip}_${order.periodStart}_${order.periodEnd}.xml`;
    return {
      file: { filename, content: Buffer.from(xml, 'utf8') },
      note: `${filename}: JPK_FA z faktur sprzedaży przyjętych w KSeF w tym okresie (ten sam generator i ta sama kontrola schematu MF co eksport w FaktWay).`,
    };
  } catch (error) {
    if (!isJpkRefusal(error)) throw error;
    return {
      missing: { dokument: 'JPK_FA za okres', plik: 'JPK_FA', powod: error.message },
      note: 'JPK_FA: plik nie powstał, powód jest w części „Braki”.',
    };
  }
}

export async function buildArchivePackage(
  order: ArchiveOrderInput,
  options: { now?: Date; maxSourceBytes?: number } = {},
): Promise<BuiltArchive> {
  const now = options.now ?? new Date();
  const maxSourceBytes = options.maxSourceBytes ?? ARCHIVE_MAX_SOURCE_BYTES;
  const environment = requireConfiguredKsefEnvironment();
  const db = createAdminClient() as unknown as SupabaseClient;
  const { tenantId } = order;

  const { data: tenant, error: tenantError } = await db.from('tenants').select('nip, name').eq('id', tenantId).maybeSingle();
  if (tenantError || !tenant) throw new Error(`tenants: ${tenantError?.message ?? 'brak firmy'}`);
  const nip = safePart(text((tenant as { nip?: unknown }).nip).replace(/\D/g, ''), 'bez-NIP');
  const companyName = text((tenant as { name?: unknown }).name);

  const [invoices, expenses] = await Promise.all([
    readPeriodInvoices(db, order),
    readPeriodExpenses(db, order),
  ]);
  const listed = invoices.filter((inv) => inv.ksef_status !== 'draft');
  const documents = listed.filter((inv) => !inv.ksef_environment || inv.ksef_environment === environment);
  const otherEnvironment = listed.length - documents.length;
  const ids = documents.map((inv) => inv.id);
  const [xmlDocs, upos] = await Promise.all([
    readXmlDocuments(db, tenantId, ids),
    readUpoReceipts(db, tenantId, ids),
  ]);
  const hashes = new Map(xmlDocs.map((d) => [`${d.invoice_id}|${d.storage_path}`, d.sha256_hash]));
  const uposByInvoice = new Map<string, UpoRow[]>();
  for (const upo of [...upos].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))) {
    uposByInvoice.set(upo.invoice_id, [...(uposByInvoice.get(upo.invoice_id) ?? []), upo]);
  }

  const files: PackagedFile[] = [];
  const missing: ArchiveMissing[] = [];
  const usedNames = new Set<string>();
  let sourceBytes = 0;
  const add = (filename: string, content: Buffer) => {
    sourceBytes += content.length;
    if (sourceBytes > maxSourceBytes) throw new ArchiveTooLargeError();
    files.push({ filename, content });
  };
  const reserve = (folder: string, base: string, suffixes: string[]): string => {
    let candidate = base;
    for (let n = 2; suffixes.some((s) => usedNames.has(`${folder}/${candidate}${s}`)); n++) candidate = `${base}_${n}`;
    for (const s of suffixes) usedNames.add(`${folder}/${candidate}${s}`);
    return candidate;
  };

  const invoiceRows: string[][] = [];
  let salesCount = 0;
  let purchaseCount = 0;
  for (const inv of documents) {
    const sale = inv.direction === 'outgoing';
    const folder = sale ? 'faktury-sprzedazy' : 'faktury-zakupu';
    const number = inv.internal_number?.trim() || inv.ksef_number?.trim() || inv.id.slice(0, 8);
    const party = sale ? inv.buyer_data : inv.seller_data;
    const partyNip = (sale ? inv.buyer_nip : inv.seller_nip)?.trim() || partyField(party, 'nip');
    const label = sale ? `Faktura sprzedaży ${number}` : `Faktura zakupu ${number}${partyNip ? ` (NIP ${partyNip})` : ''}`;
    const inKsef = inv.ksef_status === 'accepted' || (!sale && inv.ksef_status === 'received');
    // D25 b: faktura wystawiona poza KSeF nie ma XML ani UPO z KSeF (i nie będzie ich mieć); jej plikiem jest wydruk FaktWay i oryginał PDF klienta, jeśli go wgrał.
    const outsideKsef = inv.origin === 'outside_ksef';
    const included: string[] = [];
    let incomplete = false;

    if (!inKsef) {
      missing.push({ dokument: label, plik: 'pliki z KSeF', powod: notInKsefReason(inv.ksef_status) });
      incomplete = true;
    } else {
      if (sale) salesCount++;
      else purchaseCount++;
      const base = reserve(folder, `${inv.issue_date}_${sale ? '' : `${safePart(partyNip, 'bez-NIP')}_`}${safePart(number, inv.id.slice(0, 8))}`, ['.xml', '.pdf', '.upo.xml', '.oryginal.pdf']);

      const hash = inv.xml_storage_path ? hashes.get(`${inv.id}|${inv.xml_storage_path}`) : null;
      if (outsideKsef) {
        // bez XML z KSeF
      } else if (!inv.xml_storage_path) missing.push({ dokument: label, plik: 'XML z KSeF', powod: XML_NO_FILE });
      else if (!hash) missing.push({ dokument: label, plik: 'XML z KSeF', powod: XML_NO_HASH });
      else {
        try {
          add(`${folder}/${base}.xml`, Buffer.from(await downloadInvoiceXml(inv.xml_storage_path, hash, tenantId), 'utf8'));
          included.push('XML');
        } catch (error) {
          if (isMissingObject(error)) missing.push({ dokument: label, plik: 'XML z KSeF', powod: XML_MISSING });
          else if (isHashMismatch(error)) missing.push({ dokument: label, plik: 'XML z KSeF', powod: XML_HASH_MISMATCH });
          else throw error;
        }
      }

      // FZ-032: wydruk tylko faktury z danymi sprzedawcy i nabywcy. Faktura zakupu ze
      // Skrzynki KSeF ma w wierszu same metadane (`inbox-polling` nie zapisuje stron),
      // a renderer czyta strony wprost, więc dotąd jedna taka faktura kończyła całą
      // paczkę błędem. Teraz brak PDF idzie do spisu z powodem, a XML z KSeF zostaje.
      // Inny rzut renderera (np. brak danych płatności) też nie kończy paczki: wydruk
      // to wizualizacja, a oryginał (XML z KSeF) zostaje.
      if (!hasPrintableParties(inv)) {
        missing.push({ dokument: label, plik: 'PDF', powod: PDF_NO_PARTIES });
      } else {
        let pdf: Awaited<ReturnType<typeof generateInvoicePdf>> | null = null;
        try {
          pdf = await generateInvoicePdf(inv.id, tenantId);
        } catch (error) {
          console.error('[archiwum] wydruk PDF faktury', inv.id, error instanceof Error ? error.message : error);
          missing.push({ dokument: label, plik: 'PDF', powod: PDF_FAILED });
        }
        if (pdf?.success) {
          add(`${folder}/${base}.pdf`, pdf.pdf);
          included.push('PDF');
        } else if (pdf) {
          missing.push({ dokument: label, plik: 'PDF', powod: pdf.error });
        }
      }

      if (outsideKsef && inv.outside_ksef_original_path) {
        try {
          add(`${folder}/${base}.oryginal.pdf`, await pobierzOryginalSpozaKsef(tenantId, inv.outside_ksef_original_path));
          included.push('oryginał PDF');
        } catch (error) {
          if (!isMissingObject(error)) throw error;
          missing.push({ dokument: label, plik: 'oryginał PDF', powod: ORIGINAL_MISSING });
        }
      }

      if (sale && !outsideKsef) {
        const upo = (uposByInvoice.get(inv.id) ?? []).find((u) => (u.status === 'downloaded' || u.status === 'archived') && u.upo_xml_path);
        if (!upo?.upo_xml_path) {
          missing.push({ dokument: label, plik: 'UPO', powod: inv.origin === 'ksef_import' ? UPO_FOREIGN : UPO_NOT_YET });
        } else {
          try {
            add(`${folder}/${base}.upo.xml`, await downloadFromR2(upo.upo_xml_path, tenantId));
            included.push('UPO');
          } catch (error) {
            if (!isMissingObject(error)) throw error;
            missing.push({ dokument: label, plik: 'UPO', powod: UPO_MISSING });
          }
        }
      }
      incomplete = included.length < (outsideKsef ? 1 : sale ? 3 : 2);
    }

    invoiceRows.push([
      sale ? 'sprzedaż' : 'zakup',
      cell(number),
      cell(inv.ksef_number ?? ''),
      cell(inv.issue_date),
      cell(inv.sale_date ?? ''),
      cell(inv.payment_due_date ?? ''),
      cell(partyField(party, 'name')),
      cell(partyNip),
      amount(inv.net_total),
      amount(inv.vat_total),
      amount(inv.gross_total),
      cell(inv.currency ?? ''),
      cell(outsideKsef ? 'wystawiona poza KSeF' : (STATUS_LABELS[inv.ksef_status ?? ''] ?? 'nieznany')),
      cell(`${included.join(', ') || 'brak'}${incomplete ? ' (braki w CO-JEST-W-PACZCE.txt)' : ''}`),
    ]);
  }

  const expenseRows: string[][] = [];
  let photoCount = 0;
  for (const exp of expenses) {
    const number = exp.document_number?.trim() || exp.id.slice(0, 8);
    const label = `Koszt ${number} z ${archivePlDate(exp.issue_date)} (${text(exp.seller_name) || 'bez sprzedawcy'})`;
    let where: string;
    if (exp.source_file_path) {
      try {
        const photo = await downloadExpensePhoto(exp.source_file_path, tenantId);
        const ext = `.${photoExtension(exp.source_file_mime ?? photo.mimeType)}`;
        const base = reserve('koszty', `${exp.issue_date}_${safePart(number, exp.id.slice(0, 8))}`, [ext]);
        where = `koszty/${base}${ext}`;
        add(where, photo.buffer);
        photoCount++;
      } catch (error) {
        if (!isMissingObject(error)) throw error;
        missing.push({ dokument: label, plik: 'zdjęcie dokumentu', powod: PHOTO_MISSING });
        where = 'brak (CO-JEST-W-PACZCE.txt)';
      }
    } else if (exp.source === 'ksef_inbox' || exp.ksef_invoice_id) {
      where = 'faktura z KSeF w folderze faktury-zakupu';
    } else {
      missing.push({ dokument: label, plik: 'zdjęcie dokumentu', powod: PHOTO_NONE });
      where = 'brak (CO-JEST-W-PACZCE.txt)';
    }
    expenseRows.push([
      cell(exp.issue_date),
      cell(number),
      cell(DOCUMENT_TYPE_LABELS[exp.document_type ?? ''] ?? text(exp.document_type)),
      cell(text(exp.seller_name)),
      cell(text(exp.seller_nip)),
      amount(exp.net_amount),
      amount(exp.vat_amount),
      amount(exp.gross_amount),
      cell(where),
    ]);
  }

  const audit = order.kind === 'audit';
  const jpk = audit ? await buildJpkFa(db, order, nip) : null;
  if (jpk?.file) add(jpk.file.filename, jpk.file.content);
  if (jpk?.missing) missing.push(jpk.missing);
  const filesCount = files.length;

  const lines: string[] = [
    audit ? 'FaktWay: paczka na kontrolę' : 'FaktWay: archiwum dokumentów firmy',
    '',
    `Firma: ${companyName || 'bez nazwy'}, NIP ${nip}`,
    `Okres: od ${archivePlDate(order.periodStart)} do ${archivePlDate(order.periodEnd)}`,
    `Utworzono: ${formatWarsawDateTime(now.toISOString())} (czas polski)`,
    `Środowisko KSeF: ${environment === 'production' ? 'produkcyjne' : 'testowe (dokumenty bez mocy prawnej)'}`,
    '',
    'Co jest w paczce',
    `- faktury-sprzedazy: faktury sprzedaży (${salesCount}), każda jako plik XML z KSeF, wydruk PDF i UPO (urzędowe poświadczenie odbioru z KSeF)`,
    `- faktury-zakupu: faktury zakupu (${purchaseCount}), każda jako plik XML z KSeF i wydruk PDF`,
    `- koszty: zdjęcia i pliki dokumentów kosztowych (${photoCount})`,
    '- faktury.csv: lista faktur (numer, numer KSeF, daty, kontrahent, kwoty, status, pliki w paczce)',
    '- koszty.csv: lista kosztów z plikiem dokumentu',
    ...(jpk?.file ? [`- ${jpk.file.filename}: JPK_FA za okres`] : []),
    `Plików dokumentów w paczce: ${filesCount}.`,
    '',
    'Oryginałem faktury z KSeF jest plik XML. PDF to wydruk z danych zapisanych w FaktWay.',
    'Szkice faktur nie wchodzą do paczki.',
    ...(otherEnvironment > 0 ? [`Faktury z innego środowiska KSeF nie wchodzą do paczki (pominięte: ${otherEnvironment}).`] : []),
    ...(jpk ? ['', 'Pliki JPK', jpk.note, JPK_LATER] : []),
    '',
    ...(missing.length === 0
      ? ['Braki: nie ma. Każdy dokument z okresu ma swoje pliki.']
      : [`Braki (${missing.length})`, ...missing.map((m) => `- ${m.dokument}, ${m.plik}: ${m.powod}`)]),
  ];

  const zip = await packageZip([
    ...files,
    {
      filename: 'faktury.csv',
      content: csv(
        ['Rodzaj', 'Numer', 'Numer KSeF', 'Data wystawienia', 'Data sprzedaży', 'Termin płatności', 'Kontrahent', 'NIP kontrahenta', 'Netto', 'VAT', 'Brutto', 'Waluta', 'Status', 'Pliki w paczce'],
        invoiceRows,
      ),
    },
    {
      filename: 'koszty.csv',
      content: csv(['Data', 'Numer dokumentu', 'Rodzaj dokumentu', 'Sprzedawca', 'NIP sprzedawcy', 'Netto', 'VAT', 'Brutto', 'Plik w paczce'], expenseRows),
    },
    { filename: 'CO-JEST-W-PACZCE.txt', content: Buffer.from(`${lines.map(plainText).join('\r\n')}\r\n`, 'utf8') },
  ]);

  return {
    fileName: `${audit ? 'Kontrola' : 'Archiwum'}_${nip}_${order.periodStart}_${order.periodEnd}.zip`,
    zip,
    filesCount,
    missing,
  };
}
