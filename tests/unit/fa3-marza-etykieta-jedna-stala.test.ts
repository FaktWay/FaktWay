/**
 * D12 (plan kompletnej aplikacji): tekst odmowy JPK przy procedurze marży to ta sama
 * stała co na PDF faktury (`MARGIN_SCHEME_LABELS`), bez długiego myślnika.
 */
import { describe, expect, it } from 'vitest';

import { MARGIN_SCHEME_LABELS } from '@/lib/invoices/annotations';
import { annotationsJpkCannotExpress } from '@/lib/xml/fa3-annotations';

describe('etykieta procedury marży w odmowie JPK', () => {
  it.each(Object.entries(MARGIN_SCHEME_LABELS))('%s: tekst równy stałej i bez długiego myślnika', (marker, label) => {
    const out = annotationsJpkCannotExpress({ marginScheme: marker });
    expect(out).toEqual([label]);
    expect(out[0]).not.toMatch(/[—–]/);
  });
});
