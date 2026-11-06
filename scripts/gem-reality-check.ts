/**
 * GeM reality check (issue #554): runs TenderPilot's REAL scraper, parser and bid-document rules against the REAL
 * public GeM BidPlus site, from a machine GeM accepts connections from (e.g. your laptop in India), and writes a
 * report plus real sample data to commit as fixtures.
 *
 *   pnpm install
 *   pnpm exec tsx scripts/gem-reality-check.ts                 # defaults: 3 listing pages, 5 bid documents
 *   pnpm exec tsx scripts/gem-reality-check.ts --pages 2 --docs 3
 *   pnpm exec tsx scripts/gem-reality-check.ts --base http://127.0.0.1:4011   # dry run against tools/mock-gem
 *   pnpm exec tsx scripts/gem-reality-check.ts --ua "Mozilla/5.0 ..."          # only if the honest UA is refused
 *
 * Politeness (constitution II): public pages only, no login, ≤ 1 request per 1.5 s, ~12 requests in total,
 * honest User-Agent by default. It stores only what GeM publishes publicly.
 *
 * Output (default `fixtures/real-gem/<timestamp>/`): report.md (read this first), listing-page-N.json (raw bids),
 * docs/*.pdf (real bid documents), documents.json. Nothing is uploaded anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GemClient, GemError, DEFAULT_USER_AGENT } from '../packages/core/src/gem/client';
import { parseBidPlusDoc, parentBidRef, type NormalizedTender } from '../packages/core/src/gem/parse';
import { extractPdf, joinPages } from '../packages/core/src/analyse/pdf-text';
import { extractRequirementsRules, flattenText } from '../packages/core/src/analyse/rules';

// ───────────── args ─────────────
const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PAGES = Math.max(1, Math.min(5, Number(arg('pages', '3'))));
const DOCS = Math.max(0, Math.min(8, Number(arg('docs', '5'))));
const BASE = arg('base', 'https://bidplus.gem.gov.in');
const UA = arg('ua', DEFAULT_USER_AGENT);
const SEARCH = arg('search', '');   // e.g. --search "GEM/2026/B/" to see direct bids, not just reverse auctions
const SORT = arg('sort', '');       // Bid-End-Date-Latest | Bid-End-Date-Oldest | Bid-Start-Date-Latest
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = arg('out', join('fixtures', 'real-gem', stamp));

mkdirSync(join(OUT, 'docs'), { recursive: true });
const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const save = (name: string, data: string | Uint8Array) => writeFileSync(join(OUT, name), data);

const gem = new GemClient(fetch, { baseUrl: BASE, userAgent: UA, minIntervalMs: 1500, maxRetries: 1, timeoutMs: 60_000 });

/** What each normalised tender field would be in a healthy parse; used for the null-rate table. */
const CHECK_FIELDS: (keyof NormalizedTender)[] = [
  'bidNumber', 'gemBidId', 'title', 'category', 'quantity', 'ministry', 'department', 'organisation', 'buyerOffice',
  'state', 'city', 'startAt', 'endAt', 'emdAmount', 'estimatedValue', 'epbgPercent', 'documentUrl',
];

/** Phrases a GeM bid document is expected to contain, and the requirement key our rules should have produced. */
const EXPECT: { label: string; re: RegExp; key: string }[] = [
  { label: 'Minimum average annual turnover', re: /average\s+annual\s+turnover|turnover\s+of\s+the\s+bidder/i, key: 'turnover_min' },
  { label: 'Years of past experience', re: /years?\s+of\s+past\s+experience|past\s+experience\s+required/i, key: 'experience_years' },
  { label: 'EMD amount', re: /\bEMD\b|earnest\s+money/i, key: 'emd' },
  { label: 'ePBG percentage', re: /\bePBG\b|performance\s+bank\s+guarantee/i, key: 'epbg' },
  { label: 'MSE exemption', re: /MSE\s+exemption|exemption\s+for\s+years\s+of\s+experience/i, key: 'mse_exemption' },
  { label: 'Startup exemption', re: /start\s*-?up\s+exemption/i, key: 'startup_exemption' },
  { label: 'Make in India / MII', re: /make\s+in\s+india|\bMII\b/i, key: 'mii' },
  { label: 'Documents required from seller', re: /document\s+required\s+from\s+seller/i, key: 'document' },
  { label: 'Bid end date', re: /bid\s+end\s+date/i, key: 'bid_end' },
  { label: 'Evaluation method', re: /evaluation\s+method/i, key: 'evaluation_method' },
  { label: 'Estimated bid value', re: /estimated\s+bid\s+value[^a-z]{0,20}\d/i, key: 'estimated_value' },
  { label: 'OEM authorisation', re: /\b(OEM|manufacturer)\s+(authori[sz]ation|certificate)\b/i, key: 'oem_auth' },
];

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

