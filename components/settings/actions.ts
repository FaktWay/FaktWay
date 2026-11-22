'use server';

import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import {
  uploadKsefCertificate,
  type ConnectFailureReason,
  type UploadCertificateResult,
} from '@/lib/ksef/upload-certificate';
import { describeFailureForLog } from '@/lib/ksef/connect-messages';
import { ActionAuthError, requireOwner } from '@/lib/supabase/auth-context';
import { revalidatePath } from 'next/cache';

export type { ConnectFailureReason, UploadCertificateResult };

const GENERIC_ERROR =
  'Nie udało się bezpiecznie zapisać certyfikatu. Spróbuj później lub skontaktuj się z obsługą.';

function fail(reason: ConnectFailureReason, error: string): UploadCertificateResult {
  return { success: false, reason, error };
}

/**
 * Podłączenie i aktualizacja certyfikatu KSeF z kreatora strony. Pliki,
 * limit, KSeF i zapis: `lib/ksef/upload-certificate.ts` (ta sama logika dla
 * telefonu, M10c). Tu tylko bramka: właściciel i zweryfikowane 2FA.
 */
export async function uploadCertificateAction(data: {
  /** Plik certyfikatu (.crt), bajty w base64. */
  certificate: string;
  /** Plik klucza prywatnego (.key), bajty w base64. */
  privateKey: string;
  /** Hasło do klucza, tylko gdy klucz jest zaszyfrowany. Nigdzie nie jest zapisywane. */
  password?: string;
}): Promise<UploadCertificateResult> {
  try {
    // A Server Action can be POSTed directly. The page layout is not its guard.
    const { supabase, tenantId, user } = await requireOwner();
    const mfa = await getVerifiedMfaState(supabase).catch(() => null);
    if (mfa?.status === 'challenge_required' && mfa.user.id === user.id) {
      return {
        success: false,
        reason: 'mfa_required',
        mfaStepUp: true,
        error: 'Zmiana certyfikatu KSeF wymaga potwierdzenia kodem z aplikacji.',
      };
    }
    if (!mfa || mfa.status !== 'verified' || mfa.user.id !== user.id) {
      return fail('mfa_required', 'Przed zmianą certyfikatu KSeF włącz i potwierdź logowanie dwuetapowe.');
    }

    const result = await uploadKsefCertificate({ supabase, tenantId, userId: user.id }, data);
    if (result.success) revalidatePath('/settings/ksef');
    return result;
  } catch (error) {
    if (error instanceof ActionAuthError) return fail('forbidden', error.message);
    console.error('[uploadCertificateAction] nie udało się podłączyć KSeF', { stage: 'unexpected', reason: 'save_failed', ...describeFailureForLog(error) });
    return fail('save_failed', GENERIC_ERROR);
  }
}
