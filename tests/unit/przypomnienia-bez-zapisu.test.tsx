import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/actions/reminders', () => ({ updateReminderSettingsAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReminderSettingsForm } from '@/components/reminders/reminder-settings-form';
import { reminderSettingsFromRow } from '@/lib/reminders/settings-model';

/**
 * Plan aplikacji mobilnej, M10b, „zostaje” (4), naprawione w M10c: firma bez
 * zapisanych ustawień przypomnień (brak wiersza `reminder_settings`) nie ma
 * przypomnień, bo scheduler bierze tylko wiersze z `enabled = true`
 * (`lib/jobs/runners/reminder-scheduler.ts`). Formularz strony pokazywał wtedy
 * „Flo pilnuje terminów” i włączony przełącznik, czyli coś, co nie działa.
 * Teraz pokazuje stan prawdziwy (wyłączone); reszta pól to nadal propozycja,
 * którą zapis włącza. Telefon mówi to samo (`zapisane: false`, `wlaczone: false`).
 */

describe('ustawienia przypomnień bez zapisu', () => {
  it('model: bez wiersza przypomnienia są wyłączone, etapy i godzina zostają propozycją', () => {
    const s = reminderSettingsFromRow(null, 'Pracownia Testowa');
    expect(s.enabled).toBe(false);
    expect(s).toMatchObject({ stage_1_enabled: true, stage_1_days_after_due: 3, send_hour: 9, sender_name: 'Pracownia Testowa' });
  });

  it('formularz strony bez wiersza: „nie pilnuje terminów”, przełącznik wyłączony', () => {
    const html = renderToStaticMarkup(<ReminderSettingsForm initialSettings={null} tenantName="Pracownia Testowa" />);
    expect(html).toContain('Flo nie pilnuje terminów');
    expect(html).not.toContain('Flo pilnuje terminów');
  });

  it('zapisany wiersz z `enabled = true` dalej pokazuje „pilnuje terminów”', () => {
    const row = {
      id: 'r', tenant_id: 't', enabled: true,
      stage_1_enabled: true, stage_1_days_after_due: 3, stage_2_enabled: true, stage_2_days_after_due: 7,
      stage_3_enabled: true, stage_3_days_after_due: 14, sender_name: null, sender_email: null, reply_to_email: null,
      pause_on_reply: true, pause_on_partial_payment: true, send_on_weekdays_only: true, send_hour: 9,
      max_reminders_per_invoice: 3, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    };
    const html = renderToStaticMarkup(<ReminderSettingsForm initialSettings={row as never} tenantName="Pracownia Testowa" />);
    expect(html).toContain('Flo pilnuje terminów');
  });
});
