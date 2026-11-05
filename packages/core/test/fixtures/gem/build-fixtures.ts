/**
 * Builds the recorded-style BidPlus fixtures (`page-*.json`, `extra-bids.json`) from a compact table.
 * Shapes mirror GeM's `POST /all-bids-data` responses (Solr docs with 1-element array values,
 * IST wall-clock dates with a "Z" suffix). Values are synthetic but realistic.
 *
 *   pnpm exec tsx packages/core/test/fixtures/gem/build-fixtures.ts
 *
 * All dates are relative to FIXTURE_REFERENCE_DATE (2026-11-04 10:00 IST); tools/mock-gem rebases
 * them to "now" so bids stay open.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_REFERENCE_DATE = '2026-11-04T04:30:00.000Z'; // 10:00 IST

interface Row {
  id: number;
  short: string;
  long?: string;
  qty: number;
  min: string;
  dept: string;
  org?: string;
  office?: string;
  start: number; // days relative to reference (negative = past)
  end: number; // days relative to reference
  endHour?: number; // IST hour
  emd?: string | number;
  value?: string | number;
  hsn?: string[];
  type?: 1 | 2 | 5;
  bunch?: boolean;
  service?: boolean;
  highValue?: boolean;
}

const rows: Row[] = [
  { id: 7421001, short: 'Laptop - Notebook', long: 'Laptop - Notebook (Q2)', qty: 120, min: 'Maharashtra', dept: 'School Education and Sports Department', office: 'Directorate of School Education, Pune', start: -1, end: 14, emd: '2.4 Lakh', value: '96 Lakh', hsn: ['84713010'] },
  { id: 7421002, short: 'Network Video Recorder,CCTV Camera (V2)', long: 'Network Video Recorder (NVR) (Q2), CCTV Camera (V2) (Q2), PoE Switch (Q2)', qty: 86, min: 'Ministry of Home Affairs', dept: 'Central Reserve Police Force', office: 'Group Centre CRPF, Bengaluru', start: -2, end: 12, emd: 180000, value: '72 Lakh', hsn: ['85258020', '85219090'] },
  { id: 7421003, short: 'Manpower Outsourcing Services - Minimum wage - Unskilled; Others; Admin', qty: 45, min: 'Uttar Pradesh', dept: 'Medical Health and Family Welfare Department', office: 'Chief Medical Officer, Lucknow', start: -3, end: 9, emd: '3.6 Lakh', value: '1.8 Crore', service: true },
  { id: 7421004, short: 'Office Chair (V3)', long: 'Office Chair (V3) (Q2), Steel Almirah (Q2), Office Table (Q2)', qty: 210, min: 'Ministry of Defence', dept: 'Department of Military Affairs', org: 'Indian Army', start: -1, end: 18, emd: '1.1 Lakh', hsn: ['94013000', '94031000'] },
  { id: 7421005, short: 'Multiparameter Patient Monitor (V2)', long: 'Multiparameter Patient Monitor (V2) (Q2), ECG Machine 12 Channel (Q2)', qty: 30, min: 'Ministry of Health and Family Welfare', dept: 'Department of Health and Family Welfare', org: 'All India Institute of Medical Sciences (AIIMS)', office: 'AIIMS Bhubaneswar', start: -4, end: 7, emd: '4 Lakh', value: '1.6 Crore', hsn: ['90181930'] },
  { id: 7421006, short: 'Grid Connected Solar PV Power Plant (Rooftop) with Installation', qty: 1, min: 'Rajasthan', dept: 'Energy Department', office: 'Rajasthan Renewable Energy Corporation, Jaipur', start: -2, end: 21, emd: '12 Lakh', value: '6.25 Crore', service: true, highValue: true },
  { id: 7421007, short: 'Monthly Basis Cab & Taxi Hiring Services - Sedan; 2500 km x 320 hours', qty: 6, min: 'Ministry of Finance', dept: 'Department of Revenue', org: 'Central Board of Indirect Taxes and Customs (CBIC)', office: 'Commissionerate of CGST, Chennai', start: -1, end: 10, emd: 0, value: '28.8 Lakh', service: true },
  { id: 7421008, short: 'Housekeeping and Cleaning Services - Office; Mechanised', qty: 1, min: 'Ministry of Railways', dept: 'Indian Railways', org: 'South Central Railway', office: 'Divisional Railway Manager Office, Secunderabad', start: -5, end: 6, emd: '2.5 Lakh', value: '1.25 Crore', service: true },
  { id: 7421009, short: 'Desktop Computers (Q2)', long: 'Desktop Computers (Q2), Line Interactive UPS with AVR (V2) (Q2)', qty: 150, min: 'Gujarat', dept: 'Education Department', office: 'Gujarat Council of School Education, Gandhinagar', start: -1, end: 15, emd: '3 Lakh', value: '1.05 Crore', hsn: ['84714190'] },
  { id: 7421010, short: 'Laptop - Notebook', long: 'Laptop - Notebook (Q2), Laptop Bag (Q4)', qty: 40, min: 'Ministry of Electronics and Information Technology', dept: 'Department of Electronics and Information Technology', org: 'National Informatics Centre (NIC)', office: 'NIC State Centre, Mumbai', start: 0, end: 11, emd: '1 Lakh', hsn: ['84713010'] },
  { id: 7421011, short: 'Multifunction Machine MFM (V2)', qty: 25, min: 'Karnataka', dept: 'Revenue Department', office: 'Deputy Commissioner Office, Mysuru', start: -2, end: 8, emd: 50000, value: '22 Lakh', hsn: ['84433100'] },
  { id: 7421012, short: 'Security Manpower Service (Version 2.0) - Office/Commercial/Institutions/ Residential; Unarmed Security Guard', qty: 1, min: 'Ministry of Education', dept: 'Department of Higher Education', org: 'Indian Institute of Technology (IIT)', office: 'IIT Kharagpur', start: -3, end: 13, emd: '4.2 Lakh', value: '2.1 Crore', service: true },
  { id: 7421013, short: 'Ambulance (Type B) (V2)', qty: 8, min: 'Bihar', dept: 'Health Department', office: 'State Health Society, Patna', start: -1, end: 17, emd: '6 Lakh', value: '2.4 Crore', hsn: ['87039000'] },
  { id: 7421014, short: 'Diesel Generator Set (V2) 125 kVA', qty: 4, min: 'Ministry of Power', dept: 'Central Public Sector Enterprise', org: 'NTPC Limited', office: 'NTPC Korba, Chhattisgarh', start: -2, end: 19, emd: '2 Lakh', hsn: ['85021320'] },
  { id: 7421015, short: 'Hiring of Consultants - Milestone/Deliverable Based - IT Consultants', qty: 1, min: 'Telangana', dept: 'Information Technology, Electronics and Communications Department', office: 'Telangana State Technology Services, Hyderabad', start: -1, end: 16, emd: '1.5 Lakh', value: '75 Lakh', service: true },
  { id: 7421016, short: 'Hospital Bed (V3)', long: 'Hospital Bed (V3) (Q2), Bedside Locker (Q2), Mattress for Hospital Bed (Q2)', qty: 300, min: 'Ministry of Defence', dept: 'Department of Ex-Servicemen Welfare', org: 'Armed Forces Medical Services', office: 'Command Hospital (Southern Command), Pune', start: -6, end: 5, emd: '1.8 Lakh', value: '90 Lakh', hsn: ['94029090'] },
  { id: 7421017, short: 'Solar Street Light (V2)', qty: 1200, min: 'Madhya Pradesh', dept: 'New and Renewable Energy Department', office: 'MP Urja Vikas Nigam, Bhopal', start: -2, end: 20, emd: '5 Lakh', value: '3.6 Crore', hsn: ['94054090'], highValue: true },
  { id: 7421018, short: 'Interactive Panel (V2)', long: 'Interactive Panel (V2) (Q2), Document Camera (Q3)', qty: 90, min: 'Delhi', dept: 'Directorate of Education', office: 'Directorate of Education, GNCTD, New Delhi', start: -1, end: 12, emd: '2.7 Lakh', value: '1.35 Crore', hsn: ['84716060'] },
  { id: 7421019, short: 'Fogging Machine (Q3)', qty: 60, min: 'West Bengal', dept: 'Urban Development and Municipal Affairs Department', office: 'Kolkata Municipal Corporation', start: -3, end: 4, emd: 30000, hsn: ['84242000'] },
  { id: 7421020, short: 'Printer Cartridge / Toner (Q3)', long: 'Toner Cartridges / Ink Cartridges / Consumables for Printers (Q3)', qty: 640, min: 'Ministry of Coal', dept: 'Central Public Sector Enterprise', org: 'Coal India Limited', office: 'Central Coalfields Limited, Ranchi', start: -1, end: 9, emd: 40000, hsn: ['84439959'] },
  { id: 7421021, short: 'Laptop - Notebook', qty: 18, min: 'Kerala', dept: 'Kerala State IT Mission', office: 'Kerala State IT Mission, Thiruvananthapuram', start: -2, end: 2, endHour: 15, emd: 45000, value: '14.4 Lakh', hsn: ['84713010'] },
  { id: 7421022, short: 'Custom Bid for Services - Annual Maintenance Contract of CCTV Surveillance System', qty: 1, min: 'Ministry of Railways', dept: 'Indian Railways', org: 'Western Railway', office: 'Western Railway HQ, Mumbai', start: -1, end: 14, emd: '1.2 Lakh', value: '60 Lakh', service: true },
  { id: 7421023, short: 'Steel Almirah (V2)', qty: 75, min: 'Odisha', dept: 'Panchayati Raj and Drinking Water Department', office: 'Block Development Office, Cuttack', start: -2, end: 10, emd: 25000 },
  { id: 7421024, short: 'Ventilator (V2)', long: 'ICU Ventilator (V2) (Q2), High Flow Nasal Cannula (Q3)', qty: 12, min: 'Tamil Nadu', dept: 'Health and Family Welfare Department', office: 'Tamil Nadu Medical Services Corporation, Chennai', start: -3, end: 11, emd: '5.5 Lakh', value: '2.75 Crore', hsn: ['90192090'] },
  { id: 7421025, short: 'Supply of Desktop Computers', qty: 60, min: 'Ministry of Finance', dept: 'Department of Financial Services', org: 'State Bank of India', office: 'SBI Local Head Office, Ahmedabad', start: 0, end: 13, emd: '1.5 Lakh', hsn: ['84714190'], type: 2 },
  { id: 7421026, short: 'Goods Transport Service - Per Trip based Service - Truck; 9 MT', qty: 1, min: 'Ministry of Consumer Affairs, Food and Public Distribution', dept: 'Department of Food and Public Distribution', org: 'Food Corporation of India', office: 'FCI District Office, Bathinda', start: -2, end: 9, emd: '3 Lakh', value: '1.5 Crore', service: true },
  { id: 7421027, short: 'Smart Card Based Access Control System', long: 'Access Control System (Q2), Biometric Attendance Machine (Q2)', qty: 35, min: 'Ministry of Home Affairs', dept: 'Border Security Force', office: 'BSF Frontier HQ, Jammu', start: -1, end: 15, emd: 60000, hsn: ['84718000'] },
  { id: 7421028, short: 'Tractor (V2)', qty: 10, min: 'Punjab', dept: 'Agriculture and Farmers Welfare Department', office: 'Punjab Agricultural University, Ludhiana', start: -4, end: 8, emd: '2.6 Lakh', value: '1.3 Crore', hsn: ['87019100'] },
  { id: 7421029, short: 'Hiring of Event or Seminar or Workshop or Exhibition or Expo Management Service', qty: 1, min: 'Ministry of Tourism', dept: 'Department of Tourism', office: 'India Tourism, Kolkata', start: -1, end: 7, emd: 0, value: '35 Lakh', service: true },
  { id: 7421030, short: 'Server (Q2)', long: 'Rack Server (Q2), Storage Area Network (Q2), Network Switch (Q2)', qty: 14, min: 'Ministry of Electronics and Information Technology', dept: 'Department of Electronics and Information Technology', org: 'Centre for Development of Advanced Computing (C-DAC)', office: 'C-DAC Pune', start: -3, end: 22, emd: '8 Lakh', value: '4 Crore', hsn: ['84715000'], highValue: true },
  { id: 7421031, short: 'School Furniture - Dual Desk (V2)', qty: 2500, min: 'Uttar Pradesh', dept: 'Basic Education Department', office: 'Basic Shiksha Adhikari, Varanasi', start: -2, end: 12, emd: '7.5 Lakh', value: '3.75 Crore', hsn: ['94036000'], bunch: true },
  { id: 7421032, short: 'Hiring of Sanitation Service - Hospitals', qty: 1, min: 'Assam', dept: 'Health and Family Welfare Department', office: 'Gauhati Medical College and Hospital, Guwahati', start: -1, end: 16, emd: '2.2 Lakh', value: '1.1 Crore', service: true },
  { id: 7421033, short: 'Water Purifier / RO Plant (Q3)', qty: 140, min: 'Ministry of Jal Shakti', dept: 'Department of Drinking Water and Sanitation', office: 'Jal Jeevan Mission, Dehradun', start: -1, end: 10, emd: 70000, hsn: ['84212120'] },
  { id: 7421034, short: 'Laptop - Notebook', long: 'Laptop - Notebook (Q2), Wireless Keyboard and Mouse (Q3)', qty: 64, min: 'Ministry of Defence', dept: 'Department of Defence Production', org: 'Bharat Electronics Limited (BEL)', office: 'BEL Bengaluru Complex', start: 0, end: 18, emd: '1.6 Lakh', value: '64 Lakh', hsn: ['84713010'], type: 5 },
  { id: 7421035, short: 'Electric Vehicle - Passenger Car (Q2)', qty: 20, min: 'Haryana', dept: 'Transport Department', office: 'Haryana Roadways, Gurugram', start: -2, end: 14, emd: '6 Lakh', value: '3 Crore', hsn: ['87038040'] },
  { id: 7421036, short: 'Pest Control Service - Residential/Office', qty: 1, min: 'Ministry of Housing and Urban Affairs', dept: 'Central Public Works Department (CPWD)', office: 'CPWD Division, Nagpur', start: -1, end: 9, emd: 20000, value: '9.6 Lakh', service: true },
];

/** Bids "published" later by tools/mock-gem `/__admin/publish` (simulating new tenders). */
const extraRows: Row[] = [
  { id: 7421101, short: 'Laptop - Notebook', long: 'Laptop - Notebook (Q2)', qty: 75, min: 'Maharashtra', dept: 'Higher and Technical Education Department', office: 'Directorate of Technical Education, Mumbai', start: 0, end: 15, emd: '1.5 Lakh', value: '60 Lakh', hsn: ['84713010'] },
  { id: 7421102, short: 'CCTV Camera (V2)', long: 'CCTV Camera (V2) (Q2), Network Video Recorder (NVR) (Q2)', qty: 220, min: 'Maharashtra', dept: 'Home Department', office: 'Commissioner of Police, Nagpur', start: 0, end: 18, emd: '2.8 Lakh', value: '1.4 Crore', hsn: ['85258020'] },
  { id: 7421103, short: 'Manpower Outsourcing Services - Fixed Remuneration - Data Entry Operator', qty: 30, min: 'Rajasthan', dept: 'Department of Information Technology and Communication', office: 'RajCOMP Info Services, Jaipur', start: 0, end: 12, emd: '1.8 Lakh', value: '90 Lakh', service: true },
  { id: 7421104, short: 'Solar Power Pack (Q2)', qty: 400, min: 'Ministry of New and Renewable Energy', dept: 'Department of New and Renewable Energy', org: 'Solar Energy Corporation of India', office: 'SECI, New Delhi', start: 0, end: 20, emd: '4 Lakh', value: '2 Crore', hsn: ['85414300'] },
  { id: 7421105, short: 'Office Chair (V3)', qty: 180, min: 'Karnataka', dept: 'Urban Development Department', office: 'Bruhat Bengaluru Mahanagara Palike', start: 0, end: 11, emd: 80000, hsn: ['94013000'] },
  { id: 7421106, short: 'Hiring of Vehicles - Monthly basis - SUV', qty: 12, min: 'Gujarat', dept: 'Home Department', office: 'Gujarat Police HQ, Gandhinagar', start: 0, end: 9, emd: '1.4 Lakh', value: '70 Lakh', service: true },
];