async function main() {
  say(`# GeM reality check — ${new Date().toISOString()}`);
  say();
  say(`- Target: \`${BASE}\`  ·  User-Agent: \`${UA}\``);
  say(`- Plan: ${PAGES} listing page(s), ${DOCS} bid document(s), ≤ 1 request / 1.5 s`);
  say(`- Node ${process.version} on ${process.platform}`);
  say();

  // ───────────── 1. listing ─────────────
  say('## 1. Listing (POST /all-bids-data)');
  const tenders: NormalizedTender[] = [];
  const rawDocs: Record<string, unknown>[] = [];
  let numFound = 0;
  let reachable = true;
  for (let page = 1; page <= PAGES; page++) {
    try {
      const res = await gem.fetchPage({ page, search: SEARCH || undefined, sort: (SORT || undefined) as never });
      numFound = res.numFound;
      save(`listing-page-${page}.json`, JSON.stringify(res, null, 2));
      for (const d of res.docs) {
        rawDocs.push(d);
        const t = parseBidPlusDoc(d, { baseUrl: BASE, now: new Date() });
        if (t) tenders.push(t);
      }
      say(`- page ${page}: ${res.docs.length} raw docs, ${numFound.toLocaleString('en-IN')} open bids reported by GeM`);
    } catch (e) {
      reachable = false;
      const err = e as GemError & { status?: number; code?: string };
      say(`- page ${page}: ❌ ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}${err.code ? ` [${err.code}]` : ''}`);
      if (/response format changed/i.test(err.message)) say('  → GeM changed the response shape; see listing-page-*.json if saved, and send me this report.');
      break;
    }
  }

  if (!reachable && !tenders.length) {
    say();
    say('**Stopped: could not read the listing.** If this is a connection reset / timeout from your laptop too, GeM is blocking this network or the User-Agent; try `--ua` with a browser string, or a different network, and send me this report.');
    finish();
    return;
  }

  // raw key inventory
  say();
  say('### Raw fields GeM returned (frequency across all docs)');
  const keyCount = new Map<string, number>();
  for (const d of rawDocs) for (const k of Object.keys(d)) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  const keys = [...keyCount.entries()].sort((a, b) => b[1] - a[1]);
  say('| field | in % of docs | sample value |');
  say('|---|---|---|');
  for (const [k, n] of keys) {
    const sample = rawDocs.map((d) => d[k]).find((v) => v !== undefined && v !== null && v !== '');
    const text = JSON.stringify(sample)?.slice(0, 70).replace(/\|/g, '\\|') ?? '';
    say(`| \`${k}\` | ${pct(n, rawDocs.length)} | ${text} |`);
  }

  // parse quality
  say();
  say(`### What our parser could read (${tenders.length} of ${rawDocs.length} docs parsed)`);
  say('| normalised field | filled | note |');
  say('|---|---|---|');
  for (const f of CHECK_FIELDS) {
    const filled = tenders.filter((t) => t[f] !== null && t[f] !== undefined && t[f] !== '').length;
    const note = filled === 0 ? '⚠ never filled — field name or format differs from our assumption' : filled < tenders.length * 0.5 ? 'sparse' : '';
    say(`| ${f} | ${filled}/${tenders.length} (${pct(filled, tenders.length)}) | ${note} |`);
  }
  const unparsed = rawDocs.length - tenders.length;
  if (unparsed) say(`\n⚠ ${unparsed} doc(s) were dropped by the parser (no usable bid number?).`);

  // dates — the "Z means IST wall clock" assumption flagged by team 003
  say();
  say('### Dates (our assumption: GeM "…Z" timestamps are IST wall-clock times)');
  say(`Now: ${new Date().toISOString()} UTC = ${new Date(Date.now() + 330 * 60_000).toISOString().replace('Z', '')} IST`);
  say('| bid | raw start | raw end | parsed endAt (UTC) | endAt in IST | status |');
  say('|---|---|---|---|---|---|');
  for (const d of rawDocs.slice(0, 6)) {
    const t = parseBidPlusDoc(d, { baseUrl: BASE, now: new Date() });
    const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
    const ist = t?.endAt ? new Date(t.endAt.getTime() + 330 * 60_000).toISOString().replace('Z', '') : '—';
    say(`| ${t?.bidNumber ?? '?'} | ${String(first(d.final_start_date_sort ?? d.b_start_date) ?? '—')} | ${String(first(d.final_end_date_sort ?? d.b_end_date) ?? '—')} | ${t?.endAt?.toISOString() ?? '—'} | ${ist} | ${t?.status ?? '—'} |`);
  }
  say('Check one row against the same bid on the website: the end date/time shown there should equal the "endAt in IST" column.');

  // ───────────── 2. documents ─────────────
  say();
  say('## 2. Bid documents (route chosen per bid type: /showbidDocument, /showradocumentPdf, …) and our eligibility rules');
  const candidates = tenders.filter((t) => t.gemBidId || t.documentUrl).slice(0, DOCS);
  const docSummaries: unknown[] = [];
  const allMissed: string[] = [];
  for (const t of candidates) {
    const parent = t.bidType === 'ra' ? parentBidRef(t.raw, BASE) : null;
    const id = parent?.documentUrl ?? t.documentUrl ?? t.gemBidId!;
    say();
    say(`### ${t.bidNumber} — ${t.title.slice(0, 80)}`);
    if (parent) say(`- reverse auction → following parent bid ${parent.bidNumber ?? parent.gemBidId} (${id})`);
    try {
      const doc = await gem.fetchBidDocument(id);
      const file = `docs/${sanitize(t.bidNumber)}.pdf`;
      save(file, doc.bytes);
      const pdf = await extractPdf(doc.bytes, { maxPages: 60 });
      const text = flattenText(joinPages(pdf.pages));
      const perPage = pdf.totalPages ? text.length / pdf.totalPages : 0;
      say(`- saved \`${file}\` (${(doc.bytes.length / 1024).toFixed(0)} KB, ${pdf.totalPages} pages, ${text.length.toLocaleString('en-IN')} chars of text${perPage < 80 ? ' ⚠ looks scanned / image-only' : ''})`);
      const reqs = extractRequirementsRules(pdf.pages, { fileName: file.split('/').pop(), estimatedValue: t.estimatedValue });
      const byKey = new Map<string, number>();
      for (const r of reqs) byKey.set(r.key, (byKey.get(r.key) ?? 0) + 1);
      say(`- our rules produced ${reqs.length} requirement(s): ${[...byKey.entries()].map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}`);
      const missed: string[] = [];
      for (const e of EXPECT) {
        const m = e.re.exec(text);
        if (!m) continue;
        if (!byKey.has(e.key)) {
          const at = m.index;
          const ctx = text.slice(Math.max(0, at - 60), at + 220).replace(/\s+/g, ' ');
          missed.push(`  - ❌ **${e.label}** is in the document but rule \`${e.key}\` found nothing. Context: “…${ctx}…”`);
        }
      }
      if (missed.length) { say('- Possible misses (label present in the PDF, requirement not extracted):'); for (const m of missed) say(m); allMissed.push(...missed.map((m) => `${t.bidNumber}: ${m.trim()}`)); }
      else say('- ✅ every expected label that appears was extracted');
      docSummaries.push({ bidNumber: t.bidNumber, file, pages: pdf.totalPages, chars: text.length, requirementKeys: [...byKey.keys()], missed: missed.length });
    } catch (e) {
      say(`- ❌ ${(e as Error).message}  (tried ${id})`);
      // Probe: show exactly what GeM sent back, so we can see HTML / captcha / redirect instead of guessing.
      let probe: Record<string, unknown> = {};
      try {
        const r = await fetch(id, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'application/pdf,*/*;q=0.8', referer: `${BASE}/all-bids` } });
        const body = new Uint8Array(await r.arrayBuffer());
        probe = { status: r.status, contentType: r.headers.get('content-type'), location: r.headers.get('location'), bytes: body.length, head: new TextDecoder().decode(body.slice(0, 400)).replace(/\s+/g, ' ') };
        save(`docs/${sanitize(t.bidNumber)}.probe.bin`, body.slice(0, 20000));
      } catch (pe) { probe = { probeError: (pe as Error).message }; }
      say(`- probe: ${JSON.stringify(probe)}`);
      docSummaries.push({ bidNumber: t.bidNumber, tried: id, error: (e as Error).message, probe });
    }
  }
  save('documents.json', JSON.stringify(docSummaries, null, 2));

  // ───────────── 3. results / awards ─────────────
  say();
  say('## 3. Awarded bids (competitor intelligence, spec 003/US6)');
  try {
    const res = await gem.fetchSubmittedPage({ page: 1, byStatus: 'bid_awarded' });
    save('awarded-page-1.json', JSON.stringify(res, null, 2));
    const keysAw = new Set<string>();
    for (const d of res.docs) for (const k of Object.keys(d)) keysAw.add(k);
    say(`- ${res.docs.length} awarded docs; fields: ${[...keysAw].slice(0, 40).join(', ')}`);
  } catch (e) {
    say(`- ❌ ${(e as Error).message}`);
  }

  // ───────────── verdict ─────────────
  say();
  say('## Summary');
  say(`- Listing reachable: **${tenders.length ? 'yes' : 'no'}** · tenders parsed: **${tenders.length}/${rawDocs.length}**`);
  say(`- Bid documents fetched: **${docSummaries.filter((d: any) => !d.error).length}/${candidates.length}** · possible extraction misses: **${allMissed.length}**`);
  say();
  say('Next: commit `' + OUT + '` to a branch and tell me; I will fix the parser/rules against this real data and replace the synthetic fixtures.');
  finish();
}

function finish() {
  save('report.md', lines.join('\n'));
  console.log(`\nWrote ${join(OUT, 'report.md')}`);
}

main().catch((e) => {
  say(`\n💥 Unexpected error: ${(e as Error).stack ?? e}`);
  finish();
  process.exitCode = 1;
});
