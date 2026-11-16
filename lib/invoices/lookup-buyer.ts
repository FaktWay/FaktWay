import 'server-only';

import { lookupCompanyByNip } from '@/lib/gus/client';
import type { createClient } from '@/lib/supabase/server';
import { validateNipChecksum } from '@/lib/xml/invoice-calculator';

/**
 * Nabywca po NIP: najpierw kontrahenci firmy, potem GUS (REGON), z zapisem
 * podpowiedzi w `contractors` (plan aplikacji mobilnej, etap M8b). Do M8b ta
 * logika siedziała w `lookupBuyerAction` (`components/invoices/actions.ts`);
 * teraz formularz strony i trasa telefonu wołają tę samą funkcję. Wołający
 * podaje sesję i firmę leniwie, po sprawdzeniu NIP, jak przed wydzieleniem.
 */

type SessionDb = Awaited<ReturnType<typeof createClient>>;

// ═══════════════════════════════════════════════════════════════
// lookupBuyerAction - cache kontrahentów + GUS fallback
// ═══════════════════════════════════════════════════════════════

export type LookupBuyerResult =
  | {
      success: true;
      source: 'cache' | 'gus';
      data: {
        nip: string;
        name: string;
        addressLine1: string;
        addressLine2: string;
      };
    }
  /** `reason` (M8b, telefon): rodzaj odmowy bez czytania zdania; strona go nie używa. */
  | { success: false; error: string; reason?: 'nip' | 'not_found' | 'unavailable' | 'context' };

interface ContractorAddress {
  countryCode?: string;
  addressLine1?: string;
  addressLine2?: string;
}

export async function lookupBuyer(
  context: () => Promise<{ supabase: SessionDb; tenantId: string }>,
  nip: string
): Promise<LookupBuyerResult> {
  if (!/^\d{10}$/.test(nip)) {
    return { success: false, error: 'NIP musi zawierać 10 cyfr', reason: 'nip' };
  }
  if (!validateNipChecksum(nip)) {
    return { success: false, error: 'Nieprawidłowa suma kontrolna NIP', reason: 'nip' };
  }

  let supabase: SessionDb;
  let tenantId: string;
  try {
    const ctx = await context();
    supabase = ctx.supabase;
    tenantId = ctx.tenantId;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Brak kontekstu tenanta',
      reason: 'context',
    };
  }

  // 1) Cache - lokalna tabela `contractors` (per tenant).
  const { data: cached } = await supabase
    .from('contractors')
    .select('nip, name, address')
    .eq('tenant_id', tenantId)
    .eq('nip', nip)
    .maybeSingle();

  if (cached) {
    const addr = (cached.address as ContractorAddress | null) ?? {};
    // Update last_used_at żeby rozpinać "ostatnio używane" w przyszłym UI.
    await supabase
      .from('contractors')
      .update({ last_used_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .eq('nip', nip);

    return {
      success: true,
      source: 'cache',
      data: {
        nip: cached.nip as string,
        name: cached.name as string,
        addressLine1: addr.addressLine1 ?? '',
        addressLine2: addr.addressLine2 ?? '',
      },
    };
  }

  // 2) Fallback: GUS REGON.
  const gus = await lookupCompanyByNip(nip);
  if (gus.kind === 'not-found') {
    return {
      success: false,
      error: 'Nie znaleziono firmy w GUS. Sprawdź numer NIP.',
      reason: 'not_found',
    };
  }
  if (gus.kind === 'error') {
    return {
      success: false,
      error:
        'GUS chwilowo niedostępny. Spróbuj ponownie za chwilę lub uzupełnij dane ręcznie.',
      reason: 'unavailable',
    };
  }

  const addressLine1 = `${gus.data.street} ${gus.data.buildingNumber}${
    gus.data.localNumber ? '/' + gus.data.localNumber : ''
  }`.trim();
  const addressLine2 = `${gus.data.postalCode} ${gus.data.city}`.trim();

  // Zapisz w cache (upsert po unique (tenant_id, nip)). Używamy fire-and-forget
  // bez przerywania flow jeśli cache padnie - user i tak dostanie dane.
  await supabase.from('contractors').upsert(
    {
      tenant_id: tenantId,
      nip: gus.data.nip,
      name: gus.data.name,
      address: {
        countryCode: 'PL',
        addressLine1,
        addressLine2,
      },
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,nip' }
  );

  return {
    success: true,
    source: 'gus',
    data: {
      nip: gus.data.nip,
      name: gus.data.name,
      addressLine1,
      addressLine2,
    },
  };
}