const IST = 330 * 60_000;
const ref = new Date(FIXTURE_REFERENCE_DATE).getTime();
const solr = (dayOffset: number, hour: number) => {
  // IST wall clock with Z suffix, as GeM does.
  const istMidnight = Math.floor((ref + IST) / 86_400_000) * 86_400_000;
  const d = new Date(istMidnight + dayOffset * 86_400_000 + hour * 3_600_000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

function toDoc(r: Row) {
  const type = r.type ?? 1;
  const letter = type === 1 ? 'B' : 'R';
  const doc: Record<string, unknown> = {
    id: String(r.id),
    b_id: [r.id],
    b_bid_number: [`GEM/2026/${letter}/${r.id - 1000000}`],
    b_category_name: [r.short],
    bd_category_name: [r.long ?? r.short],
    b_total_quantity: [r.qty],
    ba_official_details_minName: [r.min],
    ba_official_details_deptName: [r.dept],
    final_start_date_sort: [solr(r.start, 10 + (r.id % 7))],
    final_end_date_sort: [solr(r.end, r.endHour ?? (r.id % 2 ? 15 : 18))],
    b_bid_type: [type],
    b_status: [1],
    b_buyer_status: [0],
    b_type: [r.service ? 1 : 0],
    is_high_value: [!!r.highValue],
    b_is_bunch: [r.bunch ? 1 : 0],
    b_eval_type: [0],
    b_ra_to_bid_details: type === 1 && r.id % 3 === 0 ? ['RA enabled: Yes'] : [],
  };
  if (r.org) doc.ba_official_details_orgName = [r.org];
  if (r.office) doc.ba_official_details_officeName = [r.office];
  if (r.emd !== undefined) doc.b_emd_amount = [r.emd];
  if (r.value !== undefined) doc.b_estimated_value = [r.value];
  if (r.hsn) doc.b_hsn_code = r.hsn;
  return doc;
}

const PAGE_SIZE = 10;
const docs = rows.map(toDoc);
const here = dirname(fileURLToPath(import.meta.url));
for (let p = 0; p * PAGE_SIZE < docs.length; p++) {
  const page = docs.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const body = {
    code: 200,
    status: 1,
    message: 'Data Found',
    response: {
      responseHeader: { status: 0, QTime: 3, params: { start: String(p * PAGE_SIZE), rows: String(PAGE_SIZE), sort: 'final_start_date_sort desc' } },
      response: { numFound: docs.length, start: p * PAGE_SIZE, numFoundExact: true, docs: page },
    },
  };
  writeFileSync(join(here, `page-${p + 1}.json`), `${JSON.stringify(body, null, 2)}\n`);
}
writeFileSync(join(here, 'extra-bids.json'), `${JSON.stringify(extraRows.map(toDoc), null, 2)}\n`);
writeFileSync(join(here, 'no-results.json'), `${JSON.stringify({ code: 404, status: 0, message: 'No data found', response: { response: { numFound: 0, start: 0, docs: [] } } }, null, 2)}\n`);
writeFileSync(join(here, 'meta.json'), `${JSON.stringify({ referenceDate: FIXTURE_REFERENCE_DATE, pageSize: PAGE_SIZE, total: docs.length, extra: extraRows.length }, null, 2)}\n`);
console.log(`wrote ${docs.length} docs in ${Math.ceil(docs.length / PAGE_SIZE)} pages + ${extraRows.length} extra`);
