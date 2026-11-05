// parseAwardResult (006/FR-085, T092) — clean-room implementation from specs/006-apply-packet-assist/award-parser-spec.md.
//
// Hand-written single-pass tokenizer: every index is consumed once (indexOf / charCodeAt scanning), no regex on the whole
// input, no DOM, no network. Row / cell / text sizes are bounded so hostile markup cannot blow up time or memory.
import { MAX_RESULT_HTML, MAX_ROW_LENGTH } from './award';
import type { AwardBidder, AwardResult } from './award';

const MAX_CELLS_PER_ROW = 64;
const MAX_CELL_RAW = 4096;
const MAX_TABLE_DEPTH = 32;
const MAX_BIDDERS = 5000;
const MAX_CLASS_LEN = 512;
const MAX_AMOUNT = 1e13;

const FINANCIAL_WORDS = ['rank', 'price', 'l1', 'financial', 'amount', 'total'];
const NAME_WORDS = ['seller', 'vendor', 'bidder', 'company', 'name'];
const PRICE_WORDS = ['price', 'amount', 'total'];

// ───────────── text helpers ─────────────

const isWs = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'", apos: "'" };

function decodeEntities(s: string): string {
  let amp = s.indexOf('&');
  if (amp < 0) return s;
  let out = '';
  let last = 0;
  while (amp >= 0) {
    const semi = s.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp > 10) {
      amp = s.indexOf('&', amp + 1);
      continue;
    }
    const body = s.slice(amp + 1, semi);
    let rep: string | undefined;
    if (body.charCodeAt(0) === 35 && body.length > 1) {
      const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
      const digits = hex ? body.slice(2) : body.slice(1);
      let ok = digits.length > 0;
      for (let k = 0; ok && k < digits.length; k++) {
        const c = digits.charCodeAt(k);
        ok = isDigit(c) || (hex && ((c >= 65 && c <= 70) || (c >= 97 && c <= 102)));
      }
      if (ok) {
        const cp = parseInt(digits, hex ? 16 : 10);
        if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) rep = String.fromCodePoint(cp);
      }
    } else {
      rep = NAMED[body];
    }
    if (rep === undefined) {
      amp = s.indexOf('&', amp + 1);
      continue;
    }
    out += s.slice(last, amp) + rep;
    last = semi + 1;
    amp = s.indexOf('&', last);
  }
  return out + s.slice(last);
}

function collapse(s: string): string {
  let out = '';
  let pendingSpace = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (isWs(s.charCodeAt(i))) {
      if (i > start) {
        if (pendingSpace && out) out += ' ';
        out += s.slice(start, i);
        pendingSpace = false;
      }
      pendingSpace = true;
      start = i + 1;
    }
  }
  if (s.length > start) {
    if (pendingSpace && out) out += ' ';
    out += s.slice(start);
  }
  return out;
}

const cleanText = (raw: string): string => collapse(decodeEntities(raw));

// ───────────── number parsing ─────────────

function startsWithWord(s: string, at: number, word: string): boolean {
  if (at + word.length > s.length) return false;
  for (let i = 0; i < word.length; i++) {
    if ((s.charCodeAt(at + i) | 32) !== word.charCodeAt(i)) return false;
  }
  return true;
}

function endsWithWord(s: string, word: string): boolean {
  return s.length >= word.length && startsWithWord(s, s.length - word.length, word);
}

