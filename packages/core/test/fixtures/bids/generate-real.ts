/**
 * Real-layout GeM bid corpus (T035, SC-001). Regenerate the PDFs and their expected values:
 *   cd packages/core && pnpm exec tsx test/fixtures/bids/generate-real.ts
 *
 * Real GeM BidPlus is unreachable from the build environment, so these bids are synthesised — but in
 * GeM's real layout rather than the tidy one of `src/analyse/sample-bid.ts`:
 *   - bilingual labels, Hindi first ("बिड बंद होने की तारीख/समय/Bid End Date/Time"), rendered with a real
 *     Devanagari font, so pdf.js returns Devanagari (in visual glyph order, as with real GeM PDFs);
 *   - a narrow label column, so labels wrap over two or three lines; the value cell is drawn after the
 *     whole label cell (text order "label… label… value"), or — in the RA bid — line by line, so the
 *     value is interleaved inside the wrapped label;
 *   - GeM rows we do not extract (Primary product category, Inspection Required, Do you want to show
 *     documents…, RA Qualification Rule, Arbitration/Mediation Clause) sitting between known rows;
 *   - "Past Performance" both as a row and inside the documents list; newer "Relaxation … Yes | Complete"
 *     labels next to the older "Exemption" ones; "Dated:" header; "Contract Period" on the service bid;
 *   - the consignee block as a table (S.No. | Consignee | Address | Quantity | Delivery Days), with wrapped
 *     cells and two consignees on the RA bid;
 *   - a header and a footer on every page carrying the bid number and "Page n of N".
 * The bid numbers, buyers and people are invented (anonymised).
 *
 * Font: GNU FreeSans (GPLv3 with the font exception, which allows embedding in documents) from the
 * system font directory, or $TP_DEVANAGARI_FONT. It is only needed to regenerate; the corpus test reads
 * the committed PDFs and `real-*.expected.json`. The expected values are written from the specs below
 * (ground truth of what is printed, and the page it is printed on), never from extractor output.
 * `regenerator-runtime` is required by @pdf-lib/fontkit's Indic shaper.
 */
import 'regenerator-runtime/runtime.js';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

type Value = string | number | boolean;
interface Expect { key: string; value: Value; numeric?: number; page?: number }
interface Row { hi: string; en: string; value: string; expect?: Omit<Expect, 'page'>[] }
interface ConsigneeRow { officer: string; address: string; qty: number; days?: number }
interface RealBid {
  file: string;
  description: string;
  bidNumber: string;
  dated: string;
  /** Draw value cells line by line with the label (interleaved text) instead of after the label cell. */
  interleave: boolean;
  details: Row[];
  emd: Row[];
  epbg: Row[];
  preferences: Row[];
  consigneeColumns: [string, string][]; // [hi, en]
  consignees: ConsigneeRow[];
  consigneeExpect: Omit<Expect, 'page'>[];
  atc: { text: string; expect?: Omit<Expect, 'page'>[] }[];
}

const dir = dirname(fileURLToPath(import.meta.url));
const FONT = process.env.TP_DEVANAGARI_FONT ?? '/usr/share/fonts/truetype/freefont/FreeSans.ttf';
const FONT_BOLD = process.env.TP_DEVANAGARI_FONT_BOLD ?? '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf';

/** fontkit 1.1 crashes on some FreeSans mark anchors; mark positioning only moves diacritics, not text. */
const NO_MARK_POS = { mark: false, mkmk: false };

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;
const LABEL_W = 230;
const VALUE_X = M + LABEL_W + 14;
const VALUE_W = PAGE_W - M - VALUE_X - 4;
const SIZE = 8.5;
const LH = 11;

interface Ctx { doc: PDFDocument; font: PDFFont; bold: PDFFont; page: PDFPage; y: number; pageNo: number; bid: RealBid; expected: Expect[] }

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  // Break on spaces and after "/" (GeM wraps "तारीख/समय/Bid End Date/Time" at slashes too).
  const words = text.split(/(?<=\/)|\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const sep = cur && !cur.endsWith('/') ? ' ' : '';
    const next = cur + sep + w;
    if (font.widthOfTextAtSize(next, size) <= width) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function furniture(ctx: Ctx) {
  const grey = rgb(0.45, 0.45, 0.45);
  ctx.page.drawText(`बिड संख्या/Bid Number: ${ctx.bid.bidNumber}`, { x: PAGE_W - M - 200, y: PAGE_H - 22, size: 7, font: ctx.font, color: grey });
}

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.pageNo += 1;
  ctx.y = PAGE_H - M - 10;
  furniture(ctx);
}

