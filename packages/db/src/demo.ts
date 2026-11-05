/**
 * Demo dataset (T075, US7 — "explore with demo data before GeM data arrives").
 *
 *   await seedDemo(db, { orgId, userId, blobs, now })
 *   await removeDemo(db, { orgId, blobs })   // 007/FR-065 — see removeDemo() for how demo rows are recognised
 *
 * Seeds a realistic Indian IT-hardware / CCTV / networking seller ("Aarav Technologies Pvt Ltd", Pune) into an
 * organization: company profile, past contracts, vault documents (some expiring, one expired; tiny one-page
 * PDFs when a blob store is given), three watchlists, ~40 GeM-like tenders (global, upserted by bid number,
 * dates relative to `now`), watchlist matches, analyses with explainable factors, bid workspaces in every
 * pipeline stage, notifications and activity.
 *
 * Idempotent: running it again for the same org never duplicates rows (natural keys / existence checks), and a
 * profile the org already filled in is never overwritten. Tender dates are refreshed on every run.
 * Demo tenders are stored with `source = 'demo'` (and `raw.demo = true`), unique by `(source, bid_number)`, so they
 * never collide with ingested GeM rows. Read paths show them only to orgs with `onboarding_state.demo = true`
 * (apps/api/src/lib/tender-scope.ts) and watchlist matching skips them; their matches are created here, for the
 * seeding org only (008/FR-016).
 */
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  activityLog, analyses, bidWorkspaces, comments, companyProfiles, notifications, organizations, packets, pastContracts, tenderDocuments,
  tenderMatches, tenders, vaultDocuments, vaultDocumentVersions, watchlists,
  type ChecklistItem, type DocType, type Requirement, type ScoreFactor, type Stage, type WatchlistCriteria,
} from './schema';

export interface DemoBlobSink {
  put(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<unknown>;
}

export interface SeedDemoOptions {
  orgId: string;
  userId: string;
  /** When given, each vault document gets a small generated one-page PDF. */
  blobs?: DemoBlobSink | null;
  now?: Date;
  /** Runs inside the seed transaction, after the rows are written (e.g. to set `onboardingState.demo = true`). */
  afterSeed?: (tx: DemoTx, result: SeedDemoResult) => Promise<void>;
}

/** The transaction handle `seedDemo` / `removeDemo` pass to their `afterSeed` / `afterRemove` hooks. */
export type DemoTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface SeedDemoResult {
  tenders: number;
  watchlists: number;
  matches: number;
  analyses: number;
  workspaces: number;
  vaultDocuments: number;
  pastContracts: number;
  /** False when the org already had the demo dataset (nothing new was created for it). */
  created: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEMO_MARK = 'demo';
/** Seeded watchlists are back-dated by exactly this much (created_at = seed time − 16 d, updated_at = seed time). */
const DEMO_WATCHLIST_AGE_MS = 16 * DAY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The watchlist ids a `demo.seeded` entry records, or null for an entry written before ids were recorded. */
function recordedWatchlistIds(meta: unknown): string[] | null {
  const ids = (meta as { watchlistIds?: unknown } | null)?.watchlistIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)) : null;
}

/**
 * Legacy rule, only for orgs seeded before `demo.seeded` recorded watchlist ids: a `DEMO_WATCHLISTS` name, created by
 * a user who seeded the demo here, AND the seeder's exact back-dating (updated_at − created_at = 16 days to the
 * microsecond). A watchlist made through the API has created_at = updated_at (or a later edit time), so it never
 * matches; a demo watchlist the user later edited stops matching too (kept: the safe direction).
 */
async function legacyDemoWatchlistIds(db: DemoTx, orgId: string): Promise<string[]> {
  const seeders = (await db.selectDistinct({ u: activityLog.userId }).from(activityLog)
    .where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, 'demo.seeded')))).map((r) => r.u).filter((u): u is string => !!u);
  if (!seeders.length) return [];
  return (await db.select({ id: watchlists.id }).from(watchlists).where(and(
    eq(watchlists.orgId, orgId), inArray(watchlists.name, DEMO_WATCHLISTS.map((w) => w.name)), inArray(watchlists.createdBy, seeders),
    sql`${watchlists.updatedAt} - ${watchlists.createdAt} = ${`${DEMO_WATCHLIST_AGE_MS} milliseconds`}::interval`,
  ))).map((r) => r.id);
}

// ───────────── Company ─────────────

export const DEMO_COMPANY = {
  legalName: 'Aarav Technologies Pvt Ltd',
  tradeName: 'Aarav Tech',
  gstin: '27AAJCA4721K1ZK',
  pan: 'AAJCA4721K',
  cin: 'U72900PN2016PTC165432',
  udyamNumber: 'UDYAM-MH-26-0012345',
  state: 'Maharashtra',
  city: 'Pune',
} as const;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// ───────────── Tiny PDF generator (valid xref; pdf-lib can merge it) ─────────────

const pdfEscape = (s: string) => s.replace(/[^\x20-\x7e]/g, '-').replace(/([\\()])/g, '\\$1');

