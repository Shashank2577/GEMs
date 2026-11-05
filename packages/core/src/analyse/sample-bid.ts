/**
 * Sample GeM bid-document generator (T040).
 *
 * Produces realistic multi-page PDFs that mimic the text layout of a GeM BidPlus "Bid Document"
 * (the "Bid Details" two-column table, EMD/ePBG detail blocks, MII/MSE preference rows, the
 * consignee table and the Additional Terms & Conditions). Used by unit tests (round trip
 * generate → extract → rules), by tools/mock-gem (`/showbidDocument/:id`) and by the demo seed.
 *
 * pdf-lib's standard fonts are WinAnsi only, so the Hindi half of GeM's bilingual labels is not
 * rendered here; the rule extractor's Devanagari stripping is unit-tested on text directly.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface SampleBidSpec {
  /** Stable fixture key, e.g. "go-it-services". */
  key: string;
  bidNumber: string; // GEM/2026/B/1234567
  /** "dd-mm-yyyy hh:mm:ss" (IST), as printed by GeM. */
  bidEndAt: string;
  bidOpeningAt: string;
  offerValidityDays: number;
  ministry: string;
  department: string;
  organisation: string;
  office: string;
  totalQuantity: number;
  itemCategory: string;
  /** Minimum average annual turnover of the bidder, printed as e.g. "50 Lakh (s)". null = not asked. */
  turnover: string | null;
  oemTurnover?: string | null;
  /** Years of past experience required, null = not asked. */
  experienceYears: number | null;
  mseExemption: boolean;
  startupExemption: boolean;
  documentsRequired: string[];
  pastPerformancePct?: number | null;
  bidToRa: boolean;
  bidType: 'Two Packet Bid' | 'Single Packet Bid';
  evaluationMethod: string;
  estimatedValue?: number | null;
  emd: { amount: number; advisoryBank: string } | null;
  epbg: { percent: number; durationMonths: number } | null;
  miiCompliance: boolean;
  msePurchasePreference: boolean;
  splitting?: string;
  deliveryDays: number;
  consignee: { state: string; address: string };
  /** Similar-work clause, e.g. 40 → "… not less than 40% of the estimated bid value". */
  similarWorkPct?: number | null;
  atcClauses: string[];
}

const fmtIN = (n: number) => {
  const s = Math.round(n).toString();
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
};

interface Ctx { doc: PDFDocument; font: PDFFont; bold: PDFFont; page: PDFPage; y: number; pageNo: number; spec: SampleBidSpec }

const MARGIN = 48;
const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const LABEL_W = 270;
const VALUE_X = MARGIN + LABEL_W + 12;
const VALUE_W = PAGE_W - MARGIN - VALUE_X;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function footer(ctx: Ctx) {
  ctx.page.drawText(`${ctx.spec.bidNumber}  |  Page ${ctx.pageNo}`, { x: MARGIN, y: 28, size: 7.5, font: ctx.font, color: rgb(0.45, 0.45, 0.45) });
}

function newPage(ctx: Ctx) {
  footer(ctx);
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.pageNo += 1;
  ctx.y = PAGE_H - MARGIN;
}

function ensure(ctx: Ctx, h: number) {
  if (ctx.y - h < 56) newPage(ctx);
}

function heading(ctx: Ctx, text: string) {
  ensure(ctx, 40);
  ctx.y -= 10;
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 6, width: PAGE_W - 2 * MARGIN, height: 20, color: rgb(0.93, 0.94, 0.97) });
  ctx.page.drawText(text, { x: MARGIN + 6, y: ctx.y, size: 10.5, font: ctx.bold, color: rgb(0.1, 0.12, 0.3) });
  ctx.y -= 24;
}