function ensure(ctx: Ctx, h: number) {
  if (ctx.y - h < 50) newPage(ctx);
}

function record(ctx: Ctx, exps: Omit<Expect, 'page'>[] | undefined) {
  for (const e of exps ?? []) ctx.expected.push({ ...e, page: ctx.pageNo });
}

function heading(ctx: Ctx, text: string) {
  ensure(ctx, 36);
  ctx.y -= 6;
  ctx.page.drawRectangle({ x: M, y: ctx.y - 5, width: PAGE_W - 2 * M, height: 17, color: rgb(0.9, 0.92, 0.96) });
  ctx.page.drawText(text, { x: M + 5, y: ctx.y, size: 9.5, font: ctx.bold, color: rgb(0.1, 0.12, 0.3) });
  ctx.y -= 20;
}

function row(ctx: Ctx, r: Row) {
  const label = wrap(`${r.hi}/${r.en}`, ctx.font, SIZE, LABEL_W);
  const value = wrap(r.value, ctx.bold, SIZE, VALUE_W);
  const n = Math.max(label.length, value.length);
  const h = n * LH + 6;
  ensure(ctx, h);
  record(ctx, r.expect);
  const drawL = (i: number) => label[i] && ctx.page.drawText(label[i], { x: M + 4, y: ctx.y - i * LH, size: SIZE, font: ctx.font, color: rgb(0.2, 0.2, 0.2) });
  const drawV = (i: number) => value[i] && ctx.page.drawText(value[i], { x: VALUE_X, y: ctx.y - i * LH, size: SIZE, font: ctx.bold });
  if (ctx.bid.interleave) for (let i = 0; i < n; i++) { drawL(i); drawV(i); }
  else {
    for (let i = 0; i < label.length; i++) drawL(i);
    for (let i = 0; i < value.length; i++) drawV(i);
  }
  ctx.y -= h;
  ctx.page.drawLine({ start: { x: M, y: ctx.y + 8 }, end: { x: PAGE_W - M, y: ctx.y + 8 }, thickness: 0.4, color: rgb(0.78, 0.78, 0.82) });
  ctx.page.drawLine({ start: { x: VALUE_X - 7, y: ctx.y + 8 }, end: { x: VALUE_X - 7, y: ctx.y + 8 + h }, thickness: 0.4, color: rgb(0.78, 0.78, 0.82) });
}

function para(ctx: Ctx, text: string, size = 8.5) {
  for (const line of wrap(text, ctx.font, size, PAGE_W - 2 * M)) {
    ensure(ctx, LH + 2);
    ctx.page.drawText(line, { x: M, y: ctx.y, size, font: ctx.font, color: rgb(0.1, 0.1, 0.1) });
    ctx.y -= LH + 0.5;
  }
  ctx.y -= 4;
}

/** The consignee table: cells drawn left to right, each cell's lines top to bottom (as GeM's renderer does). */
function consigneeTable(ctx: Ctx) {
  const cols = ctx.bid.consigneeColumns;
  const widths = cols.length === 5 ? [34, 120, 220, 70, 79] : [34, 150, 260, 79];
  const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const cell = (texts: string[], font: PDFFont) => {
    const lines = texts.map((t, i) => wrap(t, font, 7.5, widths[i] - 6));
    const n = Math.max(...lines.map((l) => l.length));
    ensure(ctx, n * 10 + 6);
    lines.forEach((ls, i) => ls.forEach((l, j) => ctx.page.drawText(l, { x: xs[i] + 3, y: ctx.y - j * 10, size: 7.5, font })));
    ctx.y -= n * 10 + 6;
    ctx.page.drawLine({ start: { x: M, y: ctx.y + 7 }, end: { x: PAGE_W - M, y: ctx.y + 7 }, thickness: 0.4, color: rgb(0.78, 0.78, 0.82) });
  };
  cell(cols.map(([hi, en]) => `${hi}/${en}`), ctx.bold);
  record(ctx, ctx.bid.consigneeExpect);
  ctx.bid.consignees.forEach((c, i) => cell([String(i + 1), c.officer, c.address, String(c.qty), ...(c.days != null ? [String(c.days)] : [])], ctx.font));
}

