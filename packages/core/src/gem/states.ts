/**
 * Indian states & union territories, plus a small city → state gazetteer used to derive a buyer's
 * state from GeM listing text (FR-001). GeM's listing has no explicit state field: for state
 * government buyers the "Ministry/State" field *is* the state name; for central buyers the state is
 * sometimes embedded in the department / office name.
 */

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  // Union territories
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
] as const;

export type IndianState = (typeof INDIAN_STATES)[number];

/** Alternate spellings → canonical name. Keys are lower-case. */
const ALIASES: Record<string, IndianState> = {
  'orissa': 'Odisha',
  'pondicherry': 'Puducherry',
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
  'uttaranchal': 'Uttarakhand',
  'j&k': 'Jammu and Kashmir',
  'jammu & kashmir': 'Jammu and Kashmir',
  'andaman & nicobar': 'Andaman and Nicobar Islands',
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'chattisgarh': 'Chhattisgarh',
  'tamilnadu': 'Tamil Nadu',
};

/** Major cities / well-known offices → state (lower-case keys). Deliberately small and unambiguous. */
const CITIES: Record<string, IndianState> = {
  mumbai: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra', nashik: 'Maharashtra', aurangabad: 'Maharashtra', thane: 'Maharashtra',
  bengaluru: 'Karnataka', bangalore: 'Karnataka', mysuru: 'Karnataka', mysore: 'Karnataka', hubballi: 'Karnataka',
  chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', madurai: 'Tamil Nadu', tiruchirappalli: 'Tamil Nadu',
  hyderabad: 'Telangana', secunderabad: 'Telangana', warangal: 'Telangana',
  visakhapatnam: 'Andhra Pradesh', vijayawada: 'Andhra Pradesh', tirupati: 'Andhra Pradesh', amaravati: 'Andhra Pradesh',
  kolkata: 'West Bengal', durgapur: 'West Bengal', siliguri: 'West Bengal', kharagpur: 'West Bengal',
  lucknow: 'Uttar Pradesh', kanpur: 'Uttar Pradesh', varanasi: 'Uttar Pradesh', prayagraj: 'Uttar Pradesh', noida: 'Uttar Pradesh', ghaziabad: 'Uttar Pradesh', agra: 'Uttar Pradesh', gorakhpur: 'Uttar Pradesh',
  jaipur: 'Rajasthan', jodhpur: 'Rajasthan', udaipur: 'Rajasthan', kota: 'Rajasthan', bikaner: 'Rajasthan',
  ahmedabad: 'Gujarat', gandhinagar: 'Gujarat', vadodara: 'Gujarat', surat: 'Gujarat', rajkot: 'Gujarat',
  bhopal: 'Madhya Pradesh', indore: 'Madhya Pradesh', jabalpur: 'Madhya Pradesh', gwalior: 'Madhya Pradesh',
  patna: 'Bihar', gaya: 'Bihar', muzaffarpur: 'Bihar',
  ranchi: 'Jharkhand', jamshedpur: 'Jharkhand', dhanbad: 'Jharkhand', bokaro: 'Jharkhand',
  bhubaneswar: 'Odisha', cuttack: 'Odisha', rourkela: 'Odisha',
  raipur: 'Chhattisgarh', bilaspur: 'Chhattisgarh', bhilai: 'Chhattisgarh',
  thiruvananthapuram: 'Kerala', kochi: 'Kerala', cochin: 'Kerala', kozhikode: 'Kerala',
  guwahati: 'Assam', dibrugarh: 'Assam', silchar: 'Assam',
  dehradun: 'Uttarakhand', haridwar: 'Uttarakhand', roorkee: 'Uttarakhand',
  shimla: 'Himachal Pradesh', gurugram: 'Haryana', gurgaon: 'Haryana', faridabad: 'Haryana', panchkula: 'Haryana', ambala: 'Haryana',
  ludhiana: 'Punjab', amritsar: 'Punjab', jalandhar: 'Punjab', mohali: 'Punjab', bathinda: 'Punjab',
  srinagar: 'Jammu and Kashmir', jammu: 'Jammu and Kashmir', leh: 'Ladakh',
  panaji: 'Goa', 'port blair': 'Andaman and Nicobar Islands', imphal: 'Manipur', shillong: 'Meghalaya',
  aizawl: 'Mizoram', kohima: 'Nagaland', agartala: 'Tripura', gangtok: 'Sikkim', itanagar: 'Arunachal Pradesh',
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STATE_PATTERNS: [RegExp, IndianState][] = [
  // Longer names first so "Andhra Pradesh" wins over "Pradesh"-like partials and
  // "Dadra and Nagar Haveli and Daman and Diu" over "Daman and Diu".
  ...[...INDIAN_STATES].sort((a, b) => b.length - a.length).map((s) => [new RegExp(`\\b${escapeRe(s)}\\b`, 'i'), s] as [RegExp, IndianState]),
  ...Object.entries(ALIASES).sort((a, b) => b[0].length - a[0].length).map(([k, v]) => [new RegExp(`(^|[^a-z])${escapeRe(k)}([^a-z]|$)`, 'i'), v] as [RegExp, IndianState]),
];
const CITY_PATTERNS: [RegExp, string, IndianState][] = Object.entries(CITIES).map(([k, v]) => [new RegExp(`\\b${escapeRe(k)}\\b`, 'i'), k, v]);

/** Canonical state name for an exact (case-insensitive) state / alias, else null. */
export function canonicalState(name: string | null | undefined): IndianState | null {
  if (!name) return null;
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = INDIAN_STATES.find((s) => s.toLowerCase() === n);
  return hit ?? ALIASES[n] ?? null;
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (m) => m.toUpperCase());

/**
 * Find a state (and city, when a known city was the clue) in free text, trying each text in order.
 * Returns nulls when nothing is recognisable — never guesses.
 */
export function deriveLocation(...texts: (string | null | undefined)[]): { state: IndianState | null; city: string | null } {
  for (const t of texts) {
    if (!t) continue;
    for (const [re, s] of STATE_PATTERNS) if (re.test(t)) {
      const city = CITY_PATTERNS.find(([cre, , cs]) => cs === s && cre.test(t));
      return { state: s, city: city ? titleCase(city[1]) : null };
    }
  }
  for (const t of texts) {
    if (!t) continue;
    for (const [re, city, s] of CITY_PATTERNS) if (re.test(t)) return { state: s, city: titleCase(city) };
  }
  return { state: null, city: null };
}