/** Positive rupee amount in (0, 1e13], or NaN when the text is not exactly one amount with optional currency affixes. */
function parseAmount(text: string): number {
  if (text.length === 0 || text.length > 64) return NaN;
  let a = 0;
  let b = text.length;
  // prefix mark
  if (text.charCodeAt(0) === 0x20b9) a = 1;
  else if (startsWithWord(text, 0, 'inr')) a = 3;
  else if (startsWithWord(text, 0, 'rs.')) a = 3;
  else if (startsWithWord(text, 0, 'rs')) a = 2;
  while (a < b && isWs(text.charCodeAt(a))) a++;
  // suffix mark (only when no prefix mark was used)
  if (a === 0) {
    const t = text;
    let m = 0;
    if (t.charCodeAt(b - 1) === 0x20b9) m = 1;
    else if (endsWithWord(t, 'inr')) m = 3;
    else if (endsWithWord(t, 'rs.')) m = 3;
    else if (endsWithWord(t, 'rs')) m = 2;
    if (m) {
      b -= m;
      while (b > a && isWs(t.charCodeAt(b - 1))) b--;
    }
  }
  if (b <= a) return NaN;
  const first = text.charCodeAt(a);
  const last = text.charCodeAt(b - 1);
  if (!isDigit(first) || !isDigit(last)) return NaN;
  let dots = 0;
  let digitsSeen = 0;
  let prevComma = false;
  let num = '';
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    if (isDigit(c)) {
      num += text[i];
      digitsSeen++;
      prevComma = false;
    } else if (c === 44) {
      if (dots > 0 || prevComma) return NaN;
      prevComma = true;
    } else if (c === 46) {
      if (++dots > 1) return NaN;
      num += '.';
      prevComma = false;
    } else return NaN;
  }
  if (digitsSeen === 0) return NaN;
  const v = Number(num);
  return Number.isFinite(v) && v > 0 && v <= MAX_AMOUNT ? v : NaN;
}

/** "N" or "L<N>" (case-insensitive), N a positive integer → N; otherwise 0. */
function parseRank(text: string): number {
  let i = 0;
  if (text.length > 0 && (text.charCodeAt(0) | 32) === 108) i = 1;
  if (text.length - i < 1 || text.length - i > 9) return 0;
  for (let k = i; k < text.length; k++) if (!isDigit(text.charCodeAt(k))) return 0;
  return parseInt(text.slice(i), 10);
}

function hasLetter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isAlpha(c) || (c > 127 && c !== 0x20b9 && !isWs(c))) return true;
  }
  return false;
}

function cleanName(name: string): string {
  if (name.charCodeAt(name.length - 1) !== 41) return name;
  const open = name.lastIndexOf('(');
  if (open < 0 || name.length - open > 14) return name;
  const inner = name.slice(open + 1, name.length - 1);
  return inner.indexOf(')') < 0 ? collapse(name.slice(0, open)) : name;
}

// ───────────── header / row interpretation ─────────────

interface Header {
  price: boolean;
  rankIdx: number;
  nameIdx: number;
  priceIdx: number;
}

const containsAny = (s: string, words: string[]): boolean => {
  for (const w of words) if (s.indexOf(w) >= 0) return true;
  return false;
};

function readHeader(cells: string[]): Header | null {
  const lower = cells.map((c) => c.toLowerCase());
  if (!containsAny(lower.join(' '), FINANCIAL_WORDS)) return null;
  const h: Header = { price: true, rankIdx: -1, nameIdx: -1, priceIdx: -1 };
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    if (h.rankIdx < 0 && c.indexOf('rank') >= 0) h.rankIdx = i;
    else if (h.nameIdx < 0 && containsAny(c, NAME_WORDS)) h.nameIdx = i;
    else if (h.priceIdx < 0 && containsAny(c, PRICE_WORDS)) h.priceIdx = i;
    else if (h.rankIdx < 0 && c.length >= 2 && c.charCodeAt(0) === 108 && isDigit(c.charCodeAt(1)) && !containsAny(c, PRICE_WORDS)) h.rankIdx = i;
  }
  return h;
}

interface Accepted extends AwardBidder {
  marked: boolean;
}

function interpretRow(h: Header, cells: string[], marked: boolean): Accepted | null {
  const noRoles = h.rankIdx < 0 && h.nameIdx < 0 && h.priceIdx < 0;
  const needed = Math.max(h.nameIdx, h.priceIdx);
  const useHeader = !noRoles && !(h.nameIdx >= 0 && h.priceIdx >= 0 && needed >= cells.length);
  let rank = 0;
  let name = '';
  let price = NaN;
  if (useHeader) {
    if (h.rankIdx >= 0 && h.rankIdx < cells.length) rank = parseRank(cells[h.rankIdx]!);
    if (h.nameIdx < 0) return null; // the name must be labelled when the header labels other columns
    if (h.nameIdx >= cells.length) return null;
    name = cells[h.nameIdx]!;
    if (h.priceIdx >= 0) {
      if (h.priceIdx >= cells.length) return null;
      price = parseAmount(cells[h.priceIdx]!);
    } else {
      for (let i = cells.length - 1; i >= 0; i--) {
        if (i === h.rankIdx || i === h.nameIdx) continue;
        const v = parseAmount(cells[i]!);
        if (v === v) {
          price = v;
          break;
        }
      }
    }
  } else {
    let rankCell = -1;
    if (cells.length > 1 && parseRank(cells[0]!) > 0) {
      rankCell = 0;
      rank = parseRank(cells[0]!);
    }
    let priceCell = -1;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (i === rankCell) continue;
      const v = parseAmount(cells[i]!);
      if (v === v) {
        price = v;
        priceCell = i;
        break;
      }
    }
    for (let i = 0; i < cells.length; i++) {
      if (i === rankCell || i === priceCell) continue;
      if (hasLetter(cells[i]!)) {
        name = cells[i]!;
        break;
      }
    }
  }
  name = cleanName(name);
  if (!name || !(price > 0 && price <= MAX_AMOUNT)) return null;
  return { rank, name, price, marked };
}

