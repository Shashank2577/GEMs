/**
 * Annexure / undertaking templates and their renderer (T061; FR-024).
 *
 * Templates are plain text with `{{path.to.value}}` placeholders. Organisations can override the
 * title/body of any system template (annexure_templates rows with org_id); the keys stay the same.
 * Missing values render as a blank line ("__________") so the printed form can be completed by hand.
 *
 * Body layout rules used by renderAnnexurePdf:
 *  - a blank line separates paragraphs; single newlines are kept as line breaks;
 *  - lines starting with "1." / "a)" / "-" are list items with a hanging indent;
 *  - a line starting with "Subject:" is set in bold.
 * The signature block ("Authorised Signatory (Seal & Signature)") is appended automatically.
 */
import { PDFDocument } from 'pdf-lib';
import { ANNEXURE_KEYS } from '../analyse/checklist';
import { inr } from '../analyse/format';
import { A4, INK, MARGIN, MUTED, RULE, dateIST, dateTimeIST, embedFonts, sanitize, text, textCenter, textRight, wrap } from './pdf-utils';

export const BLANK = '__________';

/** All system template keys. The first seven are the keys emitted by the analyse checklist. */
export const TEMPLATE_KEYS = [
  ANNEXURE_KEYS.nonBlacklisting,
  ANNEXURE_KEYS.miiSelfCert,
  ANNEXURE_KEYS.mseDeclaration,
  ANNEXURE_KEYS.emdExemption,
  ANNEXURE_KEYS.oemAuthRequest,
  ANNEXURE_KEYS.technicalCompliance,
  ANNEXURE_KEYS.authorityLetter,
  'bid_cover_letter',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** Alternative spellings accepted by the API (e.g. from older clients). */
export const TEMPLATE_KEY_ALIASES: Record<string, TemplateKey> = {
  mii_self_certificate: 'mii_self_cert',
  oem_authorization_request: 'oem_auth_request',
  oem_authorisation_request: 'oem_auth_request',
  cover_letter: 'bid_cover_letter',
};

export function normalizeTemplateKey(key: string): TemplateKey | null {
  const k = key.trim().toLowerCase();
  if ((TEMPLATE_KEYS as readonly string[]).includes(k)) return k as TemplateKey;
  return TEMPLATE_KEY_ALIASES[k] ?? null;
}

export interface AnnexureTemplate {
  key: TemplateKey;
  title: string;
  /** One line for the UI. */
  description: string;
  /** Who signs: shown under the signature line. */
  signatureRole: string;
  /** Address the letter to the OEM instead of the buyer (affects nothing but copy). */
  body: string;
}

const TO_BUYER = `To,
The Buyer / Purchase Officer,
{{tender.organisation}}
{{tender.buyerOffice}}`;

export const SYSTEM_TEMPLATES: readonly AnnexureTemplate[] = [
  {
    key: 'non_blacklisting',
    title: 'Undertaking regarding Non-Blacklisting / Non-Debarment',
    description: 'Declares the firm is not blacklisted, debarred or suspended by any government body.',
    signatureRole: 'Authorised Signatory',
    body: `${TO_BUYER}

Subject: Undertaking regarding non-blacklisting / non-debarment in respect of Bid No. {{tender.bidNumber}} for "{{tender.title}}"

Sir / Madam,

I/We, {{company.legalName}}, having our registered office at {{company.address}} (GSTIN: {{company.gstin}}, PAN: {{company.pan}}), hereby solemnly declare and undertake that:

1. Our firm/company has not been blacklisted, debarred or suspended by any Ministry or Department of the Government of India, any State Government, Union Territory, Public Sector Undertaking, autonomous body or by the Government e-Marketplace (GeM) as on the date of submission of this bid.
2. No proceedings for blacklisting, debarment or suspension are pending against our firm/company, its proprietor, partners or directors, or any of its sister concerns.
3. Our firm/company is not insolvent, in receivership, bankrupt or being wound up, and its business activities have not been suspended.
4. Should any of the above information be found false or incorrect at any stage, the Buyer shall be at liberty to reject our bid or cancel the contract, forfeit the EMD / Performance Security, and take any other action deemed fit under the terms of the bid and the GeM General Terms and Conditions.

This undertaking is furnished for the purpose of the above-referenced bid and is true to the best of our knowledge and belief.`,
  },
  {
    key: 'mii_self_cert',
    title: 'Self-Certificate of Local Content (Make in India)',
    description: 'Local-content self-certification under the Public Procurement (Preference to Make in India) Order, 2017.',
    signatureRole: 'Authorised Signatory',
    body: `${TO_BUYER}

Subject: Self-certificate of local content under the Public Procurement (Preference to Make in India) Order, 2017 in respect of Bid No. {{tender.bidNumber}}

Sir / Madam,

I/We, {{company.legalName}} (GSTIN: {{company.gstin}}), hereby certify that the item(s)/service(s) offered by us against the above bid for "{{tender.title}}" meet the minimum local content requirement and that we qualify as a {{company.miiClass}}.

1. The percentage of local content in the item(s)/service(s) offered is {{company.localContentPct}}%.
2. The location(s) at which the local value addition is made: {{company.address}}.
3. The local content has been calculated in accordance with the definitions and methodology prescribed in the Public Procurement (Preference to Make in India) Order, 2017 issued by DPIIT, as amended from time to time, and the notifications of the nodal Ministry/Department concerned.
4. I/We understand that a false declaration is a breach of the Code of Integrity under Rule 175(1)(i)(h) of the General Financial Rules, 2017, for which a bidder or its successors can be debarred for up to two years under Rule 151(iii) of the General Financial Rules, along with such other action as may be permissible under law.
5. Where the estimated value of the procurement exceeds Rs. 10 crore, this self-certificate shall be supported by a certificate from the statutory auditor or cost auditor of the company (or a practising Cost Accountant / Chartered Accountant in the case of other suppliers).`,
  },
  {
    key: 'mse_declaration',
    title: 'Declaration for Benefits as a Micro / Small Enterprise',
    description: 'Claims MSE benefits (exemptions and purchase preference) under the MSE Procurement Policy Order, 2012.',
    signatureRole: 'Authorised Signatory',
    body: `${TO_BUYER}

Subject: Declaration for claiming benefits as a Micro and Small Enterprise (MSE) in respect of Bid No. {{tender.bidNumber}}

Sir / Madam,

I/We, {{company.legalName}}, having our registered office at {{company.address}}, hereby declare that:

1. We are a {{company.mseCategory}} enterprise registered under Udyam Registration No. {{company.udyamNumber}}, and the registration is valid as on the date of submission of this bid.
2. We are the manufacturer / service provider of the item(s)/service(s) offered against this bid, for which the benefits under the Public Procurement Policy for Micro and Small Enterprises (MSEs) Order, 2012 (as amended) are being claimed. We understand that traders and resellers are not eligible for these benefits.
3. Our social category as recorded in the Udyam Registration is: {{company.mseSocialCategory}}.
4. We request exemption from the prescribed experience and turnover criteria and from the submission of EMD, and the purchase preference applicable to MSEs, to the extent permitted under the bid terms and the said Order.
5. We undertake to produce the Udyam Registration Certificate and any other supporting document whenever required by the Buyer. We understand that a false declaration shall render our bid liable to rejection and attract action under the GeM terms and conditions.`,
  },
  {
    key: 'emd_exemption',
    title: 'Request for EMD Exemption and Bid Securing Declaration',
    description: 'Requests exemption from Earnest Money Deposit (MSE / DPIIT Startup) with the bid-securing declaration.',
    signatureRole: 'Authorised Signatory',
    body: `${TO_BUYER}

Subject: Request for exemption from Earnest Money Deposit (EMD) in respect of Bid No. {{tender.bidNumber}}

Sir / Madam,

The above bid for "{{tender.title}}" requires an Earnest Money Deposit of {{tender.emdAmount}}. We, {{company.legalName}} (GSTIN: {{company.gstin}}), request exemption from the submission of EMD as a {{emd.basis}}, in terms of Rule 170 of the General Financial Rules, 2017 and the bid conditions. A copy of the supporting certificate is enclosed with our technical bid.

In lieu of EMD, we hereby submit the following Bid Securing Declaration:

1. We accept that if we withdraw or modify our bid during the period of bid validity, or
2. if, having been notified of the acceptance of our bid during the period of bid validity, we fail or refuse to execute the contract or to furnish the Performance Security (ePBG) as per the bid conditions,
then we shall be suspended from being eligible for bidding in any contract with {{tender.organisation}} for the period stated in the bid document, starting from the date of such default.`,
  },
  {
    key: 'oem_auth_request',
    title: 'Request for Manufacturer’s Authorisation (MAF)',
    description: 'Letter to your OEM requesting a bid-specific authorisation (MAF) to quote their products.',
    signatureRole: 'Authorised Signatory',
    body: `To,
The Authorised Representative,
{{oem.name}}

Subject: Request for bid-specific Manufacturer’s Authorisation Form (MAF) for GeM Bid No. {{tender.bidNumber}}

Dear Sir / Madam,

We, {{company.legalName}}, are an authorised channel partner of {{oem.name}} for {{oem.products}}. We intend to participate in the above bid floated by {{tender.organisation}} ({{tender.ministry}}) on the Government e-Marketplace (GeM) for "{{tender.title}}" (quantity: {{tender.quantity}}), which closes on {{tender.endDate}}.

As the bid requires an authorisation from the Original Equipment Manufacturer specific to this bid, we request you to kindly issue the Manufacturer’s Authorisation Form on your letterhead in our favour, quoting the above bid number and confirming:

1. that we are authorised to quote for and supply your products against this bid;
2. your full warranty and after-sales service support for the products supplied through us, for the warranty period specified in the bid;
3. the availability of spares and service support for the period specified in the bid.

We would be grateful to receive the authorisation at the earliest, and in any case before {{tender.endDate}}, so that it can be uploaded with our technical bid.

Thanking you,
Yours faithfully,`,
  },
  {
    key: 'technical_compliance',
    title: 'Technical Compliance Statement',
    description: 'Confirms the offer complies with the specifications, BOQ and ATC without deviation.',
    signatureRole: 'Authorised Signatory',
    body: `${TO_BUYER}

Subject: Technical compliance statement in respect of Bid No. {{tender.bidNumber}} for "{{tender.title}}"

Sir / Madam,

We, {{company.legalName}}, hereby confirm that the item(s)/service(s) offered by us against the above bid comply with all the technical specifications, quantities, delivery schedule and other requirements stipulated in the bid document, the Additional Terms and Conditions (ATC), the Bill of Quantities (BOQ) and the Buyer’s specification document, without any deviation, as summarised below:

- Item(s): {{tender.items}}
- Quantity offered: {{offer.quantity}}
- Make / Brand: {{offer.make}}
- Model: {{offer.model}}
- Country of origin: {{offer.countryOfOrigin}}
- Delivery period: {{offer.deliveryPeriod}}
- Warranty: {{offer.warranty}}
- Compliance with technical specifications: Complied — no deviation
- Compliance with ATC and BOQ: Complied — no deviation

We further confirm that the product(s) offered are new, genuine and unused, and that warranty, installation and after-sales service shall be provided as per the bid conditions.`,
  },
  {
    key: 'authority_letter',
    title: 'Letter of Authority for Bid Signatory',
    description: 'Authorises the named signatory to sign and submit this bid on behalf of the company.',
    signatureRole: 'Proprietor / Partner / Director',
    body: `${TO_BUYER}

Subject: Letter of authority for signing and submitting the bid — Bid No. {{tender.bidNumber}}

Sir / Madam,

We, {{company.legalName}}, having our registered office at {{company.address}} (GSTIN: {{company.gstin}}, CIN: {{company.cin}}), hereby authorise Shri / Smt. {{signatory.name}}, {{signatory.designation}}, to sign and submit the above bid on our behalf, to correspond with the Buyer in respect of it, to attend the bid opening and furnish clarifications, and to execute the contract if awarded.

All acts done by the authorised person in connection with this bid shall be binding on us.

Specimen signature of Shri / Smt. {{signatory.name}}: ______________________

Attested by the Proprietor / Partner / Director with the company seal.`,
  },
  {
    key: 'bid_cover_letter',
    title: 'Covering Letter for Technical Bid',
    description: 'Formal covering letter listing the enclosed technical documents.',
    signatureRole: 'Authorised Signatory',
    body: `${TO_BUYER}

Subject: Submission of technical bid against Bid No. {{tender.bidNumber}} for "{{tender.title}}"

Sir / Madam,

With reference to the above bid published on the Government e-Marketplace (GeM) by {{tender.organisation}}, we, {{company.legalName}} (GSTIN: {{company.gstin}}), hereby submit our technical bid together with the documents listed in the enclosed index.

1. We have read and understood the bid document, the Additional Terms and Conditions (ATC), the corrigenda (if any) and the GeM General Terms and Conditions, and we accept them unconditionally.
2. Our offer shall remain valid for the bid validity period specified in the bid document.
3. Our financial offer shall be submitted by us separately on the GeM portal in the prescribed format.
4. The contact person for this bid is {{company.contactName}} (Phone: {{company.contactPhone}}, Email: {{company.contactEmail}}).

We look forward to your favourable consideration.`,
  },
];

export const SYSTEM_TEMPLATE_BY_KEY: ReadonlyMap<string, AnnexureTemplate> = new Map(SYSTEM_TEMPLATES.map((t) => [t.key, t]));

// ───────────── Context ─────────────

export interface TemplateCompany {
  legalName?: string | null; tradeName?: string | null; gstin?: string | null; pan?: string | null; cin?: string | null;
  udyamNumber?: string | null; mseCategory?: string | null; mseSocialCategory?: string | null; isStartup?: boolean | null;
  dpiitNumber?: string | null; miiClass?: string | null; localContentPct?: number | null;
  address?: string | null; state?: string | null; pincode?: string | null;
  contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null;
  signatoryName?: string | null; signatoryDesignation?: string | null;
  oemAuthorizations?: { oem: string; products?: string | null }[] | null;
}

export interface TemplateTender {
  bidNumber: string; title: string; organisation?: string | null; ministry?: string | null; department?: string | null;
  buyerOffice?: string | null; state?: string | null; endAt?: string | Date | null; emdAmount?: number | null;
  quantity?: number | null; items?: { name: string; quantity?: number | null; unit?: string | null }[] | null;
}

/** Nested string map; leaves are strings. */
export interface TemplateContext { [k: string]: string | TemplateContext }

const MII_LABEL: Record<string, string> = {
  class_1: "'Class-I local supplier' (local content of 50% or more)",
  class_2: "'Class-II local supplier' (local content of 20% or more but less than 50%)",
  non_local: "'Non-local supplier'",
};
const MSE_LABEL: Record<string, string> = { micro: 'Micro', small: 'Small', medium: 'Medium' };
const SOCIAL_LABEL: Record<string, string> = { general: 'General', sc_st: 'SC/ST', women: 'Women' };

const s = (v: unknown): string => (v == null ? '' : String(v).trim());

export function buildTemplateContext(input: {
  company: TemplateCompany | null | undefined;
  tender: TemplateTender;
  now: Date;
  /** Non-financial assist values (make, model, delivery …) from the workspace. */
  offer?: Record<string, string | null | undefined>;
  place?: string | null;
}): TemplateContext {
  const c = input.company ?? {};
  const t = input.tender;
  const o = input.offer ?? {};
  const address = [s(c.address), s(c.state), s(c.pincode)].filter(Boolean).join(', ');
  const mse = !!(c.mseCategory || c.udyamNumber);
  const startup = !!(c.isStartup || c.dpiitNumber);
  const oem = (c.oemAuthorizations ?? [])[0];
  const items = (t.items ?? []).map((i) => `${i.name}${i.quantity ? ` (${i.quantity}${i.unit ? ` ${i.unit}` : ''})` : ''}`).join('; ') || t.title;
  const basis = mse
    ? `Micro or Small Enterprise registered under Udyam Registration No. ${s(c.udyamNumber) || BLANK}`
    : startup
      ? `Startup recognised by DPIIT (Certificate No. ${s(c.dpiitNumber) || BLANK})`
      : '';
  return {
    company: {
      legalName: s(c.legalName), tradeName: s(c.tradeName) || s(c.legalName), gstin: s(c.gstin), pan: s(c.pan), cin: s(c.cin),
      udyamNumber: s(c.udyamNumber), mseCategory: MSE_LABEL[s(c.mseCategory)] ?? '', mseSocialCategory: SOCIAL_LABEL[s(c.mseSocialCategory)] ?? '',
      dpiitNumber: s(c.dpiitNumber), miiClass: MII_LABEL[s(c.miiClass)] ?? '',
      localContentPct: c.localContentPct == null ? '' : String(Math.round(c.localContentPct * 100) / 100),
      address, state: s(c.state), contactName: s(c.contactName) || s(c.signatoryName), contactEmail: s(c.contactEmail), contactPhone: s(c.contactPhone),
    },
    signatory: { name: s(c.signatoryName), designation: s(c.signatoryDesignation) },
    tender: {
      bidNumber: s(t.bidNumber), title: s(t.title), organisation: s(t.organisation) || s(t.department) || s(t.ministry),
      ministry: s(t.ministry), department: s(t.department), buyerOffice: s(t.buyerOffice), state: s(t.state),
      endDate: t.endAt ? dateTimeIST(t.endAt) : '', emdAmount: t.emdAmount ? `${inr(t.emdAmount)} (Rs. ${t.emdAmount.toLocaleString('en-IN')})` : '',
      quantity: t.quantity == null ? '' : String(t.quantity), items,
    },
    oem: { name: s(o.oem_name) || s(oem?.oem), products: s(oem?.products) || s(t.title) },
    offer: {
      make: s(o.make) || s(o.brand) || s(oem?.oem), model: s(o.model), quantity: s(o.offered_quantity) || (t.quantity == null ? '' : String(t.quantity)),
      countryOfOrigin: s(o.country_of_origin) || (c.miiClass === 'class_1' || c.miiClass === 'class_2' ? 'India' : ''),
      deliveryPeriod: s(o.delivery_period_days) ? `${s(o.delivery_period_days)} days` : '', warranty: s(o.warranty_months) ? `${s(o.warranty_months)} months` : '',
    },
    emd: { basis },
    date: dateIST(input.now),
    place: s(input.place) || s(c.state),
  };
}

function lookup(ctx: TemplateContext, path: string): string {
  let cur: string | TemplateContext | undefined = ctx;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur === 'string') return '';
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : '';
}