/** One row of the two-column "Bid Details" table. Value is printed on the first line of the label. */
function row(ctx: Ctx, label: string, value: string) {
  const size = 9;
  const lLines = wrap(label, ctx.font, size, LABEL_W);
  const vLines = wrap(value, ctx.bold, size, VALUE_W);
  const n = Math.max(lLines.length, vLines.length);
  const h = n * 12 + 6;
  ensure(ctx, h);
  for (let i = 0; i < n; i++) {
    const yy = ctx.y - i * 12;
    if (lLines[i]) ctx.page.drawText(lLines[i], { x: MARGIN + 4, y: yy, size, font: ctx.font, color: rgb(0.2, 0.2, 0.2) });
    if (vLines[i]) ctx.page.drawText(vLines[i], { x: VALUE_X, y: yy, size, font: ctx.bold, color: rgb(0, 0, 0) });
  }
  ctx.y -= h;
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y + 8 }, end: { x: PAGE_W - MARGIN, y: ctx.y + 8 }, thickness: 0.4, color: rgb(0.8, 0.8, 0.85) });
}

function para(ctx: Ctx, text: string, opts: { size?: number; bold?: boolean; indent?: number } = {}) {
  const size = opts.size ?? 9;
  const font = opts.bold ? ctx.bold : ctx.font;
  const x = MARGIN + (opts.indent ?? 0);
  for (const line of wrap(text, font, size, PAGE_W - MARGIN - x)) {
    ensure(ctx, 13);
    ctx.page.drawText(line, { x, y: ctx.y, size, font, color: rgb(0.1, 0.1, 0.1) });
    ctx.y -= 12.5;
  }
  ctx.y -= 4;
}

