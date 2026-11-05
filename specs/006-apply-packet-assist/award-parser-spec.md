# Behaviour spec: `parseAwardResult` (006 / FR-085, T092)

Specification for an independent reimplementation (clean-room in process, not in provenance: see NOTICE). Derived only from: spec.md (US7 scenario 9, FR-085), plan.md, tasks.md T092/T093, the
`parseAwardResult` tests in `packages/core/test/gem/award.test.ts`, the fixture `packages/core/test/fixtures/gem/ra-result.html`,
the observable use in `SubmitStep.tsx` and the US7 E2E (scenarios S9/S9b), and the exported type names. An implementer needs
nothing else.

## 1. Purpose

Given the HTML of a public GeM RA / bid-result page that the user saved themselves, suggest the L1 price and L1 seller so the
"Record result" dialog can pre-fill them for the human to confirm. Pure function in `@tp/core`, implemented in `packages/core/src/gem/award-result.ts` and re-exported from `packages/core/src/gem/award.ts`,
run in the browser. No DOM (`DOMParser`, `document`), no network, no I/O, no global state.

## 2. Public contract

```ts
export interface AwardBidder { rank: number; name: string; price: number }          // rank 0 = table has no rank column; price > 0 rupees
export interface AwardResult { l1Price: number; l1Seller: string; bidders: AwardBidder[] }
export function parseAwardResult(input: string): AwardResult | null
export const MAX_RESULT_HTML = 512 * 1024   // already exported by the module; the UI also slices files to this size
```

