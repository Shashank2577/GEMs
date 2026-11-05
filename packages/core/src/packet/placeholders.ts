/**
 * Supported annexure-template placeholders (FR-041). Kept free of pdf-lib so the web editor can import it.
 * Re-exported from `./templates`. Every path here is a leaf of `buildTemplateContext` (tested both ways).
 */

export interface TemplatePlaceholder {
  /** Context path, written in a template as `{{path}}`. */
  path: string;
  /** Friendly label for the editor palette and "blank" hints. */
  label: string;
  group: 'Company' | 'Signatory' | 'Tender' | 'OEM' | 'Offer' | 'EMD' | 'General';
}

export const TEMPLATE_PLACEHOLDERS: readonly TemplatePlaceholder[] = [
  { path: 'company.legalName', label: 'Legal name', group: 'Company' },
  { path: 'company.tradeName', label: 'Trade name', group: 'Company' },
  { path: 'company.gstin', label: 'GSTIN', group: 'Company' },
  { path: 'company.pan', label: 'PAN', group: 'Company' },
  { path: 'company.cin', label: 'CIN', group: 'Company' },
  { path: 'company.udyamNumber', label: 'Udyam number', group: 'Company' },
  { path: 'company.mseCategory', label: 'MSE category', group: 'Company' },
  { path: 'company.mseSocialCategory', label: 'MSE social category', group: 'Company' },
  { path: 'company.dpiitNumber', label: 'DPIIT startup number', group: 'Company' },
  { path: 'company.miiClass', label: 'Make in India class', group: 'Company' },
  { path: 'company.localContentPct', label: 'Local content %', group: 'Company' },
  { path: 'company.address', label: 'Registered address', group: 'Company' },
  { path: 'company.state', label: 'State', group: 'Company' },
  { path: 'company.contactName', label: 'Contact person', group: 'Company' },
  { path: 'company.contactEmail', label: 'Contact email', group: 'Company' },
  { path: 'company.contactPhone', label: 'Contact phone', group: 'Company' },
  { path: 'signatory.name', label: 'Signatory name', group: 'Signatory' },
  { path: 'signatory.designation', label: 'Signatory designation', group: 'Signatory' },
  { path: 'tender.bidNumber', label: 'Bid number', group: 'Tender' },
  { path: 'tender.title', label: 'Tender title', group: 'Tender' },
  { path: 'tender.organisation', label: 'Buyer organisation', group: 'Tender' },
  { path: 'tender.ministry', label: 'Ministry', group: 'Tender' },
  { path: 'tender.department', label: 'Department', group: 'Tender' },
  { path: 'tender.buyerOffice', label: 'Buyer office', group: 'Tender' },
  { path: 'tender.state', label: 'Tender state', group: 'Tender' },
  { path: 'tender.endDate', label: 'Bid end date', group: 'Tender' },
  { path: 'tender.emdAmount', label: 'EMD amount', group: 'Tender' },
  { path: 'tender.quantity', label: 'Tender quantity', group: 'Tender' },
  { path: 'tender.items', label: 'Tender items', group: 'Tender' },
  { path: 'oem.name', label: 'OEM name', group: 'OEM' },
  { path: 'oem.products', label: 'OEM products', group: 'OEM' },
  { path: 'offer.make', label: 'Make', group: 'Offer' },
  { path: 'offer.model', label: 'Model', group: 'Offer' },
  { path: 'offer.quantity', label: 'Quantity offered', group: 'Offer' },
  { path: 'offer.countryOfOrigin', label: 'Country of origin', group: 'Offer' },
  { path: 'offer.deliveryPeriod', label: 'Delivery period', group: 'Offer' },
  { path: 'offer.warranty', label: 'Warranty', group: 'Offer' },
  { path: 'emd.basis', label: 'EMD exemption basis', group: 'EMD' },
  { path: 'date', label: 'Date', group: 'General' },
  { path: 'place', label: 'Place', group: 'General' },
];

export const TEMPLATE_PLACEHOLDER_PATHS: ReadonlySet<string> = new Set(TEMPLATE_PLACEHOLDERS.map((p) => p.path));

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Placeholders used in a template body (unique, in order of first use). */
export function placeholdersOf(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!))];
}

/** Placeholders in `body` that are not supported context paths (FR-041). */
export function unknownPlaceholders(body: string): string[] {
  return placeholdersOf(body).filter((p) => !TEMPLATE_PLACEHOLDER_PATHS.has(p));
}

/** User-facing message for an `unknown_placeholder` refusal. */
export function unknownPlaceholderMessage(unknown: readonly string[]): string {
  const list = unknown.map((p) => `{{${p}}}`).join(', ');
  return unknown.length === 1 ? `Unknown placeholder ${list} — use one from the list.` : `Unknown placeholders ${list} — use ones from the list.`;
}