// ───────────── tokenizer ─────────────

interface Cell {
  raw: string;
  winner: boolean;
}
interface Row {
  cells: string[];
  winner: boolean;
  start: number;
}
interface TableCtx {
  header: Header | null;
  headerSeen: boolean;
  skip: boolean;
  row: Row | null;
  cell: Cell | null;
  out: Accepted[];
}

function markedClass(cls: string | null): boolean {
  if (!cls) return false;
  let i = 0;
  const n = cls.length;
  while (i < n) {
    while (i < n && isWs(cls.charCodeAt(i))) i++;
    const s = i;
    while (i < n && !isWs(cls.charCodeAt(i))) i++;
    if (i > s) {
      const tok = cls.slice(s, i).toLowerCase();
      if (tok === 'winner' || tok.indexOf('trophy') >= 0) return true;
    }
  }
  return false;
}

function closeCell(t: TableCtx): void {
  const c = t.cell;
  if (!c) return;
  t.cell = null;
  const r = t.row;
  if (!r) return;
  if (c.winner) r.winner = true;
  if (r.cells.length < MAX_CELLS_PER_ROW) r.cells.push(cleanText(c.raw));
}

function closeRow(t: TableCtx, pos: number): void {
  closeCell(t);
  const r = t.row;
  if (!r) return;
  t.row = null;
  if (r.cells.length === 0) return;
  if (!t.headerSeen) {
    t.headerSeen = true;
    t.header = readHeader(r.cells);
    if (!t.header) t.skip = true;
    return;
  }
  if (!t.header || pos - r.start > MAX_ROW_LENGTH || t.out.length >= MAX_BIDDERS) return;
  const a = interpretRow(t.header, r.cells, r.winner);
  if (a) t.out.push(a);
}

function startRow(t: TableCtx, pos: number, cls: string | null): void {
  closeRow(t, pos);
  if (t.skip) return;
  t.row = { cells: [], winner: markedClass(cls), start: pos };
}

function startCell(t: TableCtx, pos: number, cls: string | null): void {
  closeCell(t);
  if (t.skip) return;
  if (!t.row) t.row = { cells: [], winner: false, start: pos };
  t.cell = { raw: '', winner: markedClass(cls) };
}

function finishTable(t: TableCtx, pos: number, into: Accepted[]): void {
  closeRow(t, pos);
  for (const a of t.out) {
    if (into.length >= MAX_BIDDERS) break;
    into.push(a);
  }
}

function skipRawText(s: string, from: number, name: string): number {
  let i = s.indexOf('</', from);
  while (i >= 0) {
    if (startsWithWord(s, i + 2, name)) {
      const e = s.indexOf('>', i + 2);
      return e < 0 ? s.length : e + 1;
    }
    i = s.indexOf('</', i + 2);
  }
  return s.length;
}

