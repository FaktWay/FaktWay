import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  s3TimeoutConfig,
  storageTimeouts,
  uploadRequestOptions,
  withStorageTimeoutErrors,
  type StorageTimeouts,
} from './s3-timeouts';

let cachedClient: S3Client | null = null;
let cachedClientTimeouts: StorageTimeouts | null = null;

/**
 * Klient archiwum z limitami czasu i liczbą prób z profilu procesu
 * (`./s3-timeouts.ts`, LIM-05); nowy, gdy profil się zmieni (start workera).
 */
function getGlacierClient(): S3Client {
  const timeouts = storageTimeouts();
  if (cachedClient && cachedClientTimeouts === timeouts) return cachedClient;

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION ?? 'eu-central-1';

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials missing');
  }

  cachedClient = withStorageTimeoutErrors(
    new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...s3TimeoutConfig(timeouts),
    }),
  );
  cachedClientTimeouts = timeouts;
  return cachedClient;
}

function getArchiveBucket(): string {
  const bucket =
    process.env.AWS_ARCHIVE_BUCKET ?? process.env.AWS_GLACIER_BUCKET;
  if (!bucket) {
    throw new Error(
      'AWS_ARCHIVE_BUCKET or AWS_GLACIER_BUCKET must be set for Glacier uploads'
    );
  }
  return bucket;
}

/**
 * Uploaduje XML do S3 Glacier Deep Archive.
 * Zwraca klucz obiektu (path) zapisany potem w `invoices.archive_storage_path`.
 */
export async function uploadToGlacier(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
  xmlContent: string
): Promise<string> {
  const dateStr = issueDate.slice(0, 10);
  const [year, month] = dateStr.split('-');
  if (!year || !month) {
    throw new Error(`Invalid issue_date for Glacier key: ${issueDate}`);
  }
  const key = `${tenantId}/${year}/${month}/${invoiceId}.xml`;
  const body = Buffer.from(xmlContent, 'utf8');

  await getGlacierClient().send(
    new PutObjectCommand({
      Bucket: getArchiveBucket(),
      Key: key,
      Body: body,
      ContentType: 'application/xml',
      StorageClass: 'DEEP_ARCHIVE',
    }),
    uploadRequestOptions(body.length),
  );

  return key;
}

/**
 * Usuwa kopię z archiwum — po upływie retencji (AUD-45). Brak obiektu to
 * nie błąd (S3 odpowiada sukcesem), więc ponowienie jest bezpieczne.
 */
export async function deleteFromGlacier(key: string): Promise<void> {
  await getGlacierClient().send(
    new DeleteObjectCommand({ Bucket: getArchiveBucket(), Key: key }),
  );
}