- `bidders` lists accepted rows in document order (by position of the row's `<tr>`; rows of a nested table sit between the outer rows before and after it), not sorted by rank.
- `l1Price` / `l1Seller` are the price / name of the selected winner row (section 6); the winner is one of `bidders`.
- No `winner` flag is exposed; `bidders` entries contain exactly `{ rank, name, price }` (tests use `toEqual`).
- Returns `null` when there is no usable price table, i.e. no accepted bidder row (UI shows "No price table found in this page.").
- Never throws, for any string input; any non-string input returns `null`.

## 3. Input limits

- Input longer than `MAX_RESULT_HTML` (512 KB) is truncated to that length before parsing (real pages are far smaller).
- A row longer than 16 KB (`MAX_ROW_LENGTH`) is not a bidder row and is skipped without being parsed (a real row is < 2 KB).
- Row and cell counts are bounded by the input size cap; implementations may add explicit caps (rows, cells per row) as long as
  B1-B10 still hold.

## 4. Hostile-input requirements (NFR)

- Single left-to-right scan, O(n) time and memory in input length. No regex with nested/overlapping quantifiers or
  backtracking-prone alternation; prefer a hand-written tokenizer (index scanning, `indexOf`) over regex on the whole input.
- A 512 KB input of any of the shapes in B7/B10 must finish well under 200 ms (test limit 200 ms per input; target < 50 ms);
  all hostile inputs in B10 together < 2 s.
- Unclosed tags/cells, unterminated `<td`, `<tr>` without `</tr>`, huge header rows, and tens of thousands of cells must neither
  hang nor throw; they yield `null` (B10) or whatever valid rows exist.
- Output is plain text only: every returned `name` is entity-decoded text with all markup removed, whitespace collapsed and
  trimmed; it is safe to render as text (no tags survive). Callers must never inject it as HTML.

## 5. Table discovery and column identification

Tokenize the document into `<table>` elements, their rows (`<tr>`, with optional `<thead>/<tbody>`) and cells (`<th>`/`<td>`;
a cell ends at its closing tag or at the next cell/row start). Tag and attribute names are case-insensitive. Comments, scripts and
styles carry no cells. Cell text = inner markup stripped (block-level tags `br p div li ul ol hr h1-h6 table tr td th` count as a single space between words, so
`Acme<br>Traders` gives `Acme Traders`; inline tags such as `span b i strong a` add nothing, so `<span>28,40,500</span><span>.00</span>` is one number), entities decoded (named: `&amp; &lt; &gt; &quot; &nbsp; &#39;`;
numeric decimal/hex only for valid non-surrogate code points, otherwise left raw), whitespace collapsed, trimmed.

Classification of each table by its **first row** (header row), case-insensitive substring match on the joined header text:

- Price/financial table: first row contains any of `rank`, `price`, `l1`, `financial`, `amount`, `total` (plan.md).
- Any other table is ignored: technical-evaluation tables (headers like seller / vendor / bidder / technical / qualified with
  none of the words above), RA-details key/value tables, tables like `Name | City`. Ignored tables contribute no bidders (B2, B8).
- All price tables in the document contribute rows (typical page has one).

Column mapping inside a price table, from the first row's header words (not by position, B5):

- rank column: header contains `rank` (or `l1`-style rank wording).
- name column: header contains `seller`, `vendor`, `bidder`, `company`, `name`, `firm`, `participant`, `supplier` or `agency`. `S.No`/serial columns are neither rank nor name.
- price column: header contains `price`, `amount` or `total` (e.g. `Total Price (₹)`). A header cell with both a name word and a
  price word (`Seller Quoted Price`) is the price column.
- A name taken from a labelled name column must contain at least one letter (`12345`, `—` are not names: the row is skipped).
- When the header labels rank and/or price but no name word, the name is read from cell contents (first cell containing letters
  that is not the rank or price cell), provided the header has at least one unlabelled column to hold it (a lone `Price` header
  does not: B10 stays `null`).
- Fallback when a role has no header word (B3c; B4 is a header-path case, not a fallback): the first row has no usable role headers or the table is only partially
  labelled (e.g. `Rank | Firm | Price` is fully labelled, `Rank | Price | Bid` has no name word), then use content: the price is the right-most cell that parses as a positive amount in a column that is not the rank
  column; the name is the first cell with letters that is not the rank/price cell; rank is a cell that is purely a rank token
  (`1`, `L1`, `l2`).
- A rank value is `N` or `L<N>` (case-insensitive) with N a positive integer, giving N; anything else, or no rank column, gives `0`.
- Rank is never reused as the price: a cell identified as the rank cell is excluded from price candidates (B4).

The first row of a price table is the header and is never a data row (also when its cells are `<td>` rather than `<th>`).

## 6. Row acceptance, name cleaning, winner selection

A data row is accepted iff it yields a non-empty seller name and a price that is finite, `> 0` and `<= 1e13` (B6, B9). Other rows
are skipped silently; later rows are not affected by a skipped row.

Name cleaning: plain text of the name cell; icon-only elements (e.g. `<i class="fa fa-trophy">`) add no text; a trailing
parenthesised portal tag such as `(MSE)` is stripped (fixture: `<i trophy/> Kaveri ... (MSE)` gives `Kaveri Systems & Services Pvt Ltd`).

Winner selection among accepted rows, first match wins (B3):
1. A row marked as winner: the row (`<tr>`) or any of its cells carries a class token `winner`, or contains a trophy icon
   (class containing `trophy`). First such row in document order.
2. Else the row with rank 1.
3. Else the first accepted row.

## 7. Number parsing (Indian formats)

Applied to the price cell's text:

- Accepts plain digits, Indian grouping (`28,40,500.00`), Western grouping, optional decimal part; commas are separators only.
- Currency marks are ignored only as a prefix or a suffix of the numeric token, separated by optional whitespace: `₹`, `Rs`, `Rs.`,
  `INR` (case-insensitive), including when they arrive as entities (`&#8377;`, `&nbsp;`) (B1, B6c-d).
- A currency word inside the digits (`15Rs0`), scientific notation (`1e5`), text (`abc`), empty, multiple numbers, or a negative
  sign gives "not an amount" so the row is skipped.
- Value must be `> 0` and `<= 1e13`; `99999999999999` (1e14-1) is rejected (B6). `0` is rejected (B9).
- Returned price is the parsed number in rupees (decimals preserved, e.g. `28,40,500.00` gives `2840500`).
- Parsing must be a linear scan of the cell (no backtracking regex).

## 8. Behaviour requirements (one per test case in `award.test.ts`)

Shorthand: `T(rows)` = `<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr>` + rows + `</table>`.

| # | Test | Input shape | Expected |
|---|------|-------------|----------|
| B1 | reads the rank/price table (fixture `ra-result.html`) | Page with 3 tables: RA key/value table; technical table (`S.No, Seller, Technical Status`); financial table (`Rank, Seller Name, Total Price (₹)`) with rows `L1 / <i trophy/> Kaveri Systems &amp; Services Pvt Ltd (MSE) / 28,40,500.00`, `L2 / Aarav Infotech Pvt Ltd / 29,50,000.00`, `L3 / Dhruv Traders / ₹ 31,25,000` | `toEqual` `{ l1Price: 2840500, l1Seller: 'Kaveri Systems & Services Pvt Ltd', bidders: [{rank:1,name:'Kaveri Systems & Services Pvt Ltd',price:2840500},{rank:2,name:'Aarav Infotech Pvt Ltd',price:2950000},{rank:3,name:'Dhruv Traders',price:3125000}] }` |
| B2 | ignores technical-evaluation and RA-details tables | same fixture | `bidders` names do not include `Northline Computers` (the disqualified seller of the technical table) |
| B3a | winner: else rank 1 | `T` with rows `2 / Beta Co / 200` then `1 / Alpha Co / 100`, no winner mark | `l1Seller 'Alpha Co'`, `l1Price 100` |
| B3b | winner: trophy/winner row first | `T` with `1 / Alpha Co / 100` then a row whose `<td class="winner">` holds `Beta Co`, price 200, rank 2 | `l1Seller 'Beta Co'`, `l1Price 200` (marked row beats rank 1) |
| B3c | winner: else first row; no rank column | `T('<tr><td>Gamma Co</td><td>Rs. 1,50,000</td></tr>')` (header declares 3 columns, row has only 2 cells: name then price, rank absent) | `l1Seller 'Gamma Co'`, `l1Price 150000`, `bidders: [{rank:0,name:'Gamma Co',price:150000}]` (rank 0). Cell-count mismatch with the header must not discard the row; use the content fallback of section 5 |
| B4 | rank is never the price | `<table><tr><th>Rank</th><th>Name</th></tr><tr><td>L1</td><td>Alpha Co</td></tr></table>` | `null` (the only number is the rank) |
| B5 | columns from header words, not position | header `S.No, Seller, Price, Rank`; rows `1 / B Co / 200 / 2` and `2 / A Co / 100 / 1` | `l1Price 100`, `l1Seller 'A Co'`; `bidders` `toEqual` `[{rank:2,name:'B Co',price:200},{rank:1,name:'A Co',price:100}]` (document order; S.No is not rank) |
| B6 | absurd amounts / Rs affixes (header `Name, Price`, row `Alpha Co / <p>`) | `99999999999999` | `null` |
| B6b | | `1e5` | `null` |
| B6c | | `Rs. 1,50,000` | `l1Price 150000` |
| B6d | | `150000 INR` | `l1Price 150000` |
| B6e | | `15Rs0` | `null` |
| B7 | linear on hostile 512 KB header row, 4 combinations (`a`,`b`) = (`td`,`th`) and (`th`,`td`) | `<table><tr><b>Price</b>` + filler + `</tr><tr><b>A Co</b><b>5</b></tr></table>` where `b` is the second-row tag and filler is either `<a>x</a>` repeated to about 512 KB, or bare unclosed `<a>` repeated to about 512 KB | does not throw; each call returns in < 200 ms (result not asserted; header row with 50k+ cells must not cause quadratic column lookup) |
| B8 | null when no price table | (i) `''`; (ii) `<p>Rank 1: Alpha 100</p>` (no table); (iii) `<table><tr><th>Name</th><th>City</th></tr><tr><td>Alpha Co</td><td>Pune</td></tr></table>` | `null` for each |
| B9 | skips rows without seller or positive price | `T` rows `1 / Alpha Co / 0`, `2 / Beta Co / abc`, `3 / Delta Co / 5,000` | `bidders` `toEqual` `[{rank:3,name:'Delta Co',price:5000}]` |
| B10 | linear on hostile markup | (i) `<table><tr><th>Price</th>` + `<td` x 50,000 (unterminated); (ii) `<table><tr><th>Price</th></tr>` + `<tr><td>1</td><td>A` x (512 KB / 16) (unclosed cells/rows, no valid price) | both `null`; both together < 2000 ms |

Currency affix handling is covered by B1 (`₹ 31,25,000`), B3c, B6c-d; non-price tables by B2 and B8; hostile input by B7 and B10; limits by section 3.

Review additions (tests in `award-result.test.ts`): partly labelled headers (`Rank | Firm | Price`, `Rank | Participant | Total Price (₹)`, Supplier, Agency); block versus inline tags; price-wins header cells; non-string input; nested tables in document order; a winner-marked row that is not rank 1 wins.

Observable behaviour from the UI/E2E (SubmitStep, S9/S9b), which the parser must satisfy:
- Fixture gives L1 `2840500` and seller containing `Kaveri Systems & Services Pvt Ltd`; the UI rounds `l1Price` to an integer.
- A page with a heading, a paragraph and a single 2-cell `RA End Date | 05-11-2026` table gives `null`.
- A 6 MB header cell / 200k `<th>` cells (input already sliced to 512 KB by the caller) completes quickly with no freeze.

## 9. Non-goals

No login or fetching of GeM pages (FR-085); no uploading of the saved page; no technical-qualification status extraction; no
persistence. The function only suggests values; the human confirms in the dialog.
