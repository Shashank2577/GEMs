import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractPages } from '../../src/analyse/pdf-text';
import { ANNEXURE_KEYS } from '../../src/analyse/checklist';
import {
  BLANK, SYSTEM_TEMPLATES, SYSTEM_TEMPLATE_BY_KEY, TEMPLATE_KEYS, TEMPLATE_PLACEHOLDERS, buildTemplateContext, missingPlaceholders, normalizeTemplateKey,
  placeholdersOf, renderAnnexurePdf, renderTemplate, unknownPlaceholderMessage, unknownPlaceholders, type TemplateContext,
} from '../../src/packet/templates';

const now = new Date('2026-11-04T06:00:00Z');
const company = {
  legalName: 'Sharma Infotech Private Limited', gstin: '27AABCS1234F1Z5', pan: 'AABCS1234F', address: '12, MIDC Andheri East, Mumbai',
  state: 'Maharashtra', pincode: '400093', udyamNumber: 'UDYAM-MH-19-0012345', mseCategory: 'small', mseSocialCategory: 'general',
  miiClass: 'class_1', localContentPct: 62.5, signatoryName: 'Rohit Sharma', signatoryDesignation: 'Director',
  contactEmail: 'bids@sharmainfotech.in', contactPhone: '+919812345678', oemAuthorizations: [{ oem: 'Dell', products: 'Laptops and desktops' }],
};
const tender = {
  bidNumber: 'GEM/2026/B/1234567', title: 'Supply of Laptops (Q2)', organisation: 'Indian Oil Corporation Ltd', ministry: 'Ministry of Petroleum',
  buyerOffice: 'Refinery HQ, Panipat', endAt: '2026-11-20T09:30:00Z', emdAmount: 150000, quantity: 40, items: [{ name: 'Laptop i5 16GB', quantity: 40, unit: 'nos' }],
};

describe('template catalog', () => {
  it('covers every annexure key the analyse checklist emits, plus the cover letter', () => {
    for (const k of Object.values(ANNEXURE_KEYS)) expect(SYSTEM_TEMPLATE_BY_KEY.has(k)).toBe(true);
    expect(TEMPLATE_KEYS).toContain('bid_cover_letter');
    expect(SYSTEM_TEMPLATES).toHaveLength(8);
  });

  it('accepts the long-form aliases', () => {
    expect(normalizeTemplateKey('mii_self_certificate')).toBe('mii_self_cert');
    expect(normalizeTemplateKey('OEM_AUTHORIZATION_REQUEST')).toBe('oem_auth_request');
    expect(normalizeTemplateKey('nope')).toBeNull();
  });

  it('only uses placeholders the context provides', () => {
    const ctx = buildTemplateContext({ company, tender, now, offer: { model: 'Latitude 5450', delivery_period_days: '30', warranty_months: '36' } });
    for (const t of SYSTEM_TEMPLATES) {
      for (const p of placeholdersOf(t.body)) expect(p, `${t.key}: ${p}`).toMatch(/^(company|signatory|tender|oem|offer|emd)\.\w+$|^(date|place)$/);
      expect(missingPlaceholders(t.body, ctx), t.key).toEqual(t.key === 'authority_letter' ? ['company.cin'] : []);
    }
  });
});

describe('renderTemplate', () => {
  it('fills nested placeholders and blanks missing ones', () => {
    const ctx = buildTemplateContext({ company, tender, now });
    expect(renderTemplate('{{ company.legalName }} / {{tender.bidNumber}} / {{nope.x}} / {{company.cin}}', ctx))
      .toBe(`Sharma Infotech Private Limited / GEM/2026/B/1234567 / ${BLANK} / ${BLANK}`);
  });

  it('formats Indian context values', () => {
    const ctx = buildTemplateContext({ company, tender, now });
    const out = renderTemplate('{{company.miiClass}}|{{company.localContentPct}}|{{company.mseCategory}}|{{tender.emdAmount}}|{{date}}|{{tender.endDate}}|{{emd.basis}}', ctx);
    expect(out).toContain("'Class-I local supplier'");
    expect(out).toContain('|62.5|Small|');
    expect(out).toContain('₹1.5 L (Rs. 1,50,000)');
    expect(out).toContain('|04-11-2026|');
    expect(out).toContain('20 Nov 2026, 3:00 PM IST');
    expect(out).toContain('Udyam Registration No. UDYAM-MH-19-0012345');
  });

  it('derives the startup basis when the company is not an MSE', () => {
    const ctx = buildTemplateContext({ company: { legalName: 'X', isStartup: true, dpiitNumber: 'DIPP12345' }, tender, now });
    expect(renderTemplate('{{emd.basis}}', ctx)).toMatch(/DPIIT \(Certificate No\. DIPP12345\)/);
  });
});

