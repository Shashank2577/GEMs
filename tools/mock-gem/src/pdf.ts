/**
 * Bid-document PDFs for the mock BidPlus server.
 *
 * Preferred path: the Analyse module's realistic generator (`@tp/core/analyse/sample-bid`), fed with a
 * spec derived from the listing doc, so the analyser sees GeM's real label layout. Fallback (if that
 * module is missing or throws): a minimal built-in generator that still prints every standard label.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { toGemDocDate } from '@tp/core/gem/normalize';
import type { NormalizedTender } from '@tp/core/gem/parse';

/** Deterministic "random" in [0,1) from a bid id + salt. */
function rand(id: number, salt: number): number {
  const x = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const fmtIN = (n: number) => {
  const s = Math.round(n).toString();
  if (s.length <= 3) return s;
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
};

const lakhCrore = (n: number) => (n >= 1e7 ? `${+(n / 1e7).toFixed(2)} Crore (s)` : `${+(n / 1e5).toFixed(2)} Lakh (s)`);

/** Every value printed in a mock bid document, derived deterministically from the listing. */
export interface BidDocFacts {
  bidNumber: string;
  endAt: Date;
  openingAt: Date;
  ministry: string;
  department: string;
  organisation: string;
  office: string;
  quantity: number;
  itemCategory: string;
  estimatedValue: number | null;
  turnover: number | null;
  experienceYears: number | null;
  mseExemption: boolean;
  startupExemption: boolean;
  documentsRequired: string[];
  emd: number | null;
  epbgPercent: number | null;
  mii: boolean;
  msePreference: boolean;
  evaluationMethod: string;
  bidToRa: boolean;
  deliveryDays: number;
  consigneeState: string;
  isService: boolean;
  similarWorkPct: number | null;
}

export function bidDocFacts(t: NormalizedTender): BidDocFacts {
  const id = Number(t.gemBidId ?? '1') || 1;
  const isService = t.bidType === 'service';
  const value = t.estimatedValue ?? (t.emdAmount ? t.emdAmount * 40 : null);
  // Turnover asked ≈ 30–60% of the estimated value (GeM default practice), rounded to ₹1 L.
  const turnover = value ? Math.max(1e5, Math.round((value * (0.3 + rand(id, 1) * 0.3)) / 1e5) * 1e5) : null;
  const experienceYears = isService ? 3 : rand(id, 2) < 0.6 ? 2 : rand(id, 3) < 0.5 ? 1 : null;
  const end = t.endAt ?? new Date(Date.now() + 10 * 86_400_000);
  const docs = ['Experience Criteria', 'Bidder Turnover', 'Certificate (Requested in ATC)', 'OEM Authorization Certificate', 'Additional Doc 1 (Requested in ATC)'];
  if (isService) docs.splice(3, 1, 'Compliance of BoQ specification and supporting document');
  return {
    bidNumber: t.bidNumber,
    endAt: end,
    openingAt: new Date(end.getTime() + 30 * 60_000),
    ministry: t.ministry ?? 'Ministry of Finance',
    department: t.department ?? 'Department of Expenditure',
    organisation: t.organisation ?? t.department ?? 'NA',
    office: t.buyerOffice ?? `${t.department ?? 'Buyer office'}${t.state ? `, ${t.state}` : ''}`,
    quantity: t.quantity ?? 1,
    itemCategory: (t.items.map((i) => i.name).join(', ') || t.title).slice(0, 240),
    estimatedValue: t.estimatedValue,
    turnover,
    experienceYears,
    mseExemption: rand(id, 4) < 0.7,
    startupExemption: rand(id, 5) < 0.6,
    documentsRequired: docs,
    emd: t.emdAmount && t.emdAmount > 0 ? t.emdAmount : null,
    epbgPercent: rand(id, 6) < 0.25 ? null : [2, 3, 5][Math.floor(rand(id, 7) * 3)],
    mii: !isService,
    msePreference: rand(id, 8) < 0.8,
    evaluationMethod: t.items.length > 1 && rand(id, 9) < 0.5 ? 'Item wise evaluation/' : 'Total value wise evaluation',
    bidToRa: t.bidType !== 'service' && rand(id, 10) < 0.5,
    deliveryDays: isService ? 365 : [30, 45, 60, 90][Math.floor(rand(id, 11) * 4)],
    consigneeState: t.state ?? 'Delhi',
    isService,
    similarWorkPct: isService || rand(id, 12) < 0.5 ? [30, 40, 50][Math.floor(rand(id, 13) * 3)] : null,
  };
}

const ATC = [
  'Bidders shall upload valid GST registration certificate and PAN of the firm.',
  'The bidder must not be blacklisted/debarred by any Central/State Government department or PSU. An undertaking to this effect must be uploaded.',
  'Warranty: The offered products/services shall carry a minimum comprehensive on-site warranty of 3 years.',
  'Payment shall be released within 30 days of successful delivery, installation and acceptance by the consignee.',
];

/** Try the Analyse module's generator; fall back to the built-in one. */
export async function renderBidPdf(t: NormalizedTender): Promise<Uint8Array> {
  const f = bidDocFacts(t);
  try {
    const mod = (await import('@tp/core/analyse/sample-bid')) as { generateBidPdf?: (spec: unknown) => Promise<Uint8Array> };
    if (typeof mod.generateBidPdf === 'function') {
      return await mod.generateBidPdf({
        key: `mock-${t.gemBidId}`,
        bidNumber: f.bidNumber,
        bidEndAt: toGemDocDate(f.endAt),
        bidOpeningAt: toGemDocDate(f.openingAt),
        offerValidityDays: 120,
        ministry: f.ministry,
        department: f.department,
        organisation: f.organisation,
        office: f.office,
        totalQuantity: f.quantity,
        itemCategory: f.itemCategory,
        turnover: f.turnover ? lakhCrore(f.turnover) : null,
        oemTurnover: null,
        experienceYears: f.experienceYears,
        mseExemption: f.mseExemption,
        startupExemption: f.startupExemption,
        documentsRequired: f.documentsRequired,
        pastPerformancePct: null,
        bidToRa: f.bidToRa,
        bidType: 'Two Packet Bid',
        evaluationMethod: f.evaluationMethod,
        estimatedValue: f.estimatedValue,
        emd: f.emd ? { amount: f.emd, advisoryBank: 'State Bank of India' } : null,
        epbg: f.epbgPercent ? { percent: f.epbgPercent, durationMonths: 38 } : null,
        miiCompliance: f.mii,
        msePurchasePreference: f.msePreference,
        deliveryDays: f.deliveryDays,
        consignee: { state: f.consigneeState, address: f.office },
        similarWorkPct: f.similarWorkPct,
        atcClauses: ATC,
      });
    }
  } catch {
    /* fall through to the built-in generator */
  }
  return renderBuiltinPdf(f);
}

/** Minimal GeM-style bid document with all standard labels (no external dependency). */
export async function renderBuiltinPdf(f: BidDocFacts): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Bid Document ${f.bidNumber}`);
  doc.setCreator('TenderPilot mock-gem');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595.28, 841.89]);
  let y = 790;
  const line = (label: string, value: string) => {
    if (y < 70) { page = doc.addPage([595.28, 841.89]); y = 790; }
    page.drawText(label, { x: 48, y, size: 9, font: bold, color: rgb(0.1, 0.1, 0.1), maxWidth: 260 });
    page.drawText(value, { x: 320, y, size: 9, font, color: rgb(0.1, 0.1, 0.1), maxWidth: 230 });
    y -= 22;
  };
  page.drawText(`Bid Number: ${f.bidNumber}`, { x: 48, y, size: 13, font: bold, color: rgb(0.05, 0.1, 0.35) });
  y -= 30;
  line('Bid End Date/Time', toGemDocDate(f.endAt));
  line('Bid Opening Date/Time', toGemDocDate(f.openingAt));
  line('Ministry/State Name', f.ministry);
  line('Department Name', f.department);
  line('Organisation Name', f.organisation);
  line('Office Name', f.office);
  line('Total Quantity', String(f.quantity));
  line('Item Category', f.itemCategory.slice(0, 60));
  if (f.estimatedValue) line('Estimated Bid Value', fmtIN(f.estimatedValue));
  if (f.turnover) line('Minimum Average Annual Turnover of the bidder (For 3 Years)', lakhCrore(f.turnover));
  if (f.experienceYears != null) line('Years of Past Experience Required for same/similar service', `${f.experienceYears} Year (s)`);
  line('MSE Exemption for Years Of Experience and Turnover', f.mseExemption ? 'Yes' : 'No');
  line('Startup Exemption for Years Of Experience and Turnover', f.startupExemption ? 'Yes' : 'No');
  line('Document required from seller', f.documentsRequired.join(', ').slice(0, 60));
  line('Bid to RA enabled', f.bidToRa ? 'Yes' : 'No');
  line('Evaluation Method', f.evaluationMethod);
  if (f.emd) line('EMD Amount', fmtIN(f.emd));
  if (f.epbgPercent) line('ePBG Percentage(%)', f.epbgPercent.toFixed(2));
  line('MII Compliance', f.mii ? 'Yes' : 'No');
  line('MSE Purchase Preference', f.msePreference ? 'Yes' : 'No');
  line('Delivery Days', String(f.deliveryDays));
  return doc.save();
}