/** A one-page A4 PDF with a title and a few lines of text. Dependency-free. */
export function demoPdf(title: string, lines: string[]): Uint8Array {
  const text: string[] = ['BT', '/F2 18 Tf', '56 770 Td', `(${pdfEscape(title)}) Tj`, '/F1 11 Tf', '0 -30 Td'];
  for (const l of lines) text.push(`(${pdfEscape(l)}) Tj`, '0 -18 Td');
  text.push('0 -24 Td', '/F1 9 Tf', '(Sample document generated by TenderPilot demo data - not a real certificate.) Tj', 'ET');
  const stream = `0.31 0.27 0.9 RG 2 w 56 790 m 539 790 l S\n${text.join('\n')}`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// ───────────── Buyers & tender templates ─────────────

interface Buyer { ministry: string; department: string; organisation: string; office: string; state: string; city: string }
const B = (ministry: string, department: string, organisation: string, office: string, state: string, city: string): Buyer =>
  ({ ministry, department, organisation, office, state, city });

const BUYERS = {
  army: B('Ministry of Defence', 'Department of Military Affairs', 'Indian Army', 'HQ Southern Command, Pune', 'Maharashtra', 'Pune'),
  railways: B('Ministry of Railways', 'Central Railway', 'Central Railway', 'Divisional Railway Manager Office, Mumbai CSMT', 'Maharashtra', 'Mumbai'),
  aiims: B('Ministry of Health and Family Welfare', 'Department of Health and Family Welfare', 'AIIMS Nagpur', 'Stores Section, AIIMS Nagpur', 'Maharashtra', 'Nagpur'),
  crpf: B('Ministry of Home Affairs', 'Central Reserve Police Force', 'CRPF', 'Group Centre CRPF, Gandhinagar', 'Gujarat', 'Gandhinagar'),
  iitb: B('Ministry of Education', 'Department of Higher Education', 'Indian Institute of Technology Bombay', 'Purchase Office, IIT Bombay', 'Maharashtra', 'Mumbai'),
  nic: B('Ministry of Electronics and Information Technology', 'National Informatics Centre', 'NIC', 'NIC HQ, CGO Complex', 'Delhi', 'New Delhi'),
  mhPolice: B('Maharashtra', 'Home Department', 'Maharashtra State Police', 'Office of the Commissioner of Police, Pune', 'Maharashtra', 'Pune'),
  kaHealth: B('Karnataka', 'Department of Health and Family Welfare', 'Bangalore Medical College and Research Institute', 'BMCRI Stores', 'Karnataka', 'Bengaluru'),
  gtu: B('Gujarat', 'Education Department', 'Gujarat Technological University', 'GTU Purchase Cell', 'Gujarat', 'Ahmedabad'),
  bpcl: B('Ministry of Petroleum and Natural Gas', 'Department of Petroleum', 'Bharat Petroleum Corporation Limited', 'BPCL Mumbai Refinery', 'Maharashtra', 'Mumbai'),
  ntpc: B('Ministry of Power', 'Department of Power', 'NTPC Limited', 'NTPC Vindhyachal', 'Madhya Pradesh', 'Singrauli'),
  cbic: B('Ministry of Finance', 'Department of Revenue', 'Central Board of Indirect Taxes and Customs', 'Pune GST Commissionerate', 'Maharashtra', 'Pune'),
  goaEdu: B('Goa', 'Directorate of Education', 'Directorate of Education, Goa', 'DoE Panaji', 'Goa', 'Panaji'),
  mpUrban: B('Madhya Pradesh', 'Urban Development and Housing Department', 'Indore Smart City Development Limited', 'ISCDL Indore', 'Madhya Pradesh', 'Indore'),
  navy: B('Ministry of Defence', 'Department of Military Affairs', 'Indian Navy', 'Naval Dockyard, Mumbai', 'Maharashtra', 'Mumbai'),
  esic: B('Ministry of Labour and Employment', 'Employees State Insurance Corporation', 'ESIC', 'ESIC Model Hospital, Andheri', 'Maharashtra', 'Mumbai'),
  upPwd: B('Uttar Pradesh', 'Public Works Department', 'UP PWD', 'Office of the Chief Engineer, Lucknow', 'Uttar Pradesh', 'Lucknow'),
  tnHealth: B('Tamil Nadu', 'Health and Family Welfare Department', 'Tamil Nadu Medical Services Corporation', 'TNMSC Chennai', 'Tamil Nadu', 'Chennai'),
} satisfies Record<string, Buyer>;

interface Item { title: string; category: string; hsn: string; unit: string; qty: [number, number]; unitPrice: number; bidType?: 'bid' | 'ra' | 'service' }
const ITEMS: Record<string, Item> = {
  desktop: { title: 'Desktop Computers (Q2) – Intel Core i5, 16 GB RAM, 512 GB SSD, 23.8" monitor', category: 'Desktop Computers', hsn: '84714190', unit: 'nos', qty: [25, 180], unitPrice: 62_000 },
  laptop: { title: 'Laptop – Notebook (Q2), Core i7, 16 GB, 14" FHD', category: 'Laptop - Notebook', hsn: '84713010', unit: 'nos', qty: [10, 120], unitPrice: 78_000 },
  cctv: { title: 'CCTV Camera – IP Bullet 4 MP with IR, PoE (MII compliant)', category: 'CCTV Cameras', hsn: '85258900', unit: 'nos', qty: [40, 400], unitPrice: 6_800 },
  nvr: { title: 'Network Video Recorder – 32 channel with 4 x 8 TB HDD', category: 'Network Video Recorder', hsn: '85219090', unit: 'nos', qty: [2, 20], unitPrice: 95_000 },
  cctvService: { title: 'Supply, Installation, Testing & Commissioning of CCTV Surveillance System', category: 'CCTV Surveillance Service', hsn: '998713', unit: 'job', qty: [1, 1], unitPrice: 3_800_000, bidType: 'service' },
  switch: { title: 'Network Switch – Layer 2 Managed, 24 x 1G PoE+ with 4 x 10G SFP+', category: 'Network Switches', hsn: '85176290', unit: 'nos', qty: [6, 60], unitPrice: 48_000 },
  ap: { title: 'Wi-Fi 6 Access Point – Indoor, ceiling mount, controller based', category: 'Wireless Access Points', hsn: '85176290', unit: 'nos', qty: [20, 150], unitPrice: 21_000 },
  firewall: { title: 'Next Generation Firewall (NGFW) – 5 Gbps threat protection, 3-year subscription', category: 'Firewall', hsn: '84718000', unit: 'nos', qty: [1, 4], unitPrice: 640_000 },
  ups: { title: 'Online UPS 10 kVA with 30 min battery backup', category: 'UPS', hsn: '85044010', unit: 'nos', qty: [4, 30], unitPrice: 165_000 },
  mfm: { title: 'Multifunction Machine MFM (Q2) – A3 mono laser, 35 ppm, duplex', category: 'Multifunction Machines', hsn: '84433100', unit: 'nos', qty: [5, 40], unitPrice: 88_000 },
  ifp: { title: 'Interactive Flat Panel 75" 4K with OPS module', category: 'Interactive Flat Panel', hsn: '85285900', unit: 'nos', qty: [6, 50], unitPrice: 185_000 },
  server: { title: 'Rack Server – 2 x Intel Xeon Silver, 256 GB RAM, 8 x 1.92 TB SSD', category: 'Servers', hsn: '84715000', unit: 'nos', qty: [2, 10], unitPrice: 1_150_000 },
  monitor: { title: 'LED Monitor 24" IPS, Full HD (MII Class-I)', category: 'Monitors', hsn: '85285200', unit: 'nos', qty: [30, 250], unitPrice: 11_500 },
  biometric: { title: 'Biometric Attendance System – face + fingerprint, Aadhaar enabled (AEBAS)', category: 'Biometric Devices', hsn: '84719000', unit: 'nos', qty: [10, 80], unitPrice: 14_500 },
  cabling: { title: 'Structured LAN Cabling – Cat6, 300 nodes with racks and I/O', category: 'Networking Services', hsn: '998732', unit: 'job', qty: [1, 1], unitPrice: 2_400_000, bidType: 'service' },
  chairs: { title: 'Revolving Office Chair with mesh back (BIFMA)', category: 'Office Chairs', hsn: '94013000', unit: 'nos', qty: [50, 400], unitPrice: 9_200 },
  beds: { title: 'Hospital Bed – ICU, five function, motorised', category: 'Hospital Beds', hsn: '94021090', unit: 'nos', qty: [10, 60], unitPrice: 245_000 },
  dg: { title: 'Diesel Generator Set 125 kVA, CPCB IV+ compliant', category: 'Diesel Generator', hsn: '85021100', unit: 'nos', qty: [1, 4], unitPrice: 1_850_000 },
  paper: { title: 'Copier Paper A4, 75 GSM (500 sheets per ream)', category: 'Copier Paper', hsn: '48025690', unit: 'ream', qty: [1000, 8000], unitPrice: 245, bidType: 'ra' },
  tablets: { title: 'Tablet Computer 10.5" LTE, 8 GB RAM, rugged cover', category: 'Tablet Computers', hsn: '84713010', unit: 'nos', qty: [20, 200], unitPrice: 32_000 },
};

/** [item key, buyer key, end offset in hours from now] — order is stable (bid numbers derive from index). */
const TENDER_PLAN: [keyof typeof ITEMS, keyof typeof BUYERS, number][] = [
  // closed (pipeline history)
  ['desktop', 'cbic', -24 * 40], ['cctv', 'mhPolice', -24 * 26], ['switch', 'iitb', -24 * 18], ['ups', 'railways', -24 * 12],
  ['laptop', 'aiims', -24 * 6], ['cctvService', 'navy', -24 * 3],
  // closing today
  ['nvr', 'mhPolice', 5], ['monitor', 'army', 9],
  // this week
  ['desktop', 'army', 26], ['cctv', 'crpf', 40], ['ap', 'iitb', 52], ['mfm', 'goaEdu', 70], ['switch', 'bpcl', 90],
  ['firewall', 'nic', 110], ['ifp', 'gtu', 128], ['ups', 'ntpc', 150], ['biometric', 'esic', 160],
  // next weeks
  ['server', 'iitb', 24 * 8], ['cabling', 'aiims', 24 * 9], ['laptop', 'cbic', 24 * 10], ['cctvService', 'mpUrban', 24 * 11],
  ['desktop', 'esic', 24 * 12], ['monitor', 'railways', 24 * 13], ['switch', 'ntpc', 24 * 14], ['tablets', 'kaHealth', 24 * 15],
  ['cctv', 'railways', 24 * 16], ['ap', 'gtu', 24 * 17], ['mfm', 'cbic', 24 * 18], ['ups', 'navy', 24 * 19],
  ['nvr', 'crpf', 24 * 20], ['biometric', 'goaEdu', 24 * 21], ['ifp', 'kaHealth', 24 * 22], ['firewall', 'bpcl', 24 * 24],
  ['desktop', 'upPwd', 24 * 26], ['server', 'nic', 24 * 28],
  // not our business (shows filters/no-match in the feed)
  ['chairs', 'cbic', 24 * 6], ['beds', 'tnHealth', 24 * 9], ['dg', 'ntpc', 24 * 12], ['paper', 'railways', 24 * 4], ['beds', 'aiims', 24 * 15],
];

function seeded(n: number) {
  // Deterministic pseudo-random in [0,1) per index.
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

export function demoBidNumber(i: number): string {
  return `GEM/2026/B/${6_400_000 + i * 7919 + 1_337}`;
}

interface PlannedTender {
  idx: number; bidNumber: string; item: Item; buyer: Buyer; endAt: Date; startAt: Date; quantity: number; value: number; emd: number;
}

function planTenders(now: Date): PlannedTender[] {
  return TENDER_PLAN.map(([ik, bk, hours], idx) => {
    const item = ITEMS[ik]!;
    const buyer = BUYERS[bk];
    const r = seeded(idx + 1);
    const quantity = item.qty[0] === item.qty[1] ? item.qty[0] : Math.round(item.qty[0] + r * (item.qty[1] - item.qty[0]));
    const value = roundTo(quantity * item.unitPrice * (0.9 + r * 0.25), 1000);
    // EMD is usually 2–3% of the estimated value; small bids often carry none.
    const emd = value < 500_000 ? 0 : roundTo(value * (r > 0.5 ? 0.03 : 0.02), 1000);
    const endAt = new Date(now.getTime() + hours * HOUR);
    endAt.setUTCMinutes(hours < 24 && hours > 0 ? endAt.getUTCMinutes() : 30, 0, 0); // GeM bids close on the half hour (IST 15:00 etc.)
    const startAt = new Date(endAt.getTime() - (14 + Math.round(r * 10)) * DAY);
    return { idx, bidNumber: demoBidNumber(idx), item, buyer, endAt, startAt, quantity, value, emd };
  });
}

// ───────────── Watchlists ─────────────

const crit = (c: Partial<WatchlistCriteria>): WatchlistCriteria => ({
  keywords: [], excludeKeywords: [], categories: [], hsnCodes: [], states: [], ministries: [], bidTypes: [], ...c,
});

export const DEMO_WATCHLISTS: { name: string; criteria: WatchlistCriteria; match: (t: PlannedTender) => string[] | null }[] = [
  {
    name: 'IT hardware – Maharashtra & Goa',
    criteria: crit({ keywords: ['desktop', 'laptop', 'monitor', 'server', 'multifunction machine', 'tablet', 'interactive flat panel'], states: ['Maharashtra', 'Goa'] }),
    match: (t) => {
      const k = ['Desktop', 'Laptop', 'Monitor', 'Server', 'Multifunction Machine', 'Tablet', 'Interactive Flat Panel'].find((w) => t.item.title.toLowerCase().includes(w.toLowerCase()));
      return k && ['Maharashtra', 'Goa'].includes(t.buyer.state) ? [`Keyword “${k.toLowerCase()}”`, `State: ${t.buyer.state}`] : null;
    },
  },
  {
    name: 'CCTV & surveillance – West India',
    criteria: crit({ keywords: ['cctv', 'network video recorder', 'surveillance', 'biometric'], states: ['Maharashtra', 'Gujarat', 'Goa', 'Madhya Pradesh'] }),
    match: (t) => {
      const k = ['CCTV', 'Network Video Recorder', 'Surveillance', 'Biometric'].find((w) => t.item.title.toLowerCase().includes(w.toLowerCase()));
      return k && ['Maharashtra', 'Gujarat', 'Goa', 'Madhya Pradesh'].includes(t.buyer.state) ? [`Keyword “${k.toLowerCase()}”`, `State: ${t.buyer.state}`] : null;
    },
  },
  {
    name: 'Networking & power (pan-India, ≥ ₹5 L)',
    criteria: crit({ keywords: ['network switch', 'access point', 'firewall', 'lan cabling', 'ups'], minValue: 500_000 }),
    match: (t) => {
      const k = ['Network Switch', 'Access Point', 'Firewall', 'LAN Cabling', 'UPS'].find((w) => t.item.title.toLowerCase().includes(w.toLowerCase()));
      if (!k || t.value < 500_000) return null;
      return [`Keyword “${k.toLowerCase()}”`, `Value ₹${(t.value / 100_000).toFixed(1).replace(/\.0$/, '')} L+`];
    },
  },
];

// ───────────── Vault ─────────────

interface DemoDoc { type: DocType; title: string; number?: string; issuer?: string; issue?: number; expiry?: number | null; fy?: string; tags?: string[]; lines: string[] }

/** `issue`/`expiry` are day offsets from now. */
/** Seeded OEM vault letters, by the profile OEM row they back (D-Link India deliberately has none — spec 005 US2 scenario 10). */
const DEMO_OEM_DOC_TITLES: Readonly<Record<string, string>> = {
  'CP PLUS': 'OEM authorisation – CP PLUS (CCTV)',
  'Dell Technologies': 'OEM authorisation – Dell Technologies (desktops & servers)',
};

function demoDocs(): DemoDoc[] {
  const c = DEMO_COMPANY;
  return [
    { type: 'gst', title: 'GST registration certificate (Form GST REG-06)', number: c.gstin, issuer: 'Goods and Services Tax Network', issue: -2400, lines: [`GSTIN: ${c.gstin}`, `Legal name: ${c.legalName}`, 'Principal place of business: Baner, Pune 411045'] },
    { type: 'pan', title: 'PAN card – Aarav Technologies Pvt Ltd', number: c.pan, issuer: 'Income Tax Department', issue: -3500, lines: [`PAN: ${c.pan}`, `Name: ${c.legalName.toUpperCase()}`] },
    { type: 'udyam', title: 'Udyam registration certificate (Micro)', number: c.udyamNumber, issuer: 'Ministry of MSME', issue: -1300, lines: [`Udyam number: ${c.udyamNumber}`, 'Type of enterprise: Micro', 'Major activity: Manufacturing & Services'] },
    { type: 'incorporation', title: 'Certificate of incorporation', number: c.cin, issuer: 'Registrar of Companies, Pune', issue: -3600, lines: [`CIN: ${c.cin}`, 'Date of incorporation: 14 March 2016'] },
    { type: 'balance_sheet', title: 'Audited balance sheet FY 2024-25', fy: '2024-25', issuer: 'Mehta & Kulkarni, Chartered Accountants', issue: -150, lines: ['Revenue from operations: Rs 3,18,40,000', 'Net worth: Rs 1,12,60,000'] },
    { type: 'balance_sheet', title: 'Audited balance sheet FY 2023-24', fy: '2023-24', issuer: 'Mehta & Kulkarni, Chartered Accountants', issue: -510, lines: ['Revenue from operations: Rs 2,46,10,000', 'Net worth: Rs 86,40,000'] },
    { type: 'balance_sheet', title: 'Audited balance sheet FY 2022-23', fy: '2022-23', issuer: 'Mehta & Kulkarni, Chartered Accountants', issue: -880, lines: ['Revenue from operations: Rs 1,82,30,000', 'Net worth: Rs 64,90,000'] },
    { type: 'ca_turnover_certificate', title: 'CA certificate – average turnover (last 3 FYs)', issuer: 'Mehta & Kulkarni, Chartered Accountants', issue: -340, expiry: 25, lines: ['Average annual turnover FY 2022-23 to 2024-25: Rs 2,48,93,333', 'UDIN: 25104567BKCDEF1234'] },
    { type: 'iso', title: 'ISO 9001:2015 quality management certificate', number: 'QMS/IN/24/8812', issuer: 'TUV India Pvt Ltd', issue: -1085, expiry: 10, tags: ['ISO 9001'], lines: ['Scope: Supply, installation and maintenance of IT hardware, CCTV and networking systems'] },
    { type: 'oem_authorization', title: DEMO_OEM_DOC_TITLES['CP PLUS']!, issuer: 'Aditya Infotech Ltd (CP PLUS)', issue: -200, expiry: 165, tags: ['CP PLUS', 'CCTV'], lines: ['Authorised reseller and service partner for CP PLUS surveillance products, Maharashtra & Goa'] },
    { type: 'oem_authorization', title: DEMO_OEM_DOC_TITLES['Dell Technologies']!, issuer: 'Dell International Services India', issue: -370, expiry: -5, tags: ['Dell', 'Desktops'], lines: ['Authorised channel partner for Dell commercial desktops, notebooks and PowerEdge servers'] },
    { type: 'crac', title: 'CRAC – Pune Municipal Corporation CCTV (₹96 L)', issuer: 'Pune Municipal Corporation', issue: -420, tags: ['CCTV'], lines: ['Consignee receipt and acceptance certificate', 'Order value: Rs 96,40,000'] },
    { type: 'crac', title: 'CRAC – Central Railway desktop supply (₹58 L)', issuer: 'Central Railway, Mumbai Division', issue: -260, tags: ['Desktops'], lines: ['Consignee receipt and acceptance certificate', 'Order value: Rs 58,20,000'] },
    { type: 'mii_certificate', title: 'Make in India self-certificate (Class-I, 62% local content)', issuer: 'Aarav Technologies Pvt Ltd', issue: -90, lines: ['Local content: 62%', 'Class-I local supplier as per PPP-MII Order 2017'] },
    { type: 'bank_details', title: 'Cancelled cheque & bank mandate – HDFC Bank', issuer: 'HDFC Bank, Baner Branch', issue: -700, lines: ['A/c no: XXXXXXXX4821', 'IFSC: HDFC0001234'] },
  ];
}

// ───────────── Past contracts ─────────────

/** The five seeded past contracts; `gemContractNo` is their natural key (seed idempotency and removal provenance). */
function demoPastContracts(now: Date) {
  return [
    { buyer: 'Pune Municipal Corporation', buyerType: 'state' as const, title: 'CCTV surveillance for 42 ward offices (supply, installation, 3-year AMC)', category: 'CCTV Cameras', value: 9_640_000, startDate: isoDay(new Date(now.getTime() - 520 * DAY)), endDate: isoDay(new Date(now.getTime() - 420 * DAY)), gemContractNo: 'GEMC-511687712345678' },
    { buyer: 'Central Railway, Mumbai Division', buyerType: 'central' as const, title: 'Supply of 85 desktop computers with 5-year warranty', category: 'Desktop Computers', value: 5_820_000, startDate: isoDay(new Date(now.getTime() - 330 * DAY)), endDate: isoDay(new Date(now.getTime() - 260 * DAY)), gemContractNo: 'GEMC-511687723456789' },
    { buyer: 'Bharat Electronics Limited, Pune', buyerType: 'psu' as const, title: 'Managed network switches and structured cabling', category: 'Network Switches', value: 3_150_000, startDate: isoDay(new Date(now.getTime() - 700 * DAY)), endDate: isoDay(new Date(now.getTime() - 640 * DAY)), gemContractNo: 'GEMC-511687734567890' },
    { buyer: 'Maharashtra State Police', buyerType: 'state' as const, title: 'Online UPS 6 kVA for 18 police stations', category: 'UPS', value: 2_240_000, startDate: isoDay(new Date(now.getTime() - 900 * DAY)), endDate: isoDay(new Date(now.getTime() - 860 * DAY)), gemContractNo: 'GEMC-511687745678901' },
    { buyer: 'Indian Army – HQ Southern Command', buyerType: 'central' as const, title: 'Multifunction machines (A3) with toner for 3 years', category: 'Multifunction Machines', value: 1_860_000, startDate: isoDay(new Date(now.getTime() - 1100 * DAY)), endDate: isoDay(new Date(now.getTime() - 1060 * DAY)), gemContractNo: 'GEMC-511687756789012' },
  ];
}

// ───────────── Analyses ─────────────

const W = { turnover: 20, experience: 18, similarWork: 12, emd: 10, mii: 6, oem: 10, certificates: 8, documents: 8, deliveryFeasibility: 4, timeToClose: 4 } as const;
type FactorKey = keyof typeof W;
const LABELS: Record<FactorKey, string> = {
  turnover: 'Average annual turnover', experience: 'Years of experience', similarWork: 'Similar work value', emd: 'EMD (earnest money)',
  mii: 'Make in India', oem: 'OEM authorisation', certificates: 'Certificates', documents: 'Documents in vault',
  deliveryFeasibility: 'Delivery feasibility', timeToClose: 'Time to bid closing',
};

const shortInr = (n: number) => (n >= 10_000_000 ? `₹${(n / 10_000_000).toFixed(2).replace(/\.?0+$/, '')} Cr` : n >= 100_000 ? `₹${(n / 100_000).toFixed(1).replace(/\.0$/, '')} L` : `₹${n.toLocaleString('en-IN')}`);

type Profile = 'strong' | 'oem_gap' | 'turnover_gap' | 'tight' | 'far';

function buildAnalysis(t: PlannedTender, kind: Profile, now: Date) {
  const avgTurnover = 24_893_333;
  const reqTurnover = roundTo(t.value * (kind === 'turnover_gap' ? 3 : 0.6), 100_000);
  const days = Math.round((t.endAt.getTime() - now.getTime()) / DAY);
  const isCctv = /CCTV|Video|Surveillance|Biometric/i.test(t.item.title);
  const needsOem = !/service|Cabling/i.test(t.item.category) && t.item.bidType !== 'service';
  const f = (key: FactorKey, status: ScoreFactor['status'], detail: string, blocking = false, requirementKey?: string): ScoreFactor =>
    ({ key, label: LABELS[key], status, weight: W[key], blocking, detail, ...(requirementKey ? { requirementKey } : {}) });
  const factors: ScoreFactor[] = [
    kind === 'turnover_gap'
      ? f('turnover', 'fail', `Avg turnover ${shortInr(avgTurnover)} is below the required ${shortInr(reqTurnover)} (MSE exemption not allowed in this bid)`, true, 'turnover_min')
      : f('turnover', 'pass', `Avg turnover ${shortInr(avgTurnover)} ≥ required ${shortInr(reqTurnover)}`, false, 'turnover_min'),
    f('experience', 'pass', '9 years in business, 5 completed government orders ≥ 3 years required', false, 'experience_years'),
    f('similarWork', kind === 'tight' ? 'unknown' : 'pass',
      kind === 'tight' ? 'Bid asks for "similar work" without a value — check the ATC' : `Largest similar order ${shortInr(isCctv ? 9_640_000 : 5_820_000)} ≥ ${shortInr(roundTo(t.value * 0.4, 10_000))} (40% of estimate)`,
      false, 'similar_work'),
    t.emd > 0 ? f('emd', 'exempt', `EMD ${shortInr(t.emd)} exempt — registered micro enterprise (Udyam)`, false, 'emd') : f('emd', 'na', 'No EMD required for this bid', false, 'emd'),
    f('mii', 'pass', 'Class-I local supplier (62% local content) — eligible for purchase preference', false, 'mii'),
    !needsOem
      ? f('oem', 'na', 'Service bid — no OEM authorisation asked')
      : kind === 'oem_gap'
        ? f('oem', 'fail', 'OEM authorisation required; your Dell authorisation expired 5 days ago', true, 'oem_auth')
        : f('oem', 'pass', isCctv ? 'CP PLUS authorisation in vault (valid for 5 more months)' : 'OEM authorisation on file for the quoted make', false, 'oem_auth'),
    f('certificates', kind === 'far' ? 'unknown' : 'pass', kind === 'far' ? 'BIS registration asked for the product — not found in vault' : 'ISO 9001:2015 on file (renew within 10 days)'),
    f('documents', kind === 'oem_gap' ? 'unknown' : 'pass', kind === 'oem_gap' ? '9 of 10 required documents in vault — 1 expired' : '10 of 10 required documents in vault'),
    f('deliveryFeasibility', t.buyer.state === 'Maharashtra' || t.buyer.state === 'Goa' || t.buyer.state === 'Gujarat' ? 'pass' : 'unknown',
      `Delivery within 30 days to ${t.buyer.city}, ${t.buyer.state}`),
    days < 2 ? f('timeToClose', 'fail', `Closes in ${Math.max(0, Math.round((t.endAt.getTime() - now.getTime()) / HOUR))} hours — very little time to prepare`)
      : f('timeToClose', 'pass', `Closes in ${days} days — enough time to prepare`),
  ];
  let got = 0, total = 0;
  for (const x of factors) {
    if (x.status === 'na') continue;
    total += x.weight;
    if (x.status === 'pass' || x.status === 'exempt') got += x.weight;
    else if (x.status === 'unknown') got += x.weight * 0.5;
  }
  const score = Math.round((got / total) * 100);
  const blocking = factors.some((x) => x.blocking && x.status === 'fail');
  const verdict: 'go' | 'review' | 'no_go' = blocking ? 'no_go' : score >= 70 ? 'go' : score >= 40 ? 'review' : 'no_go';
  const docName = `GeM-Bidding-${t.bidNumber.split('/').pop()}.pdf`;
  const src = (page: number, quote: string) => ({ fileName: docName, page, quote });
  const requirements: Requirement[] = [
    { key: 'turnover_min', label: 'Minimum average annual turnover (last 3 years)', value: shortInr(reqTurnover), numeric: reqTurnover, mandatory: true, source: src(1, `Minimum Average Annual Turnover of the bidder (For 3 Years): ${Math.round(reqTurnover / 100_000)} Lakh (s)`), method: 'RULE', confidence: 0.95 },
    { key: 'experience_years', label: 'Years of past experience required', value: '3 years', numeric: 3, mandatory: true, source: src(1, 'Years of Past Experience Required for same/similar service: 3 Year (s)'), method: 'RULE', confidence: 0.95 },
    { key: 'emd', label: 'EMD amount', value: t.emd ? shortInr(t.emd) : 'Not required', numeric: t.emd, mandatory: t.emd > 0, source: src(2, t.emd ? `EMD Amount: ${t.emd}` : 'EMD Detail: No'), method: 'RULE', confidence: 0.98 },
    { key: 'mse_exemption', label: 'MSE exemption from experience & turnover', value: kind !== 'turnover_gap', mandatory: false, source: src(1, `MSE Exemption for Years Of Experience and Turnover: ${kind === 'turnover_gap' ? 'No' : 'Yes | Complete'}`), method: 'RULE', confidence: 0.9 },
    { key: 'mii', label: 'Make in India purchase preference', value: 'Yes', mandatory: false, source: src(2, 'MII Purchase Preference: Yes'), method: 'RULE', confidence: 0.92 },
    ...(needsOem ? [{ key: 'oem_auth', label: 'OEM authorisation certificate', value: true, mandatory: true, source: src(1, 'Document required from seller: OEM Authorization Certificate'), method: 'RULE' as const, confidence: 0.9 }] : []),
    { key: 'bid_end', label: 'Bid end date/time', value: t.endAt.toISOString(), mandatory: true, source: src(1, 'Bid End Date/Time'), method: 'RULE', confidence: 0.99 },
  ];
  const checklist: ChecklistItem[] = [
    { id: 'gst', label: 'GST registration certificate', docType: 'gst', mandatory: true, reason: 'Seller identity and tax registration (standard GeM requirement)' },
    { id: 'pan', label: 'PAN card of the firm', docType: 'pan', mandatory: true, reason: 'Seller identity (standard GeM requirement)' },
    { id: 'balance_sheets', label: 'Audited balance sheets — last 3 financial years', docType: 'balance_sheet', mandatory: true, reason: 'Turnover criterion in the bid document' },
    { id: 'ca_turnover_certificate', label: 'CA certificate of average annual turnover', docType: 'ca_turnover_certificate', mandatory: true, reason: 'Turnover criterion in the bid document' },
    { id: 'experience_proof', label: 'Work orders with completion certificates (CRAC) as proof of experience', docType: 'crac', mandatory: true, reason: 'Experience criterion (3 years)' },
    ...(needsOem ? [{ id: 'oem_authorization', label: 'OEM authorisation certificate (MAF) for this bid', docType: 'oem_authorization' as DocType, mandatory: true, reason: 'OEM authorisation listed under "Document required from seller"' }] : []),
    ...(t.emd > 0 ? [
      { id: 'udyam', label: 'Udyam registration certificate (MSE)', docType: 'udyam' as DocType, mandatory: true, reason: `Claim EMD exemption of ${shortInr(t.emd)} as a registered MSE` },
      { id: 'emd_exemption', label: 'EMD exemption declaration', docType: null, mandatory: true, reason: 'EMD is exempt for MSEs with a valid Udyam certificate', generated: 'emd_exemption' },
    ] : []),
    { id: 'mii_self_cert', label: 'Make in India self-certificate (local content %)', docType: null, mandatory: true, reason: 'MII compliance required', generated: 'mii_self_cert' },
    { id: 'non_blacklisting', label: 'Non-blacklisting / non-debarment undertaking', docType: null, mandatory: false, reason: 'Commonly requested in the ATC', generated: 'non_blacklisting' },
  ];
  const summary = verdict === 'go'
    ? `Strong fit: you meet turnover and experience, EMD is exempt as a micro enterprise, and your MII Class-I status earns purchase preference.`
    : verdict === 'review'
      ? `Mostly eligible — a couple of items need a human check before you commit (${factors.filter((x) => x.status === 'unknown').map((x) => x.label.toLowerCase()).join(', ')}).`
      : `Not eligible as things stand: ${factors.filter((x) => x.blocking && x.status === 'fail').map((x) => x.detail).join('; ')}.`;
  return { factors, score, verdict, requirements, checklist, summary, confidence: kind === 'tight' ? 0.72 : 0.88 };
}

// ───────────── Workspaces ─────────────

/** tender index → stage, analysis kind */
const PIPELINE: { idx: number; stage: Stage; kind: Profile }[] = [
  { idx: 0, stage: 'won', kind: 'strong' }, { idx: 1, stage: 'won', kind: 'strong' }, { idx: 2, stage: 'lost', kind: 'tight' },
  { idx: 3, stage: 'submitted', kind: 'strong' }, { idx: 4, stage: 'submitted', kind: 'strong' }, { idx: 5, stage: 'submitted', kind: 'tight' },
  { idx: 6, stage: 'ready', kind: 'strong' }, { idx: 9, stage: 'preparing', kind: 'strong' }, { idx: 8, stage: 'preparing', kind: 'oem_gap' },
  { idx: 10, stage: 'go', kind: 'strong' }, { idx: 13, stage: 'go', kind: 'tight' }, { idx: 11, stage: 'analysing', kind: 'strong' },
  { idx: 17, stage: 'analysing', kind: 'turnover_gap' }, { idx: 14, stage: 'identified', kind: 'far' }, { idx: 20, stage: 'identified', kind: 'strong' },
  { idx: 15, stage: 'identified', kind: 'far' },
];
/** Analysed feed tenders without a workspace. */
const EXTRA_ANALYSES: { idx: number; kind: Profile }[] = [{ idx: 7, kind: 'strong' }, { idx: 12, kind: 'tight' }, { idx: 22, kind: 'oem_gap' }, { idx: 25, kind: 'strong' }];

// ───────────── Seed ─────────────

/**
 * Seed the demo into one org. Runs in one transaction that first locks the org row — the same lock `removeDemo`
 * takes — so a seed and a removal never interleave (no demo rows left behind with `onboardingState.demo = false`),
 * and a failed seed leaves nothing half-written (in particular no watchlist missing from the `demo.seeded` record).
 */
export async function seedDemo(db: Db, opts: SeedDemoOptions): Promise<SeedDemoResult> {
  return db.transaction(async (tx) => {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, opts.orgId)).for('no key update');
    const result = await seedInTx(tx, opts);
    await opts.afterSeed?.(tx, result);
    return result;
  });
}

