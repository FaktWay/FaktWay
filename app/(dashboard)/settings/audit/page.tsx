import { FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { auditActionLabel, auditResourceLabel } from '@/lib/audit/labels';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { createClient } from '@/lib/supabase/server';

import { AuditLog, type AuditLogEntry } from './_components/audit-log';

/**
 * Zakładka „Dziennik zdarzeń” (plan P14, bez odpowiednika w Finorze):
 * ostatnie 200 wpisów `audit_logs` czytanych klientem z sesji (RLS).
 */
export default async function AuditPage() {
  const supabase = await createClient();
  const { data: logs, error } = await supabase
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  const entries: AuditLogEntry[] = (logs ?? []).map((log) => ({
    id: String(log.id),
    when: formatWarsawDateTime(log.created_at as string),
    action: auditActionLabel(String(log.action)),
    resource: auditResourceLabel(log.entity_type as string | null, log.entity_id as string | null) ?? '—',
    ip: log.ip_address != null ? String(log.ip_address) : '—',
  }));

  return (
    <FieldGroup>
      <div>
        <FieldLabel>Historia aktywności</FieldLabel>
        <FieldDescription>Pełny audit trail Twojego konta — RODO zgodność</FieldDescription>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Nie udało się wczytać historii: {error.message}</AlertDescription>
        </Alert>
      ) : (
        <AuditLog entries={entries} />
      )}
    </FieldGroup>
  );
}