describe('renderAnnexurePdf', () => {
  it('renders every system template to a readable PDF with letterhead and signature block', async () => {
    const ctx = buildTemplateContext({ company, tender, now });
    for (const t of SYSTEM_TEMPLATES) {
      const bytes = await renderAnnexurePdf(t.title, t.body, ctx, { signatureRole: t.signatureRole });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
      const text = (await extractPages(bytes)).join('\n');
      expect(text).toContain('SHARMA INFOTECH PRIVATE LIMITED');
      expect(text).toContain('GSTIN: 27AABCS1234F1Z5');
      expect(text).toContain('GEM/2026/B/1234567');
      expect(text).toContain('(Seal & Signature)');
      expect(text).toContain('Rohit Sharma');
    }
  });

  it('sets document metadata Title / Author / Creator (FR-044)', async () => {
    const ctx = buildTemplateContext({ company, tender, now });
    const doc = await PDFDocument.load(await renderAnnexurePdf('Authority Letter', 'Body.', ctx));
    expect(doc.getTitle()).toBe('Authority Letter — GEM/2026/B/1234567');
    expect(doc.getAuthor()).toBe('Sharma Infotech Private Limited');
    expect(doc.getCreator()).toBe('TenderPilot');
  });

  it('replaces ₹ and drops characters the PDF font cannot draw instead of throwing', async () => {
    const ctx = buildTemplateContext({ company: { ...company, legalName: 'शर्मा Sharma Traders' }, tender, now });
    const bytes = await renderAnnexurePdf('Test', 'Amount ₹ 5,000 — “quoted” → ok\n\n1. first\n2. second', ctx);
    const text = (await extractPages(bytes)).join('\n');
    expect(text).toContain('Rs. 5,000');
    expect(text).toContain('SHARMA TRADERS');
  });

  it('flows long bodies onto further pages', async () => {
    const ctx = buildTemplateContext({ company, tender, now });
    const body = Array.from({ length: 60 }, (_, i) => `${i + 1}. Clause number ${i + 1} of a very long undertaking that keeps going for a while.`).join('\n');
    const doc = await PDFDocument.load(await renderAnnexurePdf('Long', body, ctx));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

describe('supported placeholders (FR-041)', () => {
  const leaves = (ctx: TemplateContext, prefix = ''): string[] =>
    Object.entries(ctx).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : leaves(v, `${prefix}${k}.`)));

  it('lists exactly the context paths buildTemplateContext produces, each with a label', () => {
    const paths = leaves(buildTemplateContext({ company: null, tender: { bidNumber: 'X', title: 'Y' }, now })).sort();
    expect(TEMPLATE_PLACEHOLDERS.map((p) => p.path).sort()).toEqual(paths);
    expect(new Set(TEMPLATE_PLACEHOLDERS.map((p) => p.path)).size).toBe(TEMPLATE_PLACEHOLDERS.length);
    for (const p of TEMPLATE_PLACEHOLDERS) expect(p.label.trim().length).toBeGreaterThan(1);
  });

  it('accepts every placeholder used by the system templates', () => {
    for (const t of SYSTEM_TEMPLATES) expect(unknownPlaceholders(t.body)).toEqual([]);
  });

  it('flags typos and unsupported paths once each, in order', () => {
    expect(unknownPlaceholders('GSTIN {{company.gstn}} / {{ company.gstin }} / {{company.gstn}} {{tender}} {{foo.bar}}')).toEqual(['company.gstn', 'tender', 'foo.bar']);
    expect(unknownPlaceholders('No placeholders at all, just text.')).toEqual([]);
  });

  it('words the refusal message', () => {
    expect(unknownPlaceholderMessage(['company.gstn'])).toBe('Unknown placeholder {{company.gstn}} — use one from the list.');
    expect(unknownPlaceholderMessage(['a.b', 'c'])).toBe('Unknown placeholders {{a.b}}, {{c}} — use ones from the list.');
  });
});