/** Render a GeM-style bid document PDF for a spec. */
export async function generateBidPdf(spec: SampleBidSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Bid Document ${spec.bidNumber}`);
  doc.setAuthor('Government e-Marketplace (sample generated by TenderPilot)');
  doc.setCreator('TenderPilot sample-bid generator');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN, pageNo: 1, spec };

  // Title block
  ctx.page.drawText('Bid Number: ' + spec.bidNumber, { x: MARGIN, y: ctx.y, size: 13, font: bold, color: rgb(0.05, 0.1, 0.35) });
  ctx.y -= 16;
  ctx.page.drawText('Dated: ' + spec.bidOpeningAt.slice(0, 10).replace(/^(\d{2})-(\d{2})-(\d{4})$/, '$1-$2-$3'), { x: MARGIN, y: ctx.y, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
  ctx.y -= 14;
  para(ctx, 'Bid Document', { size: 16, bold: true });

  heading(ctx, 'Bid Details');
  row(ctx, 'Bid End Date/Time', spec.bidEndAt);
  row(ctx, 'Bid Opening Date/Time', spec.bidOpeningAt);
  row(ctx, 'Bid Offer Validity (From End Date)', `${spec.offerValidityDays} (Days)`);
  row(ctx, 'Ministry/State Name', spec.ministry);
  row(ctx, 'Department Name', spec.department);
  row(ctx, 'Organisation Name', spec.organisation);
  row(ctx, 'Office Name', spec.office);
  row(ctx, 'Total Quantity', String(spec.totalQuantity));
  row(ctx, 'Item Category', spec.itemCategory);
  if (spec.estimatedValue) row(ctx, 'Estimated Bid Value', fmtIN(spec.estimatedValue));
  if (spec.turnover) row(ctx, 'Minimum Average Annual Turnover of the bidder (For 3 Years)', spec.turnover);
  if (spec.oemTurnover) row(ctx, 'OEM Average Turnover (Last 3 Years)', spec.oemTurnover);
  if (spec.experienceYears != null) row(ctx, 'Years of Past Experience Required for same/similar service', `${spec.experienceYears} Year (s)`);
  if (spec.pastPerformancePct != null) row(ctx, 'Past Performance', `${spec.pastPerformancePct} %`);
  row(ctx, 'MSE Exemption for Years Of Experience and Turnover', spec.mseExemption ? 'Yes' : 'No');
  row(ctx, 'Startup Exemption for Years Of Experience and Turnover', spec.startupExemption ? 'Yes' : 'No');
  row(ctx, 'Document required from seller', spec.documentsRequired.join(',') +
    ' *In case any bidder is seeking exemption from Experience / Turnover Criteria, the supporting documents to prove his eligibility for exemption must be uploaded for evaluation by the buyer');
  row(ctx, 'Bid to RA enabled', spec.bidToRa ? 'Yes' : 'No');
  row(ctx, 'Type of Bid', spec.bidType);
  row(ctx, 'Time allowed for Technical Clarifications during technical evaluation', '2 Days');
  row(ctx, 'Evaluation Method', spec.evaluationMethod);

  if (spec.emd) {
    heading(ctx, 'EMD Detail');
    row(ctx, 'Advisory Bank', spec.emd.advisoryBank);
    row(ctx, 'EMD Amount', fmtIN(spec.emd.amount));
  }
  if (spec.epbg) {
    heading(ctx, 'ePBG Detail');
    row(ctx, 'Advisory Bank', 'State Bank of India');
    row(ctx, 'ePBG Percentage(%)', spec.epbg.percent.toFixed(2));
    row(ctx, 'Duration of ePBG required (Months).', String(spec.epbg.durationMonths));
  }
  para(ctx, '(a). EMD EXEMPTION: The bidder seeking EMD exemption, must submit the valid supporting document for the relevant category as per GeM GTC with the bid. Under MSE category, only manufacturers for goods and Service Providers for Services are eligible for exemption from EMD. Traders are excluded from the purview of this Policy.', { size: 8 });

  heading(ctx, 'Splitting');
  row(ctx, 'Bid splitting not applied.', spec.splitting ?? 'No');

  heading(ctx, 'MII Compliance');
  row(ctx, 'MII Compliance', spec.miiCompliance ? 'Yes' : 'No');
  heading(ctx, 'MSE Purchase Preference');
  row(ctx, 'MSE Purchase Preference', spec.msePurchasePreference ? 'Yes' : 'No');

  if (spec.miiCompliance) {
    para(ctx, '1. Preference to Make In India products (For bids < 200 Crore): Preference shall be given to Class 1 local suppliers as defined in public procurement (Preference to Make in India), Order 2017 as amended from time to time and its subsequent Orders/Notifications issued by concerned Nodal Ministry for specific Goods/Products.', { size: 8 });
  }
  if (spec.msePurchasePreference) {
    para(ctx, '2. Purchase preference to Micro and Small Enterprises (MSEs): Purchase preference will be given to MSEs as defined in Public Procurement Policy for Micro and Small Enterprises (MSEs) Order, 2012 dated 23.03.2012 issued by Ministry of Micro, Small and Medium Enterprises and its subsequent Orders/Notifications.', { size: 8 });
  }

  // Page 2+: consignee + specification
  newPage(ctx);
  heading(ctx, 'Consignees/Reporting Officer and Quantity');
  row(ctx, 'S.No.', '1');
  row(ctx, 'Consignee/Reporting Officer', 'Sh. R. K. Verma, Deputy Director');
  row(ctx, 'Address', `${spec.consignee.address}, ${spec.consignee.state}`);
  row(ctx, 'Quantity', String(spec.totalQuantity));
  row(ctx, 'Delivery Days', String(spec.deliveryDays));

  heading(ctx, 'Technical Specifications');
  para(ctx, `${spec.itemCategory} — as per the specification document uploaded by the buyer. Bidders must comply with all the specification parameters and upload the technical compliance sheet along with supporting brochures.`);

  // ATC on its own page
  newPage(ctx);
  heading(ctx, 'Buyer Added Bid Specific Terms and Conditions (ATC)');
  const clauses = [...spec.atcClauses];
  if (spec.similarWorkPct) {
    clauses.unshift(`Past Experience of Similar Services: The Bidder must have successfully executed/completed similar Services over the last three years i.e. the current financial year and the last three financial years. One similar completed work of value not less than ${spec.similarWorkPct}% of the estimated bid value is required. Copies of work orders and completion certificates (CRAC) must be uploaded.`);
  }
  clauses.forEach((c, i) => para(ctx, `${i + 1}. ${c}`));

  para(ctx, 'Disclaimer: The additional terms and conditions have been incorporated by the Buyer after approval of the Competent Authority in Buyer Organization. Buyer organization is solely responsible for the impact of these clauses on the bidding process.', { size: 7.5 });
  para(ctx, '---Thank You---', { size: 9, bold: true });
  footer(ctx);
  return doc.save();
}

// ───────────── Fixture specs ─────────────

const COMMON_DOCS = ['Experience Criteria', 'Bidder Turnover', 'Certificate (Requested in ATC)', 'Additional Doc 1 (Requested in ATC)'];

/**
 * Four reference bids exercising the scorer's main paths. Expected values are asserted in
 * packages/core/test/analyse/*.test.ts.
 */
export const SAMPLE_BID_SPECS: SampleBidSpec[] = [
  {
    key: 'go-it-services',
    bidNumber: 'GEM/2026/B/6120451',
    bidEndAt: '28-11-2026 15:00:00',
    bidOpeningAt: '28-11-2026 15:30:00',
    offerValidityDays: 120,
    ministry: 'Ministry of Electronics and Information Technology',
    department: 'Department of Electronics and Information Technology',
    organisation: 'National Informatics Centre',
    office: 'NIC Headquarters, New Delhi',
    totalQuantity: 1,
    itemCategory: 'Facility Management Services - LumpSum Based - IT Helpdesk Support',
    turnover: '50 Lakh (s)',
    experienceYears: 3,
    mseExemption: true,
    startupExemption: true,
    documentsRequired: COMMON_DOCS,
    pastPerformancePct: null,
    bidToRa: false,
    bidType: 'Two Packet Bid',
    evaluationMethod: 'Total value wise evaluation',
    estimatedValue: 4_800_000,
    emd: { amount: 96_000, advisoryBank: 'State Bank of India' },
    epbg: { percent: 3, durationMonths: 14 },
    miiCompliance: true,
    msePurchasePreference: true,
    deliveryDays: 30,
    consignee: { state: 'Delhi', address: 'A-Block, CGO Complex, Lodhi Road, New Delhi-110003' },
    similarWorkPct: 40,
    atcClauses: [
      'The bidder shall possess valid ISO 9001:2015 certification. Copy of the certificate must be uploaded with the bid.',
      'The bidder must upload a self-declaration that the firm has not been blacklisted or debarred by any Central/State Government department or PSU.',
      'Manpower deployed must be on the payroll of the bidder and compliant with EPF/ESI regulations.',
    ],
  },
  {
    key: 'review-hardware-oem',
    bidNumber: 'GEM/2026/B/6133872',
    bidEndAt: '20-11-2026 18:00:00',
    bidOpeningAt: '20-11-2026 18:30:00',
    offerValidityDays: 90,
    ministry: 'Ministry of Defence',
    department: 'Department of Military Affairs',
    organisation: 'Indian Army',
    office: 'HQ Western Command, Chandimandir',
    totalQuantity: 120,
    itemCategory: 'Desktop Computers (Q2)',
    turnover: '1.5 Crore (s)',
    oemTurnover: '200 Crore (s)',
    experienceYears: 2,
    mseExemption: false,
    startupExemption: false,
    documentsRequired: [...COMMON_DOCS, 'OEM Authorization Certificate', 'OEM Annual Turnover', 'Compliance of BoQ specification and supporting document'],
    pastPerformancePct: 20,
    bidToRa: true,
    bidType: 'Two Packet Bid',
    evaluationMethod: 'Total value wise evaluation',
    estimatedValue: 7_200_000,
    emd: { amount: 216_000, advisoryBank: 'Punjab National Bank' },
    epbg: { percent: 5, durationMonths: 38 },
    miiCompliance: true,
    msePurchasePreference: true,
    deliveryDays: 45,
    consignee: { state: 'Haryana', address: 'HQ Western Command, Chandimandir, Panchkula-134107' },
    similarWorkPct: null,
    atcClauses: [
      'Bidder must have BIS registration for the offered product under the Compulsory Registration Scheme. Copy of BIS certificate to be uploaded.',
      'Authorization from the OEM (Manufacturer Authorization Form) in the name of the bidder specific to this bid is mandatory.',
      'Warranty: 3 years comprehensive on-site warranty from the date of installation.',
    ],
  },
  {
    key: 'nogo-experience',
    bidNumber: 'GEM/2026/B/6140019',
    bidEndAt: '25-11-2026 13:00:00',
    bidOpeningAt: '25-11-2026 13:30:00',
    offerValidityDays: 180,
    ministry: 'Ministry of Railways',
    department: 'Indian Railways',
    organisation: 'Northern Railway',
    office: 'Divisional Railway Manager Office, Lucknow',
    totalQuantity: 1,
    itemCategory: 'Custom Bid for Services - Annual Maintenance of CCTV Surveillance System',
    turnover: '75 Lakh (s)',
    experienceYears: 5,
    mseExemption: false,
    startupExemption: false,
    documentsRequired: COMMON_DOCS,
    pastPerformancePct: null,
    bidToRa: false,
    bidType: 'Two Packet Bid',
    evaluationMethod: 'Total value wise evaluation',
    estimatedValue: 2_500_000,
    emd: { amount: 50_000, advisoryBank: 'State Bank of India' },
    epbg: { percent: 5, durationMonths: 14 },
    miiCompliance: false,
    msePurchasePreference: false,
    deliveryDays: 15,
    consignee: { state: 'Uttar Pradesh', address: 'DRM Office, Hazratganj, Lucknow-226001' },
    similarWorkPct: 80,
    atcClauses: [
      'The bidder must have a minimum of five years of experience in annual maintenance of CCTV systems for Government organisations.',
      'Bidder shall submit a non-blacklisting undertaking on company letterhead.',
    ],
  },
  {
    key: 'emd-exempt-mse',
    bidNumber: 'GEM/2026/B/6151234',
    bidEndAt: '02-12-2026 17:00:00',
    bidOpeningAt: '02-12-2026 17:30:00',
    offerValidityDays: 60,
    ministry: 'Ministry of Health and Family Welfare',
    department: 'Department of Health and Family Welfare',
    organisation: 'All India Institute of Medical Sciences (AIIMS)',
    office: 'AIIMS Bhopal Stores Section',
    totalQuantity: 500,
    itemCategory: 'Office Chairs (V3) conforming to IS 3200',
    turnover: '30 Lakh (s)',
    experienceYears: 1,
    mseExemption: true,
    startupExemption: false,
    documentsRequired: ['Experience Criteria', 'Bidder Turnover', 'Certificate (Requested in ATC)'],
    pastPerformancePct: null,
    bidToRa: true,
    bidType: 'Single Packet Bid',
    evaluationMethod: 'Item wise evaluation',
    estimatedValue: 2_250_000,
    emd: { amount: 67_500, advisoryBank: 'Bank of Baroda' },
    epbg: null,
    miiCompliance: true,
    msePurchasePreference: true,
    deliveryDays: 60,
    consignee: { state: 'Madhya Pradesh', address: 'AIIMS Saket Nagar, Bhopal-462020' },
    similarWorkPct: null,
    atcClauses: [
      'Bidders claiming EMD exemption as MSE must upload a valid Udyam Registration Certificate for the offered product category.',
      'Products must carry BIS certification mark as per IS 3200.',
    ],
  },
];

export function getSampleBidSpec(key: string): SampleBidSpec | undefined {
  return SAMPLE_BID_SPECS.find((s) => s.key === key);
}
