import type { SupabaseClient } from '@supabase/supabase-js';

import type { CorrectionInvoiceData } from '@/types/invoice-types';

type Annotations = NonNullable<CorrectionInvoiceData['annotations']>;

/** P_16 i P_18A (zawsze) oraz podstawa zwolnienia, gdy faktura korygowana ją ma (C3). */
export type ParentCorrectionAnnotations = Required<Pick<Annotations, 'cashMethod' | 'splitPayment'>> &
  Pick<Annotations, 'vatExemptionBasis' | 'vatExemptionBasisKind'>;

const BASIS_KINDS: ReadonlySet<string> = new Set(['P_19A', 'P_19B', 'P_19C']);

/**
 * Adnotacje P_16 (metoda kasowa) i P_18A (MPP) z `fa3_data` faktury
 * pierwotnej — korekta je przejmuje (AUD-23). Tylko 1 albo 2; cokolwiek
 * innego (brak, stary zapis) = 2, jak dotąd.
 *
 * Plan zero C3: podstawa zwolnienia z VAT (`annotations.vatExemptionBasis`,
 * faktura FaktWay ze stawką „zw” i faktura z pliku KSeF, C5b) i jej rodzaj
 * (`vatExemptionBasisKind`, tylko P_19A, P_19B albo P_19C) idą do korekty, bo
 * pozycja „zw” korekty wymaga bloku Zwolnienie z tą samą podstawą. Pusty
 * albo nienapisowy zapis = brak (generator odmówi korekty „zw” z wyjściem).
 */
export function parentAnnotationsForCorrection(fa3Data: unknown): ParentCorrectionAnnotations {
  const raw =
    fa3Data && typeof fa3Data === 'object'
      ? ((fa3Data as { annotations?: unknown }).annotations as Record<string, unknown> | undefined)
      : undefined;
  const basis = typeof raw?.vatExemptionBasis === 'string' ? raw.vatExemptionBasis.trim() : '';
  const kind = typeof raw?.vatExemptionBasisKind === 'string' && BASIS_KINDS.has(raw.vatExemptionBasisKind)
    ? (raw.vatExemptionBasisKind as NonNullable<Annotations['vatExemptionBasisKind']>)
    : undefined;
  return {
    cashMethod: raw?.cashMethod === 1 ? 1 : 2,
    splitPayment: raw?.splitPayment === 1 ? 1 : 2,
    ...(basis ? { vatExemptionBasis: basis } : {}),
    ...(basis && kind ? { vatExemptionBasisKind: kind } : {}),
  };
}

/** Odczyt adnotacji faktury pierwotnej tej samej firmy. Błąd odczytu rzuca. */
export async function loadParentAnnotations(
  supabase: SupabaseClient,
  tenantId: string,
  parentInvoiceId: string,
): Promise<ParentCorrectionAnnotations> {
  const { data, error } = await supabase
    .from('invoices')
    .select('fa3_data')
    .eq('id', parentInvoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Nie można odczytać faktury korygowanej: ${error.message}`);
  return parentAnnotationsForCorrection((data as { fa3_data?: unknown } | null)?.fa3_data);
}