async function render(bid: RealBid): Promise<{ bytes: Uint8Array; expected: Expect[] }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Bid Document ${bid.bidNumber}`);
  doc.setCreator('TenderPilot real-layout corpus generator (synthetic, anonymised)');
  // Fixed dates keep the bytes reproducible.
  doc.setCreationDate(new Date('2026-11-05T00:00:00Z'));
  doc.setModificationDate(new Date('2026-11-05T00:00:00Z'));
  const font = await doc.embedFont(await readFile(FONT), { subset: true, features: NO_MARK_POS });
  const bold = await doc.embedFont(await readFile(FONT_BOLD), { subset: true, features: NO_MARK_POS });
  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - M, pageNo: 1, bid, expected: [] };

  ctx.page.drawText(`बिड संख्या/Bid Number: ${bid.bidNumber}`, { x: M, y: ctx.y, size: 11, font: bold, color: rgb(0.05, 0.1, 0.35) });
  ctx.y -= 15;
  ctx.page.drawText(`दिनांक/Dated: ${bid.dated}`, { x: M, y: ctx.y, size: 8.5, font });
  const [d, m, y] = bid.dated.split('-');
  ctx.expected.push({ key: 'bid_published_at', value: `${y}-${m}-${d}T00:00:00+05:30`, page: 1 });
  ctx.y -= 16;
  ctx.page.drawText('बिड दस्तावेज़/Bid Document', { x: M, y: ctx.y, size: 14, font: bold });
  ctx.y -= 14;

  heading(ctx, 'बिड विवरण/Bid Details');
  bid.details.forEach((r) => row(ctx, r));
  if (bid.emd.length) { heading(ctx, 'ईएमडी विवरण/EMD Detail'); bid.emd.forEach((r) => row(ctx, r)); }
  if (bid.epbg.length) { heading(ctx, 'ईपीबीजी विवरण/ePBG Detail'); bid.epbg.forEach((r) => row(ctx, r)); }
  para(ctx, '(a). EMD EXEMPTION: The bidder seeking EMD exemption, must submit the valid supporting document for the relevant category as per GeM GTC with the bid. Under MSE category, only manufacturers for goods and Service Providers for Services are eligible for exemption from EMD. Traders are excluded from the purview of this Policy.', 7.5);
  heading(ctx, 'विभाजन/Splitting');
  row(ctx, { hi: 'बिड विभाजन लागू नहीं किया गया', en: 'Bid splitting not applied.', value: '' });
  for (const r of bid.preferences) { heading(ctx, r.en); row(ctx, r); }

  newPage(ctx);
  heading(ctx, 'परेषिती/रिपोर्टिंग अधिकारी/Consignees/Reporting Officer and Quantity');
  consigneeTable(ctx);
  heading(ctx, 'तकनीकी विशिष्टियाँ/Technical Specifications');
  para(ctx, 'Specification Document: as uploaded by the buyer. Bidders must comply with all the specification parameters and upload the technical compliance sheet along with supporting brochures.');

  newPage(ctx);
  heading(ctx, 'क्रेता द्वारा जोड़ी गई बिड की विशेष शर्तें/Buyer Added Bid Specific Terms and Conditions');
  bid.atc.forEach((c, i) => { record(ctx, c.expect); para(ctx, `${i + 1}. ${c.text}`); });
  para(ctx, 'Disclaimer: The additional terms and conditions have been incorporated by the Buyer after approval of the Competent Authority in Buyer Organization. Buyer organization is solely responsible for the impact of these clauses on the bidding process.', 7.5);
  para(ctx, '---धन्यवाद/Thank You---', 9);

  // Footers once the page count is known.
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`${bid.bidNumber} / Page ${i + 1} of ${pages.length}`, { x: M, y: 24, size: 7, font, color: rgb(0.45, 0.45, 0.45) }));
  return { bytes: await doc.save({ useObjectStreams: false }), expected: ctx.expected };
}

// ───────────── Shared rows ─────────────

const yes = (key: string, v: boolean) => [{ key, value: v }];
const docsRow = (items: string[]): Row => ({
  hi: 'विक्रेता से मांगे गए दस्तावेज़', en: 'Document required from seller',
  value: `${items.join(',')} *In case any bidder is seeking exemption from Experience / Turnover Criteria, the supporting documents to prove his eligibility for exemption must be uploaded for evaluation by the buyer`,
  expect: items.map((i) => ({ key: 'document', value: i })),
});
const showDocs: Row = { hi: 'क्या आप निविदा में भाग लेने वाले सभी बिडरों द्वारा अपलोड किए गए दस्तावेज़ दिखाना चाहते हैं?', en: 'Do you want to show documents uploaded by bidders to all bidders participated in bid?', value: 'No' };
const techClar: Row = { hi: 'तकनीकी मूल्यांकन के दौरान तकनीकी स्पष्टीकरण हेतु अनुमत समय', en: 'Time allowed for Technical Clarifications during technical evaluation', value: '2 Days' };
const inspection: Row = { hi: 'निरीक्षण आवश्यक', en: 'Inspection Required (By Empanelled Inspection Authority / Agencies pre-registered with GeM)', value: 'No' };
const arbitration: Row = { hi: 'मध्यस्थता खंड', en: 'Arbitration Clause', value: 'No' };
const mediation: Row = { hi: 'सुलह खंड', en: 'Mediation Clause', value: 'No' };
const goodsColumns: [string, string][] = [['क्र.सं.', 'S.No.'], ['परेषिती/रिपोर्टिंग अधिकारी', 'Consignee/Reporting Officer'], ['पता', 'Address'], ['मात्रा', 'Quantity'], ['डिलीवरी के दिन', 'Delivery Days']];
const blacklist = 'The bidder must upload an undertaking that the firm has not been blacklisted or debarred by any Central/State Government department or PSU as on the date of bid submission.';

// ───────────── The corpus ─────────────

export const REAL_BIDS: RealBid[] = [
  {
    file: 'real-goods-bid',
    description: 'Goods bid, OEM criteria, older "Exemption" labels, past performance in the documents list',
    bidNumber: 'GEM/2026/B/6211873',
    dated: '24-10-2026',
    interleave: false,
    details: [
      { hi: 'बिड बंद होने की तारीख/समय', en: 'Bid End Date/Time', value: '14-11-2026 13:00:00', expect: [{ key: 'bid_end', value: '2026-11-14T13:00:00+05:30' }] },
      { hi: 'बिड खुलने की तारीख/समय', en: 'Bid Opening Date/Time', value: '14-11-2026 13:30:00', expect: [{ key: 'bid_opening', value: '2026-11-14T13:30:00+05:30' }] },
      { hi: 'बिड पेशकश वैधता (बंद होने की तारीख से)', en: 'Bid Offer Validity (From End Date)', value: '90 (Days)', expect: [{ key: 'offer_validity', value: '90 days', numeric: 90 }] },
      { hi: 'मंत्रालय/राज्य का नाम', en: 'Ministry/State Name', value: 'Ministry of Home Affairs', expect: [{ key: 'ministry', value: 'Ministry of Home Affairs' }] },
      { hi: 'विभाग का नाम', en: 'Department Name', value: 'Central Armed Police Forces', expect: [{ key: 'department', value: 'Central Armed Police Forces' }] },
      { hi: 'संगठन का नाम', en: 'Organisation Name', value: 'Central Reserve Police Force', expect: [{ key: 'organisation', value: 'Central Reserve Police Force' }] },
      { hi: 'कार्यालय का नाम', en: 'Office Name', value: 'Group Centre Yelahanka', expect: [{ key: 'office', value: 'Group Centre Yelahanka' }] },
      { hi: 'कुल मात्रा', en: 'Total Quantity', value: '40', expect: [{ key: 'total_quantity', value: 40, numeric: 40 }] },
      { hi: 'वस्तु श्रेणी', en: 'Item Category', value: 'Multifunction Machine MFM (Q2)', expect: [{ key: 'item_category', value: 'Multifunction Machine MFM (Q2)' }] },
      { hi: 'अनुमानित बिड मूल्य', en: 'Estimated Bid Value', value: '18,40,000', expect: [{ key: 'estimated_value', value: '18,40,000', numeric: 1_840_000 }] },
      { hi: 'बिडर का न्यूनतम औसत वार्षिक टर्नओवर (3 वर्षों का)', en: 'Minimum Average Annual Turnover of the bidder (For 3 Years)', value: '60 Lakh (s)', expect: [{ key: 'turnover_min', value: '60 Lakh (s)', numeric: 6_000_000 }] },
      { hi: 'मूल उपकरण निर्माता का औसत टर्नओवर (पिछले 3 वर्षों का)', en: 'OEM Average Turnover (Last 3 Years)', value: '5 Crore (s)', expect: [{ key: 'oem_turnover', value: '5 Crore (s)', numeric: 50_000_000 }] },
      { hi: 'उसी/समान सेवा के लिए अपेक्षित विगत अनुभव के वर्ष', en: 'Years of Past Experience Required for same/similar service', value: '3 Year (s)', expect: [{ key: 'experience_years', value: '3 years', numeric: 3 }] },
      { hi: 'विगत निष्पादन', en: 'Past Performance', value: '30 %', expect: [{ key: 'past_performance', value: '30%', numeric: 30 }] },
      { hi: 'अनुभव के वर्षों और टर्नओवर से एमएसई छूट', en: 'MSE Exemption for Years Of Experience and Turnover', value: 'Yes', expect: yes('mse_exemption', true) },
      { hi: 'अनुभव के वर्षों और टर्नओवर से स्टार्टअप छूट', en: 'Startup Exemption for Years Of Experience and Turnover', value: 'Yes', expect: yes('startup_exemption', true) },
      docsRow(['Experience Criteria', 'Past Performance', 'Bidder Turnover', 'Certificate (Requested in ATC)', 'OEM Authorization Certificate', 'OEM Annual Turnover']),
      showDocs,
      { hi: 'बिड से रिवर्स नीलामी सक्रिय किया', en: 'Bid to RA enabled', value: 'No', expect: yes('bid_to_ra', false) },
      { hi: 'बिड का प्रकार', en: 'Type of Bid', value: 'Two Packet Bid', expect: [{ key: 'bid_type', value: 'Two Packet Bid' }] },
      techClar,
      inspection,
      { hi: 'मूल्यांकन पद्धति', en: 'Evaluation Method', value: 'Total value wise evaluation', expect: [{ key: 'evaluation_method', value: 'Total value wise evaluation' }] },
      arbitration,
      mediation,
    ],
    emd: [
      { hi: 'एडवाइजरी बैंक', en: 'Advisory Bank', value: 'State Bank of India' },
      { hi: 'ईएमडी राशि', en: 'EMD Amount', value: '36800', expect: [{ key: 'emd', value: '36800', numeric: 36_800 }] },
    ],
    epbg: [
      { hi: 'एडवाइजरी बैंक', en: 'Advisory Bank', value: 'State Bank of India' },
      { hi: 'ईपीबीजी प्रतिशत (%)', en: 'ePBG Percentage(%)', value: '3.00', expect: [{ key: 'epbg', value: '3%', numeric: 3 }] },
      { hi: 'ईपीबीजी की आवश्यक अवधि (महीने)', en: 'Duration of ePBG required (Months).', value: '14', expect: [{ key: 'epbg_duration', value: '14 months', numeric: 14 }] },
    ],
    preferences: [
      { hi: 'एमआईआई अनुपालन', en: 'MII Compliance', value: 'Yes', expect: yes('mii', true) },
      { hi: 'एमएसई खरीद वरीयता', en: 'MSE Purchase Preference', value: 'Yes', expect: yes('mse_purchase_preference', true) },
    ],
    consigneeColumns: goodsColumns,
    consignees: [{ officer: 'Insp. R Murthy', address: '560064,Group Centre CRPF, Yelahanka, Bengaluru, Karnataka', qty: 40, days: 45 }],
    consigneeExpect: [{ key: 'delivery_days', value: '45 days', numeric: 45 }, { key: 'consignee_state', value: 'Karnataka' }],
    atc: [
      { text: 'The offered product must carry BIS registration under the Compulsory Registration Scheme of MeitY. Copy of the BIS certificate must be uploaded.', expect: [{ key: 'certificate', value: 'BIS' }] },
      { text: 'Authorization from the OEM in the name of the bidder, specific to this bid, is mandatory for resellers.' },
      { text: blacklist, expect: [{ key: 'undertaking', value: 'non_blacklisting' }] },
      { text: 'Warranty: 3 years comprehensive on-site warranty from the date of installation, including toner for the first 5,000 pages.' },
    ],
  },
  {
    file: 'real-service-bid',
    description: 'Service bid with contract period, newer "Relaxation … | Complete" labels, ATC similar work and PSARA',
    bidNumber: 'GEM/2026/B/6230457',
    dated: '01-11-2026',
    interleave: false,
    details: [
      { hi: 'बिड बंद होने की तारीख/समय', en: 'Bid End Date/Time', value: '21-11-2026 15:00:00', expect: [{ key: 'bid_end', value: '2026-11-21T15:00:00+05:30' }] },
      { hi: 'बिड खुलने की तारीख/समय', en: 'Bid Opening Date/Time', value: '21-11-2026 15:30:00', expect: [{ key: 'bid_opening', value: '2026-11-21T15:30:00+05:30' }] },
      { hi: 'बिड पेशकश वैधता (बंद होने की तारीख से)', en: 'Bid Offer Validity (From End Date)', value: '120 (Days)', expect: [{ key: 'offer_validity', value: '120 days', numeric: 120 }] },
      { hi: 'मंत्रालय/राज्य का नाम', en: 'Ministry/State Name', value: 'Ministry of Finance', expect: [{ key: 'ministry', value: 'Ministry of Finance' }] },
      { hi: 'विभाग का नाम', en: 'Department Name', value: 'Department of Revenue', expect: [{ key: 'department', value: 'Department of Revenue' }] },
      { hi: 'संगठन का नाम', en: 'Organisation Name', value: 'Central Board of Indirect Taxes and Customs (CBIC)', expect: [{ key: 'organisation', value: 'Central Board of Indirect Taxes and Customs (CBIC)' }] },
      { hi: 'कार्यालय का नाम', en: 'Office Name', value: 'Pune GST Commissionerate', expect: [{ key: 'office', value: 'Pune GST Commissionerate' }] },
      { hi: 'कुल मात्रा', en: 'Total Quantity', value: '24', expect: [{ key: 'total_quantity', value: 24, numeric: 24 }] },
      { hi: 'वस्तु श्रेणी', en: 'Item Category', value: 'Security Manpower Service (Version 2.0) - Office/Commercial/Institutions/ Residential; Unarmed Security Guard', expect: [{ key: 'item_category', value: 'Security Manpower Service (Version 2.0) - Office/Commercial/Institutions/ Residential; Unarmed Security Guard' }] },
      { hi: 'अनुबंध अवधि', en: 'Contract Period', value: '2 Year(s)', expect: [{ key: 'contract_period', value: '2 years', numeric: 24 }] },
      { hi: 'अनुमानित बिड मूल्य', en: 'Estimated Bid Value', value: '96,00,000', expect: [{ key: 'estimated_value', value: '96,00,000', numeric: 9_600_000 }] },
      { hi: 'बिडर का न्यूनतम औसत वार्षिक टर्नओवर (3 वर्षों का)', en: 'Minimum Average Annual Turnover of the bidder (For 3 Years)', value: '1 Crore (s)', expect: [{ key: 'turnover_min', value: '1 Crore (s)', numeric: 10_000_000 }] },
      { hi: 'उसी/समान सेवा के लिए अपेक्षित विगत अनुभव के वर्ष', en: 'Years of Past Experience Required for same/similar service', value: '3 Year (s)', expect: [{ key: 'experience_years', value: '3 years', numeric: 3 }] },
      { hi: 'अनुभव के वर्षों और टर्नओवर से एमएसई छूट', en: 'MSE Relaxation for Years Of Experience and Turnover', value: 'Yes | Complete', expect: yes('mse_exemption', true) },
      { hi: 'अनुभव के वर्षों और टर्नओवर से स्टार्टअप छूट', en: 'Startup Relaxation for Years Of Experience and Turnover', value: 'No | Complete', expect: yes('startup_exemption', false) },
      docsRow(['Experience Criteria', 'Bidder Turnover', 'Certificate (Requested in ATC)', 'Additional Doc 1 (Requested in ATC)']),
      showDocs,
      { hi: 'बिड से रिवर्स नीलामी सक्रिय किया', en: 'Bid to RA enabled', value: 'No', expect: yes('bid_to_ra', false) },
      { hi: 'बिड का प्रकार', en: 'Type of Bid', value: 'Two Packet Bid', expect: [{ key: 'bid_type', value: 'Two Packet Bid' }] },
      techClar,
      { hi: 'मूल्यांकन पद्धति', en: 'Evaluation Method', value: 'Total value wise evaluation', expect: [{ key: 'evaluation_method', value: 'Total value wise evaluation' }] },
      arbitration,
      mediation,
    ],
    emd: [
      { hi: 'एडवाइजरी बैंक', en: 'Advisory Bank', value: 'Bank of Maharashtra' },
      { hi: 'ईएमडी राशि', en: 'EMD Amount', value: '1,92,000', expect: [{ key: 'emd', value: '1,92,000', numeric: 192_000 }] },
    ],
    epbg: [
      { hi: 'एडवाइजरी बैंक', en: 'Advisory Bank', value: 'Bank of Maharashtra' },
      { hi: 'ईपीबीजी प्रतिशत (%)', en: 'ePBG Percentage(%)', value: '5.00', expect: [{ key: 'epbg', value: '5%', numeric: 5 }] },
      { hi: 'ईपीबीजी की आवश्यक अवधि (महीने)', en: 'Duration of ePBG required (Months).', value: '26', expect: [{ key: 'epbg_duration', value: '26 months', numeric: 26 }] },
    ],
    preferences: [
      { hi: 'एमएसई खरीद वरीयता', en: 'MSE Purchase Preference', value: 'Yes', expect: yes('mse_purchase_preference', true) },
    ],
    consigneeColumns: [['क्र.सं.', 'S.No.'], ['परेषिती/रिपोर्टिंग अधिकारी', 'Consignee/Reporting Officer'], ['पता', 'Address'], ['मात्रा', 'Quantity']],
    consignees: [{ officer: 'Smt. A Kulkarni, Assistant Commissioner', address: '411001,GST Bhavan, 41-A Sassoon Road, Pune, Maharashtra', qty: 24 }],
    consigneeExpect: [{ key: 'consignee_state', value: 'Maharashtra' }],
    atc: [
      { text: 'Past Experience of Similar Services: The bidder must have successfully executed one similar work of value not less than 35% of the estimated bid value during the last three financial years. Work orders with completion certificates must be uploaded.', expect: [{ key: 'similar_work', value: '35% of estimated value (₹33,60,000)', numeric: 3_360_000 }] },
      { text: 'The bidder must hold a valid PSARA licence for the State of Maharashtra and registration with EPFO and ESIC.', expect: [{ key: 'certificate', value: 'PSARA licence' }] },
      { text: 'The bidder shall possess valid ISO 9001:2015 certification.', expect: [{ key: 'certificate', value: 'ISO 9001' }] },
      { text: blacklist, expect: [{ key: 'undertaking', value: 'non_blacklisting' }] },
    ],
  },
  {
    file: 'real-ra-bid',
    description: 'Goods bid with reverse auction (RA qualification rule), interleaved wrapped labels, no ePBG, two consignees',
    bidNumber: 'GEM/2026/B/6247781',
    dated: '28-10-2026',
    interleave: true,
    details: [
      { hi: 'बिड बंद होने की तारीख/समय', en: 'Bid End Date/Time', value: '18-11-2026 11:00:00', expect: [{ key: 'bid_end', value: '2026-11-18T11:00:00+05:30' }] },
      { hi: 'बिड खुलने की तारीख/समय', en: 'Bid Opening Date/Time', value: '18-11-2026 11:30:00', expect: [{ key: 'bid_opening', value: '2026-11-18T11:30:00+05:30' }] },
      { hi: 'बिड पेशकश वैधता (बंद होने की तारीख से)', en: 'Bid Offer Validity (From End Date)', value: '60 (Days)', expect: [{ key: 'offer_validity', value: '60 days', numeric: 60 }] },
      { hi: 'मंत्रालय/राज्य का नाम', en: 'Ministry/State Name', value: 'Uttar Pradesh', expect: [{ key: 'ministry', value: 'Uttar Pradesh' }] },
      { hi: 'विभाग का नाम', en: 'Department Name', value: 'Uttar Pradesh Basic Education Department', expect: [{ key: 'department', value: 'Uttar Pradesh Basic Education Department' }] },
      { hi: 'संगठन का नाम', en: 'Organisation Name', value: 'Samagra Shiksha Uttar Pradesh', expect: [{ key: 'organisation', value: 'Samagra Shiksha Uttar Pradesh' }] },
      { hi: 'कार्यालय का नाम', en: 'Office Name', value: 'State Project Office Lucknow', expect: [{ key: 'office', value: 'State Project Office Lucknow' }] },
      { hi: 'कुल मात्रा', en: 'Total Quantity', value: '60', expect: [{ key: 'total_quantity', value: 60, numeric: 60 }] },
      { hi: 'वस्तु श्रेणी', en: 'Item Category', value: 'Desktop Computers (Q2)', expect: [{ key: 'item_category', value: 'Desktop Computers (Q2)' }] },
      { hi: 'प्राथमिक उत्पाद श्रेणी', en: 'Primary product category', value: 'Desktop Computers' },
      { hi: 'अनुमानित बिड मूल्य', en: 'Estimated Bid Value', value: '39,00,000', expect: [{ key: 'estimated_value', value: '39,00,000', numeric: 3_900_000 }] },
      { hi: 'बिडर का न्यूनतम औसत वार्षिक टर्नओवर (3 वर्षों का)', en: 'Minimum Average Annual Turnover of the bidder (For 3 Years)', value: '1.2 Crore (s)', expect: [{ key: 'turnover_min', value: '1.2 Crore (s)', numeric: 12_000_000 }] },
      { hi: 'मूल उपकरण निर्माता का औसत टर्नओवर (पिछले 3 वर्षों का)', en: 'OEM Average Turnover (Last 3 Years)', value: '250 Crore (s)', expect: [{ key: 'oem_turnover', value: '250 Crore (s)', numeric: 2_500_000_000 }] },
      { hi: 'उसी/समान सेवा के लिए अपेक्षित विगत अनुभव के वर्ष', en: 'Years of Past Experience Required for same/similar service', value: '2 Year (s)', expect: [{ key: 'experience_years', value: '2 years', numeric: 2 }] },
      { hi: 'अनुभव के वर्षों और टर्नओवर से एमएसई छूट', en: 'MSE Relaxation for Years Of Experience and Turnover', value: 'No | Complete', expect: yes('mse_exemption', false) },
      { hi: 'अनुभव के वर्षों और टर्नओवर से स्टार्टअप छूट', en: 'Startup Relaxation for Years Of Experience and Turnover', value: 'No | Complete', expect: yes('startup_exemption', false) },
      docsRow(['Experience Criteria', 'Bidder Turnover', 'OEM Authorization Certificate', 'OEM Annual Turnover', 'Compliance of BoQ specification and supporting document']),
      showDocs,
      { hi: 'बिड से रिवर्स नीलामी सक्रिय किया', en: 'Bid to RA enabled', value: 'Yes', expect: yes('bid_to_ra', true) },
      { hi: 'आरए योग्यता नियम', en: 'RA Qualification Rule', value: 'H1-Highest Priced Bid Elimination' },
      { hi: 'बिड का प्रकार', en: 'Type of Bid', value: 'Two Packet Bid', expect: [{ key: 'bid_type', value: 'Two Packet Bid' }] },
      techClar,
      inspection,
      { hi: 'मूल्यांकन पद्धति', en: 'Evaluation Method', value: 'Total value wise evaluation', expect: [{ key: 'evaluation_method', value: 'Total value wise evaluation' }] },
    ],
    emd: [
      { hi: 'एडवाइजरी बैंक', en: 'Advisory Bank', value: 'Punjab National Bank' },
      { hi: 'ईएमडी राशि', en: 'EMD Amount', value: '78,000', expect: [{ key: 'emd', value: '78,000', numeric: 78_000 }] },
    ],
    epbg: [],
    preferences: [
      { hi: 'एमआईआई खरीद वरीयता', en: 'MII Purchase Preference', value: 'Yes', expect: yes('mii', true) },
      { hi: 'एमएसई खरीद वरीयता', en: 'MSE Purchase Preference', value: 'Yes', expect: yes('mse_purchase_preference', true) },
    ],
    consigneeColumns: goodsColumns,
    consignees: [
      { officer: 'Sri Alok Verma', address: '226001,State Project Office, Vidya Bhawan, Nishatganj, Lucknow, Uttar Pradesh', qty: 40, days: 30 },
      { officer: 'Sri N Tripathi', address: '208001,District Project Office, Kanpur Nagar, Uttar Pradesh', qty: 20, days: 30 },
    ],
    consigneeExpect: [{ key: 'delivery_days', value: '30 days', numeric: 30 }, { key: 'consignee_state', value: 'Uttar Pradesh' }],
    atc: [
      { text: 'The OEM must hold ISO 9001 and ISO 14001 certification. Copies to be uploaded with the technical bid.', expect: [{ key: 'certificate', value: 'ISO 9001' }, { key: 'certificate', value: 'ISO 14001' }] },
      { text: 'Manufacturer Authorization Form (MAF) from the OEM in the name of the bidder is mandatory.' },
      { text: 'Reverse auction: bidders qualifying after technical evaluation will be invited to the RA. The H1 bidder will be eliminated before the RA.' },
      { text: blacklist, expect: [{ key: 'undertaking', value: 'non_blacklisting' }] },
    ],
  },
];

// Both goods bids name "OEM Authorization Certificate" in the documents list, so oem_auth is read there.
for (const i of [0, 2]) REAL_BIDS[i].details.find((r) => r.en === 'Document required from seller')!.expect!.push({ key: 'oem_auth', value: true });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const bid of REAL_BIDS) {
    const { bytes, expected } = await render(bid);
    await writeFile(join(dir, `${bid.file}.pdf`), bytes);
    const json = { file: `${bid.file}.pdf`, bidNumber: bid.bidNumber, description: bid.description, layout: bid.interleave ? 'interleaved' : 'cell', fields: expected };
    await writeFile(join(dir, `${bid.file}.expected.json`), `${JSON.stringify(json, null, 2)}\n`);
    console.log(`${bid.file}.pdf  ${bytes.length} bytes  ${expected.length} fields`);
  }
}