/** Replace `{{a.b}}` placeholders; empty or unknown values become "__________". */
export function renderTemplate(body: string, ctx: TemplateContext): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => lookup(ctx, path) || BLANK);
}

/** Placeholders used in a template body. */
export function placeholdersOf(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];
}

/** Placeholders that would render blank with this context (shown as "fill your profile" hints). */
export function missingPlaceholders(body: string, ctx: TemplateContext): string[] {
  return placeholdersOf(body).filter((p) => !lookup(ctx, p));
}

// ───────────── PDF ─────────────

const LIST_RE = /^(\d+\.|[a-z]\)|\(?[ivx]+\)|-)\s+/i;

/**
 * Render an annexure as a one- or multi-page A4 PDF: letterhead (company name, address, GSTIN),
 * reference/date line, centred title, wrapped body, signature block.
 */
export async function renderAnnexurePdf(
  title: string, body: string, ctx: TemplateContext, opts: { signatureRole?: string } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(sanitizeMeta(`${title} — ${lookup(ctx, 'tender.bidNumber')}`));
  doc.setAuthor(sanitizeMeta(lookup(ctx, 'company.legalName') || 'Bidder'));
  doc.setCreator('TenderPilot');
  doc.setProducer('TenderPilot (pdf-lib)');
  const f = await embedFonts(doc);
  const [W, H] = A4;
  const width = W - MARGIN * 2;
  const size = 10.5;
  const lead = 15;
  let page = doc.addPage(A4);
  let y = H - MARGIN;

  const letterhead = () => {
    const name = lookup(ctx, 'company.legalName') || 'Company name';
    textCenter(page, name.toUpperCase(), y - 6, f.bold, 15);
    y -= 22;
    const addr = lookup(ctx, 'company.address');
    if (addr) for (const l of wrap(sanitize(addr, f.regular), f.regular, 8.5, width)) { textCenter(page, l, y, f.regular, 8.5, MUTED); y -= 11; }
    const ids = [
      lookup(ctx, 'company.gstin') && `GSTIN: ${lookup(ctx, 'company.gstin')}`,
      lookup(ctx, 'company.pan') && `PAN: ${lookup(ctx, 'company.pan')}`,
      lookup(ctx, 'company.contactEmail'),
      lookup(ctx, 'company.contactPhone'),
    ].filter(Boolean).join('   |   ');
    if (ids) { textCenter(page, ids, y, f.regular, 8.5, MUTED); y -= 11; }
    y -= 4;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: W - MARGIN, y }, thickness: 1.2, color: INK });
    page.drawLine({ start: { x: MARGIN, y: y - 2.5 }, end: { x: W - MARGIN, y: y - 2.5 }, thickness: 0.4, color: INK });
    y -= 20;
  };
  const footer = () => {
    page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: W - MARGIN, y: 40 }, thickness: 0.5, color: RULE });
    text(page, `Bid No. ${lookup(ctx, 'tender.bidNumber') || BLANK}`, MARGIN, 28, f.regular, 7.5, MUTED);
    textRight(page, sanitize(title, f.regular), W - MARGIN, 28, f.regular, 7.5, MUTED);
  };
  const ensure = (need: number) => {
    if (y - need < 64) {
      footer();
      page = doc.addPage(A4);
      y = H - MARGIN;
    }
  };

  letterhead();
  text(page, `Ref: ${lookup(ctx, 'tender.bidNumber') || BLANK}`, MARGIN, y, f.regular, 9.5, MUTED);
  textRight(page, `Date: ${lookup(ctx, 'date') || BLANK}`, W - MARGIN, y, f.regular, 9.5, MUTED);
  y -= 28;
  for (const l of wrap(sanitize(title.toUpperCase(), f.bold), f.bold, 12, width)) {
    textCenter(page, l, y, f.bold, 12);
    const w = f.bold.widthOfTextAtSize(l, 12);
    page.drawLine({ start: { x: (W - w) / 2, y: y - 2.5 }, end: { x: (W + w) / 2, y: y - 2.5 }, thickness: 0.6, color: INK });
    y -= 17;
  }
  y -= 10;

  const rendered = renderTemplate(body, ctx).replace(/\r\n?/g, '\n');
  const paragraphs = rendered.split(/\n\s*\n/);
  for (const para of paragraphs) {
    for (const raw of para.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const isSubject = /^subject\s*:/i.test(line);
      const font = isSubject ? f.bold : f.regular;
      const m = line.match(LIST_RE);
      const indent = m ? 18 : 0;
      const bullet = m ? (m[1] === '-' ? '•' : m[1]) : '';
      const content = m ? line.slice(m[0].length) : line;
      const lines = wrap(sanitize(content, font), font, size, width - indent);
      lines.forEach((l, i) => {
        ensure(lead);
        if (i === 0 && bullet) text(page, bullet, MARGIN + 2, y, f.regular, size);
        page.drawText(l, { x: MARGIN + indent, y, size, font, color: INK });
        y -= lead;
      });
    }
    y -= 7;
  }

  // Signature block
  ensure(150);
  y -= 8;
  text(page, 'Place: ' + (lookup(ctx, 'place') || BLANK), MARGIN, y, f.regular, size);
  text(page, `For ${lookup(ctx, 'company.legalName') || BLANK}`, W / 2 + 20, y, f.bold, size);
  y -= lead;
  text(page, 'Date: ' + (lookup(ctx, 'date') || BLANK), MARGIN, y, f.regular, size);
  y -= 46;
  page.drawLine({ start: { x: W / 2 + 20, y: y + 10 }, end: { x: W - MARGIN, y: y + 10 }, thickness: 0.5, color: MUTED });
  text(page, `${opts.signatureRole ?? 'Authorised Signatory'} (Seal & Signature)`, W / 2 + 20, y, f.bold, 9.5);
  y -= lead;
  text(page, `Name: ${lookup(ctx, 'signatory.name') || BLANK}`, W / 2 + 20, y, f.regular, 9.5);
  y -= lead;
  text(page, `Designation: ${lookup(ctx, 'signatory.designation') || BLANK}`, W / 2 + 20, y, f.regular, 9.5);
  footer();
  return doc.save();
}

function sanitizeMeta(s: string) {
  return s.replace(/₹/g, 'Rs.');
}