async function seedInTx(db: DemoTx, opts: SeedDemoOptions): Promise<SeedDemoResult> {
  const now = opts.now ?? new Date();
  const { orgId, userId } = opts;

  // Demo tenders (source 'demo', shared by demo orgs) — upsert by (source, bid number), refreshing dates so the demo always looks current.
  const plan = planTenders(now);
  const tenderRows = plan.map((t) => ({
    source: 'demo',
    bidNumber: t.bidNumber,
    gemBidId: String(8_100_000 + t.idx * 37),
    bidType: (t.item.bidType ?? 'bid') as 'bid' | 'ra' | 'service',
    title: t.item.title,
    items: [{ name: t.item.title.split(' – ')[0]!, quantity: t.quantity, unit: t.item.unit }],
    category: t.item.category,
    quantity: t.quantity,
    ministry: t.buyer.ministry,
    department: t.buyer.department,
    organisation: t.buyer.organisation,
    buyerOffice: t.buyer.office,
    state: t.buyer.state,
    city: t.buyer.city,
    startAt: t.startAt,
    endAt: t.endAt,
    openingAt: new Date(t.endAt.getTime() + 30 * 60_000),
    emdAmount: t.emd,
    estimatedValue: t.value,
    epbgPercent: t.value > 2_000_000 ? 5 : 3,
    hsnCodes: [t.item.hsn],
    status: (t.endAt < now ? 'closed' : 'open') as 'open' | 'closed',
    documentUrl: `https://bidplus.gem.gov.in/showbidDocument/${8_100_000 + t.idx * 37}`,
    sourceUrl: `https://bidplus.gem.gov.in/showbidDocument/${8_100_000 + t.idx * 37}`,
    raw: { [DEMO_MARK]: true },
    contentHash: `demo-${t.bidNumber}`,
    fetchedAt: now,
    createdAt: t.startAt,
    updatedAt: now,
  }));
  const upserted = await db.insert(tenders).values(tenderRows).onConflictDoUpdate({
    target: [tenders.source, tenders.bidNumber],
    set: {
      startAt: sql`excluded.start_at`, endAt: sql`excluded.end_at`, openingAt: sql`excluded.opening_at`, status: sql`excluded.status`,
      emdAmount: sql`excluded.emd_amount`, estimatedValue: sql`excluded.estimated_value`, fetchedAt: sql`excluded.fetched_at`, updatedAt: sql`excluded.updated_at`,
    },
  }).returning({ id: tenders.id, bidNumber: tenders.bidNumber });
  const tenderId = new Map(upserted.map((r) => [r.bidNumber, r.id]));
  const tid = (idx: number) => tenderId.get(demoBidNumber(idx))!;

  // Has this org seen the demo before? (activity marker) — org-scoped rows below are created once.
  const [marker] = await db.select({ id: activityLog.id, meta: activityLog.meta }).from(activityLog)
    .where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, 'demo.seeded'))).limit(1);
  const firstTime = !marker;

  // Company profile — never overwrite a profile the org already filled in.
  const profile = {
    orgId,
    legalName: DEMO_COMPANY.legalName, tradeName: DEMO_COMPANY.tradeName, gstin: DEMO_COMPANY.gstin, pan: DEMO_COMPANY.pan,
    cin: DEMO_COMPANY.cin, udyamNumber: DEMO_COMPANY.udyamNumber, mseCategory: 'micro' as const, mseSocialCategory: 'general' as const,
    isStartup: false, miiClass: 'class_1' as const, localContentPct: 62, incorporationDate: '2016-03-14',
    address: 'Office 402, Pride Purple Square, Baner Road, Baner, Pune', state: 'Maharashtra', pincode: '411045',
    contactName: 'Rohan Deshmukh', contactEmail: 'bids@aaravtech.in', contactPhone: '+919822012345',
    signatoryName: 'Ananya Kulkarni', signatoryDesignation: 'Director',
    financials: [
      { fy: '2022-23', turnover: 18_230_000, netWorth: 6_490_000, audited: true },
      { fy: '2023-24', turnover: 24_610_000, netWorth: 8_640_000, audited: true },
      { fy: '2024-25', turnover: 31_840_000, netWorth: 11_260_000, audited: true },
    ],
    categories: ['Desktop Computers', 'Laptop - Notebook', 'CCTV Cameras', 'Network Video Recorder', 'Network Switches', 'Wireless Access Points', 'UPS', 'Multifunction Machines'],
    hsnCodes: ['8471', '8525', '8517', '8504', '8443'],
    operatingStates: ['Maharashtra', 'Goa', 'Gujarat', 'Madhya Pradesh', 'Karnataka'],
    oemAuthorizations: [
      { oem: 'CP PLUS', products: 'IP cameras, NVRs', validTill: isoDay(new Date(now.getTime() + 165 * DAY)) },
      { oem: 'Dell Technologies', products: 'Desktops, notebooks, PowerEdge servers', validTill: isoDay(new Date(now.getTime() - 5 * DAY)) },
      { oem: 'D-Link India', products: 'Managed switches, Wi-Fi access points' },
    ],
    certifications: ['ISO 9001:2015', 'MII Class-I self-certificate'],
    maxEmdCapacity: 1_500_000,
    updatedAt: now,
  };
  const [existingProfile] = await db.select({ legalName: companyProfiles.legalName }).from(companyProfiles).where(eq(companyProfiles.orgId, orgId));
  if (!existingProfile) await db.insert(companyProfiles).values(profile);
  else if (!existingProfile.legalName.trim()) await db.update(companyProfiles).set(profile).where(eq(companyProfiles.orgId, orgId));

  // Past contracts (natural key: GeM contract number).
  const pcs = demoPastContracts(now);
  const havePc = new Set((await db.select({ n: pastContracts.gemContractNo }).from(pastContracts).where(eq(pastContracts.orgId, orgId))).map((r) => r.n));
  const newPcs = pcs.filter((p) => !havePc.has(p.gemContractNo));
  if (newPcs.length) await db.insert(pastContracts).values(newPcs.map((p) => ({ ...p, orgId, createdAt: now })));

  // Vault documents (natural key: title within org).
  const docs = demoDocs();
  const haveDoc = new Set((await db.select({ t: vaultDocuments.title }).from(vaultDocuments).where(eq(vaultDocuments.orgId, orgId))).map((r) => r.t));
  let docN = 0;
  for (const d of docs) {
    docN++;
    if (haveDoc.has(d.title)) continue;
    const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const fileName = `${slug}.pdf`;
    const blobKey = `org/${orgId}/vault/demo-${docN}-${slug}.pdf`;
    const pdf = demoPdf(d.title, [...d.lines, ...(d.number ? [`Number: ${d.number}`] : []), ...(d.issuer ? [`Issued by: ${d.issuer}`] : [])]);
    if (opts.blobs) await opts.blobs.put(blobKey, pdf, { contentType: 'application/pdf' });
    await db.insert(vaultDocuments).values({
      orgId, type: d.type, title: d.title, number: d.number ?? null, issuer: d.issuer ?? null,
      issueDate: d.issue != null ? isoDay(new Date(now.getTime() + d.issue * DAY)) : null,
      expiryDate: d.expiry != null ? isoDay(new Date(now.getTime() + d.expiry * DAY)) : null,
      financialYear: d.fy ?? null, tags: [...(d.tags ?? []), DEMO_MARK], blobKey, fileName, mimeType: 'application/pdf',
      sizeBytes: pdf.byteLength, pageCount: 1, uploadedBy: userId, createdAt: new Date(now.getTime() - (20 - docN) * DAY), updatedAt: now,
    });
  }

  // Link the demo OEM rows to their vault letters (spec 005 FR-020) whenever the stored rows are still the demo's,
  // unlinked ones — so a seed that failed after the profile insert ends linked on retry. D-Link India stays unlinked.
  const [stored] = await db.select({ oems: companyProfiles.oemAuthorizations }).from(companyProfiles).where(eq(companyProfiles.orgId, orgId));
  const isDemoOems = !!stored && stored.oems.length === profile.oemAuthorizations.length
    && stored.oems.every((o, i) => o.oem === profile.oemAuthorizations[i]!.oem && !o.documentId);
  if (isDemoOems) {
    const oemDocs = await db.select({ id: vaultDocuments.id, title: vaultDocuments.title }).from(vaultDocuments)
      .where(and(eq(vaultDocuments.orgId, orgId), eq(vaultDocuments.type, 'oem_authorization')));
    const oemAuthorizations = stored.oems.map((o) => {
      const doc = oemDocs.find((d) => d.title === DEMO_OEM_DOC_TITLES[o.oem]);
      return doc ? { ...o, documentId: doc.id } : o;
    });
    await db.update(companyProfiles).set({ oemAuthorizations }).where(eq(companyProfiles.orgId, orgId));
  }

  // Watchlists (natural key: name within org). A name the org already has is skipped — that row may be the user's
  // own, so only the ids inserted here are recorded as demo (`demo.seeded` meta.watchlistIds; see removeDemo).
  const existingWl = await db.select({ id: watchlists.id, name: watchlists.name }).from(watchlists).where(eq(watchlists.orgId, orgId));
  const wlId = new Map(existingWl.map((w) => [w.name, w.id]));
  const insertedWlIds: string[] = [];
  for (const w of DEMO_WATCHLISTS) {
    if (wlId.has(w.name)) continue;
    const [row] = await db.insert(watchlists).values({ orgId, name: w.name, criteria: w.criteria, active: true, createdBy: userId, createdAt: new Date(now.getTime() - DEMO_WATCHLIST_AGE_MS), updatedAt: now })
      .returning({ id: watchlists.id });
    wlId.set(w.name, row!.id);
    insertedWlIds.push(row!.id);
  }
  if (marker && insertedWlIds.length) {
    // A repeat seed re-created a demo watchlist the user had deleted: add it to the existing record. A marker written
    // before ids were recorded is backfilled first from the legacy fingerprint, so it is complete from now on.
    const recorded = recordedWatchlistIds(marker.meta) ?? await legacyDemoWatchlistIds(db, orgId);
    await db.update(activityLog)
      .set({ meta: sql`jsonb_set(${activityLog.meta}, '{watchlistIds}', ${JSON.stringify([...new Set([...recorded, ...insertedWlIds])])}::jsonb)` })
      .where(eq(activityLog.id, marker.id));
  }

  // Matches — spread across the last 14 days so the trend chart has a shape; unique index makes this idempotent.
  const matchRows: (typeof tenderMatches.$inferInsert)[] = [];
  for (const t of plan) {
    for (const w of DEMO_WATCHLISTS) {
      const reasons = w.match(t);
      if (!reasons) continue;
      const ageDays = t.endAt < now ? 14 : Math.min(13, Math.floor(seeded(t.idx + 99) * 14));
      const createdAt = new Date(Math.min(now.getTime() - 5 * 60_000, Math.max(t.startAt.getTime(), now.getTime() - ageDays * DAY - seeded(t.idx + 7) * 6 * HOUR)));
      matchRows.push({
        orgId, tenderId: tid(t.idx), watchlistId: wlId.get(w.name)!, reasons, relevance: 0.55 + seeded(t.idx + 3) * 0.4,
        seen: ageDays > 2, dismissed: false, createdAt,
      });
    }
  }
  if (matchRows.length) await db.insert(tenderMatches).values(matchRows).onConflictDoNothing();

  // Analyses (one per tender for this org).
  const analysed = [...PIPELINE.map((p) => ({ idx: p.idx, kind: p.kind })), ...EXTRA_ANALYSES];
  const haveAnalysis = new Set((await db.select({ t: analyses.tenderId }).from(analyses)
    .where(and(eq(analyses.orgId, orgId), inArray(analyses.tenderId, analysed.map((a) => tid(a.idx)))))).map((r) => r.t));
  let analysesCreated = 0;
  for (const a of analysed) {
    if (haveAnalysis.has(tid(a.idx))) continue;
    const t = plan[a.idx]!;
    const r = buildAnalysis(t, a.kind, now);
    const at = new Date(Math.max(t.startAt.getTime() + DAY, now.getTime() - (t.endAt < now ? 30 : 2) * DAY));
    await db.insert(analyses).values({
      orgId, tenderId: tid(a.idx), status: 'done', method: 'rules', requirements: r.requirements, factors: r.factors,
      checklist: r.checklist, score: r.score, confidence: r.confidence, verdict: r.verdict, summary: r.summary, stale: false, seeded: true,
      createdBy: userId, createdAt: at, updatedAt: at,
    });
    analysesCreated++;
  }

  // Workspaces across the pipeline.
  const positions = new Map<Stage, number>();
  const wsRows = PIPELINE.map((p) => {
    const t = plan[p.idx]!;
    const pos = (positions.get(p.stage) ?? 0) + 1;
    positions.set(p.stage, pos);
    const done = p.stage === 'submitted' || p.stage === 'won' || p.stage === 'lost';
    const submittedAt = done ? new Date(t.endAt.getTime() - 20 * HOUR) : null;
    const ourPrice = roundTo(t.value * 0.91, 100);
    return {
      orgId, tenderId: tid(p.idx), stage: p.stage, ownerId: userId, assigneeIds: [userId],
      dueAt: new Date(t.endAt.getTime() - 24 * HOUR), docMapping: {}, overrides: [], assistValues: {},
      outcome: p.stage === 'won'
        ? { result: 'won' as const, ourPrice, l1Price: ourPrice, notes: 'L1 by 1.8% — delivery in 21 days', at: new Date(t.endAt.getTime() + 6 * DAY).toISOString() }
        : p.stage === 'lost'
          ? { result: 'lost' as const, ourPrice, l1Price: roundTo(ourPrice * 0.94, 100), notes: 'L2 — the L1 quoted a non-MII make', at: new Date(t.endAt.getTime() + 5 * DAY).toISOString() }
          : null,
      submittedAt, position: pos, createdAt: new Date(t.startAt.getTime() + 2 * DAY), updatedAt: now,
    };
  });
  const insertedWs = await db.insert(bidWorkspaces).values(wsRows).onConflictDoNothing()
    .returning({ id: bidWorkspaces.id, tenderId: bidWorkspaces.tenderId, stage: bidWorkspaces.stage });

  // The Dell-desktop bid relies on the expired Dell authorisation: pin it so readiness shows a real blocker.
  const oemGap = insertedWs.find((w) => w.tenderId === tid(8));
  if (oemGap) {
    const [dell] = await db.select({ id: vaultDocuments.id }).from(vaultDocuments)
      .where(and(eq(vaultDocuments.orgId, orgId), eq(vaultDocuments.title, 'OEM authorisation – Dell Technologies (desktops & servers)')));
    if (dell) await db.update(bidWorkspaces).set({ docMapping: { oem_authorization: dell.id } }).where(eq(bidWorkspaces.id, oemGap.id));
  }

  if (firstTime) {
    // A couple of comments, notifications and an activity trail make the product feel alive.
    const byStage = (s: Stage) => insertedWs.find((w) => w.stage === s);
    const prep = byStage('preparing');
    if (prep) {
      await db.insert(comments).values([
        { orgId, workspaceId: prep.id, userId, body: 'Asked Dell for a fresh MAF for this bid — they promised it by Thursday.', createdAt: new Date(now.getTime() - 20 * HOUR) },
        { orgId, workspaceId: prep.id, userId, body: 'Technical compliance sheet is done. Price sign-off pending with Ananya.', createdAt: new Date(now.getTime() - 3 * HOUR) },
      ]);
    }
    const closingToday = plan[6]!;
    const notif = (kind: 'tender_match' | 'expiry' | 'deadline' | 'system', title: string, body: string, link: string, key: string, ageH: number, read = false) => ({
      orgId, userId, channel: 'in_app' as const, kind, title, body, link, dedupeKey: `demo:${key}`,
      status: (read ? 'read' : 'sent') as 'read' | 'sent', sentAt: new Date(now.getTime() - ageH * HOUR), readAt: read ? new Date(now.getTime() - (ageH - 1) * HOUR) : null,
      createdAt: new Date(now.getTime() - ageH * HOUR),
    });
    await db.insert(notifications).values([
      notif('deadline', 'Closes today: Network Video Recorder – Pune Police', `${closingToday.bidNumber} closes at ${closingToday.endAt.toISOString().slice(11, 16)} UTC. Packet is ready — submit on GeM yourself.`, `/tenders/${tid(6)}`, 'deadline-6', 1),
      notif('tender_match', '4 new matches for “CCTV & surveillance – West India”', 'Including CRPF Gandhinagar (₹27 L) and Central Railway (₹16 L).', '/tenders?matched=1', 'match-cctv', 3),
      notif('expiry', 'ISO 9001:2015 certificate expires in 10 days', 'Renew it with TUV India and upload the new certificate to keep 6 bids ready.', '/vault?status=expiring', 'expiry-iso', 6),
      notif('expiry', 'Dell OEM authorisation has expired', 'Two bids in your pipeline rely on it. Ask Dell for a bid-specific MAF.', '/vault?status=expired', 'expiry-dell', 30, true),
      notif('tender_match', '6 new matches for “IT hardware – Maharashtra & Goa”', 'Indian Army, ESIC and CBIC are buying desktops this month.', '/tenders?matched=1', 'match-it', 26, true),
      notif('system', 'Demo data loaded', 'Explore freely — everything here is sample data for Aarav Technologies Pvt Ltd.', '/dashboard', 'seeded', 0.05),
    ]).onConflictDoNothing();

    const act = (action: string, entityType: string, entityId: string | null, ageH: number, meta: Record<string, unknown> = {}) =>
      ({ orgId, userId, action, entityType, entityId, meta: { ...meta, [DEMO_MARK]: true }, createdAt: new Date(now.getTime() - ageH * HOUR) });
    const ws = (s: Stage) => insertedWs.find((w) => w.stage === s);
    const rows = [
      act('vault.uploaded', 'vault_document', null, 70, { title: 'Audited balance sheet FY 2024-25' }),
      act('watchlist.created', 'watchlist', wlId.get(DEMO_WATCHLISTS[1]!.name) ?? null, 66, { name: DEMO_WATCHLISTS[1]!.name }),
      act('tender.analysed', 'tender', tid(10), 50, { score: buildAnalysis(plan[10]!, 'strong', now).score, verdict: 'go', bidNumber: plan[10]!.bidNumber }),
      act('workspace.stage_changed', 'workspace', ws('go')?.id ?? null, 48, { from: 'analysing', to: 'go', tenderId: tid(10), title: plan[10]!.item.title }),
      act('workspace.outcome_recorded', 'workspace', ws('won')?.id ?? null, 40, { result: 'won', tenderId: tid(0), title: plan[0]!.item.title }),
      act('tender.analysed', 'tender', tid(8), 30, { score: buildAnalysis(plan[8]!, 'oem_gap', now).score, verdict: 'no_go', bidNumber: plan[8]!.bidNumber }),
      act('workspace.stage_changed', 'workspace', ws('preparing')?.id ?? null, 26, { from: 'go', to: 'preparing', tenderId: tid(9), title: plan[9]!.item.title }),
      act('packet.built', 'workspace', ws('ready')?.id ?? null, 8, { pages: 34, tenderId: tid(6), title: plan[6]!.item.title }),
      act('workspace.stage_changed', 'workspace', ws('ready')?.id ?? null, 7, { from: 'preparing', to: 'ready', tenderId: tid(6), title: plan[6]!.item.title }),
      act('workspace.submitted', 'workspace', ws('submitted')?.id ?? null, 4, { tenderId: tid(5), title: plan[5]!.item.title }),
      act('workspace.commented', 'workspace', prep?.id ?? null, 3, { tenderId: tid(9), excerpt: 'Technical compliance sheet is done. Price sign-off pending with Ananya.' }),
      act('demo.seeded', 'organization', orgId, 0.02, { tenders: plan.length, watchlistIds: insertedWlIds }),
    ];
    await db.insert(activityLog).values(rows);
  }

  const [counts] = await db.select({
    wl: sql<number>`(select count(*)::int from ${watchlists} where ${watchlists.orgId} = ${orgId})`,
    m: sql<number>`(select count(*)::int from ${tenderMatches} where ${tenderMatches.orgId} = ${orgId})`,
    a: sql<number>`(select count(*)::int from ${analyses} where ${analyses.orgId} = ${orgId})`,
    w: sql<number>`(select count(*)::int from ${bidWorkspaces} where ${bidWorkspaces.orgId} = ${orgId})`,
    v: sql<number>`(select count(*)::int from ${vaultDocuments} where ${vaultDocuments.orgId} = ${orgId})`,
    p: sql<number>`(select count(*)::int from ${pastContracts} where ${pastContracts.orgId} = ${orgId})`,
  }).from(sql`(select 1) as one`);
  return {
    tenders: plan.length, watchlists: counts!.wl, matches: counts!.m, analyses: counts!.a, workspaces: counts!.w,
    vaultDocuments: counts!.v, pastContracts: counts!.p, created: firstTime || analysesCreated > 0,
  };
}