function tokenize(s: string): Accepted[] {
  const all: Accepted[] = [];
  const stack: TableCtx[] = [];
  let ignoredDepth = 0;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    const top = stack.length ? stack[stack.length - 1]! : null;
    const textEnd = lt < 0 ? n : lt;
    if (top && top.cell && textEnd > i && top.cell.raw.length < MAX_CELL_RAW) {
      top.cell.raw += s.slice(i, Math.min(textEnd, i + MAX_CELL_RAW));
    }
    if (lt < 0) break;
    i = lt;
    const c1 = i + 1 < n ? s.charCodeAt(i + 1) : 0;
    if (c1 === 33) {
      // <!-- comment --> or <!doctype …>
      if (s.startsWith('<!--', i)) {
        const e = s.indexOf('-->', i + 4);
        i = e < 0 ? n : e + 3;
      } else {
        const e = s.indexOf('>', i + 2);
        i = e < 0 ? n : e + 1;
      }
      continue;
    }
    if (c1 === 63) {
      const e = s.indexOf('>', i + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const closing = c1 === 47;
    let p = i + (closing ? 2 : 1);
    if (p >= n || !isAlpha(s.charCodeAt(p))) {
      // a bare '<' is text
      if (top && top.cell && top.cell.raw.length < MAX_CELL_RAW) top.cell.raw += '<';
      i += 1;
      continue;
    }
    const ns = p;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (!(isAlpha(c) || isDigit(c) || c === 45 || c === 58)) break;
      p++;
    }
    const name = p - ns <= 8 ? s.slice(ns, p).toLowerCase() : '';
    // attributes: only `class` matters
    let cls: string | null = null;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 62) {
        p++;
        break;
      }
      if (isWs(c) || c === 47) {
        p++;
        continue;
      }
      const as = p;
      while (p < n) {
        const d = s.charCodeAt(p);
        if (isWs(d) || d === 61 || d === 62 || d === 47) break;
        p++;
      }
      const attr = p - as === 5 ? s.slice(as, p).toLowerCase() : '';
      while (p < n && isWs(s.charCodeAt(p))) p++;
      if (p < n && s.charCodeAt(p) === 61) {
        p++;
        while (p < n && isWs(s.charCodeAt(p))) p++;
        const q = p < n ? s.charCodeAt(p) : 0;
        let vs: number;
        let ve: number;
        if (q === 34 || q === 39) {
          vs = p + 1;
          const e = s.indexOf(q === 34 ? '"' : "'", vs);
          ve = e < 0 ? n : e;
          p = e < 0 ? n : e + 1;
        } else {
          vs = p;
          while (p < n) {
            const d = s.charCodeAt(p);
            if (isWs(d) || d === 62) break;
            p++;
          }
          ve = p;
        }
        if (attr === 'class' && cls === null) cls = s.slice(vs, Math.min(ve, vs + MAX_CLASS_LEN));
      } else if (p === as) {
        p++; // defensive: always advance
      }
    }
    const tagStart = i;
    i = p;

    if (!closing && (name === 'script' || name === 'style')) {
      i = skipRawText(s, i, name);
      continue;
    }

    if (name === 'table') {
      if (closing) {
        if (ignoredDepth > 0) ignoredDepth--;
        else if (stack.length) finishTable(stack.pop()!, tagStart, all);
      } else if (stack.length >= MAX_TABLE_DEPTH) ignoredDepth++;
      else stack.push({ header: null, headerSeen: false, skip: false, row: null, cell: null, out: [] });
      continue;
    }
    if (ignoredDepth > 0) continue; // inside a table nested beyond the depth cap
    const t = top;
    if (!t) continue;
    if (name === 'tr') {
      if (closing) closeRow(t, tagStart);
      else startRow(t, tagStart, cls);
    } else if (name === 'td' || name === 'th') {
      if (closing) closeCell(t);
      else startCell(t, tagStart, cls);
    } else if (!closing && t.cell && markedClass(cls)) {
      t.cell.winner = true;
    }
  }
  while (stack.length) finishTable(stack.pop()!, n, all);
  return all;
}

export function parseAwardResult(input: string): AwardResult | null {
  try {
    if (typeof input !== 'string' || input.length === 0) return null;
    const s = input.length > MAX_RESULT_HTML ? input.slice(0, MAX_RESULT_HTML) : input;
    const accepted = tokenize(s);
    if (accepted.length === 0) return null;
    const winner = accepted.find((a) => a.marked) ?? accepted.find((a) => a.rank === 1) ?? accepted[0]!;
    return {
      l1Price: winner.price,
      l1Seller: winner.name,
      bidders: accepted.map((a) => ({ rank: a.rank, name: a.name, price: a.price })),
    };
  } catch {
    return null;
  }
}