// ───────────── Removal (007/FR-065, T053) ─────────────

export interface DemoBlobDeleter {
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<unknown>;
}

export interface RemoveDemoOptions {
  orgId: string;
  /** When given, the files behind the removed rows (vault documents and their versions, packets, uploaded bid documents) are deleted after commit. */
  blobs?: DemoBlobDeleter | null;
  /** Called for a blob that could not be deleted (the rows are already gone; the file is only orphaned). */
  onBlobError?: (key: string, error: unknown) => void;
  /** Runs inside the removal transaction, after the deletes (org flag, audit entry) — a failure rolls everything back. */
  afterRemove?: (tx: DemoTx, result: RemoveDemoResult) => Promise<void>;
}

/** True when `removeDemo` found nothing to remove. */
export function nothingRemoved(r: RemoveDemoResult): boolean {
  return !r.profileReset && Object.values(r).every((v) => v === 0 || v === false);
}

/** Rows removed per kind; all zeros (and `profileReset: false`) when the org has no demo data left. */
export interface RemoveDemoResult {
  workspaces: number;
  analyses: number;
  matches: number;
  comments: number;
  notifications: number;
  activity: number;
  pastContracts: number;
  vaultDocuments: number;
  watchlists: number;
  profileReset: boolean;
}

/**
 * Remove the demo dataset from one org without touching anything its users created (007/FR-065, US4-10/14).
 *
 *   const removed = await removeDemo(db, { orgId, blobs })
 *
 * Decision (T053) — demo rows are identified by PROVENANCE, not by a new `demo boolean` column:
 * every row the seeder writes already carries a marker the product never produces on its own, so a column would add a
 * migration and a write path for no extra safety. The rules mirror the seeder's own natural keys:
 *   - org work on a demo tender (`source = 'demo'`, `raw.demo = true`, or the seeder fingerprint
 *     `content_hash = 'demo-' || bid_number` — the same rules as apps/api/src/lib/tender-scope.ts): workspaces with
 *     their comments and packets, the analyses the seeder wrote (`analyses.seeded`), matches, and bid documents the org
 *     uploaded to those tenders. Demo tenders are visible only to demo orgs, so anything a user did on them (a moved
 *     card, a comment) is demo data too (spec edge case "demo removal after the user edited demo rows") — except an
 *     analysis the user ran, which stays so it keeps counting toward the monthly quota (008/FR-036; the tender is
 *     global and never deleted). Removed packets keep counting through `packet_ledger`;
 *   - watchlists: exactly the ids the seeder inserted, recorded in the org's `demo.seeded` activity entry
 *     (`meta.watchlistIds`; a repeat seed that re-creates a deleted demo watchlist appends its id). A watchlist the
 *     user made — even one with a demo name, before seeding (the seed skips that name) or re-created after deleting
 *     the demo one — is never in that list. Orgs seeded before ids were recorded fall back to the legacy fingerprint
 *     (`legacyDemoWatchlistIds`). Matches of the removed watchlists go with them;
 *   - vault documents: a seeded title AND a seeder marker (the `demo` tag or the `org/<org>/vault/demo-` blob key) —
 *     a user upload has neither; their file versions go with them. A demo document whose file the user replaced (new
 *     key without the `demo-` prefix) AND whose `demo` tag the user removed survives removal — accepted, it errs on
 *     the side of keeping a row;
 *   - past contracts: a seeded GeM contract number (`GEMC-5116877…`, the seed's natural key);
 *   - notifications: `dedupe_key LIKE 'demo:%'`, or a link to a demo tender / demo workspace;
 *   - activity: `meta.demo = true`, or an entry about a demo workspace / demo tender;
 *   - company profile: deleted (= reset to empty) only while legal name AND GSTIN still equal `DEMO_COMPANY`;
 *     a profile the user edited is kept, with links to removed demo documents cleared.
 *
 * Everything is deleted in one transaction that first locks the org row (concurrent removals — and `seedDemo`, which
 * takes the same lock — serialise; a second removal finds nothing and returns zeros). Blobs are deleted only after
 * commit, so a rollback never loses a file. `onboardingState.demo` and the `demo.removed` activity entry are the
 * caller's job, done in `afterRemove` so they commit (or roll back) with the deletes (DELETE /api/demo).
 */
export async function removeDemo(db: Db, opts: RemoveDemoOptions): Promise<RemoveDemoResult> {
  const { orgId } = opts;
  const anyOf = <T extends string>(col: Parameters<typeof inArray>[0], ids: T[]) => (ids.length ? inArray(col, ids) : sql`false`);
  const demoDocTitles = demoDocs().map((d) => d.title);
  const demoContractNos = demoPastContracts(new Date(0)).map((p) => p.gemContractNo);

  const { result, blobKeys } = await db.transaction(async (tx) => {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).for('no key update');

    const demoTenderIds = (await tx.select({ id: tenders.id }).from(tenders).where(or(
      eq(tenders.source, DEMO_MARK),
      sql`coalesce(${tenders.raw}->>'demo', '') = 'true'`,
      sql`${tenders.contentHash} = 'demo-' || ${tenders.bidNumber}`,
    ))).map((r) => r.id);
    const demoWsIds = (await tx.select({ id: bidWorkspaces.id }).from(bidWorkspaces)
      .where(and(eq(bidWorkspaces.orgId, orgId), anyOf(bidWorkspaces.tenderId, demoTenderIds)))).map((r) => r.id);
    // Read before the activity delete below removes the `demo.seeded` entries (they carry meta.demo).
    const markers = await tx.select({ meta: activityLog.meta }).from(activityLog)
      .where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, 'demo.seeded')));
    const recordedWl = markers.map((m) => recordedWatchlistIds(m.meta));
    const candidateWl = [...new Set([
      ...recordedWl.flatMap((ids) => ids ?? []),
      ...(recordedWl.some((ids) => ids === null) ? await legacyDemoWatchlistIds(tx, orgId) : []),
    ])];
    const demoWlIds = (await tx.select({ id: watchlists.id }).from(watchlists)
      .where(and(eq(watchlists.orgId, orgId), anyOf(watchlists.id, candidateWl)))).map((r) => r.id);
    const demoDocIds = (await tx.select({ id: vaultDocuments.id }).from(vaultDocuments).where(and(
      eq(vaultDocuments.orgId, orgId), inArray(vaultDocuments.title, demoDocTitles),
      // Either marker suffices. If the user replaced the file (new key, no `demo-` prefix) AND removed the `demo` tag,
      // neither is left and the document is kept: we cannot tell it from the user's own, so we err on keeping it.
      or(sql`${vaultDocuments.tags} @> ${JSON.stringify([DEMO_MARK])}::jsonb`, like(vaultDocuments.blobKey, `org/${orgId}/vault/demo-%`)),
    ))).map((r) => r.id);
    const keys: string[] = [];

    const removedComments = await tx.delete(comments)
      .where(and(eq(comments.orgId, orgId), anyOf(comments.workspaceId, demoWsIds))).returning({ id: comments.id });
    const removedPackets = await tx.delete(packets)
      .where(and(eq(packets.orgId, orgId), anyOf(packets.workspaceId, demoWsIds))).returning({ blobKey: packets.blobKey });
    keys.push(...removedPackets.map((p) => p.blobKey).filter((k): k is string => !!k));
    const linkedId = sql`substring(${notifications.link} from '^/(?:tenders|workspaces)/([0-9a-fA-F-]{36})')`;
    const linkTargets = [...demoTenderIds, ...demoWsIds];
    const removedNotes = await tx.delete(notifications).where(and(eq(notifications.orgId, orgId), or(
      like(notifications.dedupeKey, 'demo:%'),
      linkTargets.length ? sql`lower(${linkedId}) in (${sql.join(linkTargets.map((id) => sql`${id.toLowerCase()}`), sql`, `)})` : sql`false`,
    ))).returning({ id: notifications.id });
    const removedActivity = await tx.delete(activityLog).where(and(eq(activityLog.orgId, orgId), or(
      sql`${activityLog.meta}->>'demo' = 'true'`,
      and(eq(activityLog.entityType, 'workspace'), anyOf(activityLog.entityId, demoWsIds)),
      and(eq(activityLog.entityType, 'tender'), anyOf(activityLog.entityId, demoTenderIds)),
    ))).returning({ id: activityLog.id });
    const removedWs = await tx.delete(bidWorkspaces)
      .where(and(eq(bidWorkspaces.orgId, orgId), anyOf(bidWorkspaces.id, demoWsIds))).returning({ id: bidWorkspaces.id });
    // Only the analyses the seeder wrote: one the user ran on a demo tender stays (demo tenders are global and never
    // deleted) and keeps counting toward the monthly quota (008/FR-036).
    const removedAnalyses = await tx.delete(analyses)
      .where(and(eq(analyses.orgId, orgId), eq(analyses.seeded, true), anyOf(analyses.tenderId, demoTenderIds))).returning({ id: analyses.id });
    const removedMatches = await tx.delete(tenderMatches).where(and(eq(tenderMatches.orgId, orgId), or(
      anyOf(tenderMatches.tenderId, demoTenderIds), anyOf(tenderMatches.watchlistId, demoWlIds),
    ))).returning({ id: tenderMatches.id });
    const removedWl = await tx.delete(watchlists)
      .where(and(eq(watchlists.orgId, orgId), anyOf(watchlists.id, demoWlIds))).returning({ id: watchlists.id });
    const removedTenderDocs = await tx.delete(tenderDocuments)
      .where(and(eq(tenderDocuments.orgId, orgId), anyOf(tenderDocuments.tenderId, demoTenderIds))).returning({ blobKey: tenderDocuments.blobKey });
    keys.push(...removedTenderDocs.map((d) => d.blobKey));

    // US4-14: a profile that still holds the demo company goes back to empty (no row = empty profile).
    const resetProfile = await tx.delete(companyProfiles).where(and(
      eq(companyProfiles.orgId, orgId), eq(companyProfiles.legalName, DEMO_COMPANY.legalName), eq(companyProfiles.gstin, DEMO_COMPANY.gstin),
    )).returning({ orgId: companyProfiles.orgId });

    // Kept rows must not point at removed demo documents (same unlinking as DELETE /vault/:id).
    if (demoDocIds.length) {
      await tx.update(pastContracts).set({ cracDocumentId: null })
        .where(and(eq(pastContracts.orgId, orgId), inArray(pastContracts.cracDocumentId, demoDocIds)));
      const docList = sql.join(demoDocIds.map((id) => sql`${id.toLowerCase()}`), sql`, `);
      await tx.update(companyProfiles).set({
        oemAuthorizations: sql`(select coalesce(jsonb_agg(case when lower(e->>'documentId') in (${docList}) then jsonb_set(e, '{documentId}', 'null'::jsonb) else e end order by i), '[]'::jsonb)
          from jsonb_array_elements(${companyProfiles.oemAuthorizations}) with ordinality as t(e, i))`,
      }).where(and(eq(companyProfiles.orgId, orgId), sql`exists (select 1 from jsonb_array_elements(${companyProfiles.oemAuthorizations}) as o(e) where lower(e->>'documentId') in (${docList}))`));
    }
    const removedPcs = await tx.delete(pastContracts)
      .where(and(eq(pastContracts.orgId, orgId), inArray(pastContracts.gemContractNo, demoContractNos))).returning({ id: pastContracts.id });
    const removedVersions = await tx.delete(vaultDocumentVersions)
      .where(and(eq(vaultDocumentVersions.orgId, orgId), anyOf(vaultDocumentVersions.documentId, demoDocIds))).returning({ blobKey: vaultDocumentVersions.blobKey });
    const removedDocs = await tx.delete(vaultDocuments)
      .where(and(eq(vaultDocuments.orgId, orgId), anyOf(vaultDocuments.id, demoDocIds))).returning({ blobKey: vaultDocuments.blobKey });
    keys.push(...removedDocs.map((d) => d.blobKey), ...removedVersions.map((v) => v.blobKey));

    const result: RemoveDemoResult = {
      workspaces: removedWs.length, analyses: removedAnalyses.length, matches: removedMatches.length, comments: removedComments.length,
      notifications: removedNotes.length, activity: removedActivity.length, pastContracts: removedPcs.length,
      vaultDocuments: removedDocs.length, watchlists: removedWl.length, profileReset: resetProfile.length > 0,
    };
    await opts.afterRemove?.(tx, result);
    return { blobKeys: keys, result };
  });

  // After commit only: a failed delete orphans a file, it never loses one that a row still points at.
  if (opts.blobs) {
    for (const key of new Set(blobKeys)) {
      try { await opts.blobs.delete(key); } catch (e) { opts.onBlobError?.(key, e); }
    }
  }
  return result;
}
