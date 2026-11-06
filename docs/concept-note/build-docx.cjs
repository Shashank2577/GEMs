// Builds the Word edition of the concept note (Inventis Labs). Run: NODE_PATH=$(npm root -g) node build-docx.cjs <img-dir> <out.docx> <image-dims.json>
// Builds TenderPilot-Concept-Note.docx (Inventis Labs edition) from the same content as the PDF.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, Footer, AlignmentType, WidthType,
  BorderStyle, ShadingType, VerticalAlign, LevelFormat, TabStopType, PageNumber, HeightRule, TableLayoutType, PageBreak, LineRuleType,
} = require('docx');

const IMG = process.argv[2];            // dir with the jpgs
const OUT = process.argv[3];
const DIMS = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));

const C = { navy: '0B2545', navy2: '13315C', ink: '1C2533', body: '3A4556', grey: '6B7686', grey2: '9AA3B0', rule: 'DCE1E8',
  wash: 'F3F5F8', wash2: 'E9EDF2', teal: '0F8B80', tealDk: '0B6B63', tealWash: 'E3F3F1', white: 'FFFFFF', rose: 'B4333F' };
const SERIF = 'Georgia', SANS = 'Calibri';
const W = 9752;                 // content width (DXA) with 1077 side margins
const px = (dxa) => Math.round(dxa / 15);

// ───────── primitives ─────────
const R = (text, o = {}) => new TextRun({ text, font: o.font || SANS, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color || C.body, characterSpacing: o.spacing, allCaps: o.caps });
const P = (kids, o = {}) => new Paragraph({
  children: (Array.isArray(kids) ? kids : [typeof kids === 'string' ? R(kids, o) : kids]),
  alignment: o.align, keepNext: o.keepNext, pageBreakBefore: o.pageBreakBefore, keepLines: o.keepLines,
  spacing: { before: o.before ?? 0, after: o.after ?? 100, line: o.line ?? 276, lineRule: LineRuleType.AUTO },
  indent: o.indent, border: o.border,
});
const bullet = (text, o = {}) => new Paragraph({ numbering: { reference: 'bul', level: 0 }, children: [R(text, { size: o.size || 20 })], spacing: { before: 0, after: 40, line: 264, lineRule: LineRuleType.AUTO } });
const kicker = (num, label, o = {}) => P([R(`${num}  `, { font: SANS, size: 18, bold: true, color: C.teal, spacing: 40 }), R(label.toUpperCase(), { size: 18, bold: true, color: C.teal, spacing: 40 })], { pageBreakBefore: !o.first, after: 80, keepNext: true });
const title = (t) => P([R(t, { font: SERIF, size: 38, bold: true, color: C.navy })], { after: 140, line: 252, keepNext: true });
const lead = (t) => P([R(t, { size: 22, color: C.body })], { after: 160, line: 288 });
const exhibit = (n, t) => P([R(`Exhibit ${n}  `, { size: 17, bold: true, color: C.teal, spacing: 20 }), R(t, { size: 21, bold: true, color: C.ink })], { before: 120, after: 80, keepNext: true });
const source = (t) => P([R(t, { size: 16, italics: true, color: C.grey })], { before: 60, after: 120 });
const caption = (t) => P([R(t, { size: 17, italics: true, color: C.grey })], { before: 40, after: 120, align: AlignmentType.LEFT });
const h3 = (t, o = {}) => P([R(t, { font: SERIF, size: 26, bold: true, color: o.color || C.navy })], { before: o.before ?? 160, after: 80, keepNext: true });

const NB = { style: BorderStyle.NONE, size: 0, color: C.white };
const NONE = { top: NB, bottom: NB, left: NB, right: NB };
const line = (c = C.rule, s = 4) => ({ style: BorderStyle.SINGLE, size: s, color: c });
const BOX = (c = C.rule) => ({ top: line(c), bottom: line(c), left: line(c), right: line(c) });
const shade = (fill) => ({ type: ShadingType.CLEAR, fill, color: 'auto' });

function cell(children, w, o = {}) {
  return new TableCell({
    children: Array.isArray(children) ? children : [children], width: { size: w, type: WidthType.DXA },
    borders: o.borders || NONE, shading: o.fill ? shade(o.fill) : undefined, verticalAlign: o.v || VerticalAlign.TOP,
    columnSpan: o.span, margins: { top: o.mt ?? 80, bottom: o.mb ?? 80, left: o.ml ?? 110, right: o.mr ?? 110 },
  });
}
function table(rows, widths, o = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
    alignment: o.align, borders: { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB },
    rows: rows.map((cells, i) => new TableRow({ children: cells, cantSplit: true, height: (o.rowHeights?.[i] ?? o.rowHeight) ? { value: o.rowHeights?.[i] ?? o.rowHeight, rule: o.rowRule || HeightRule.ATLEAST } : undefined })),
  });
}
const gap = (n = 120) => new Paragraph({ children: [], spacing: { before: 0, after: n, line: 120 } });

function img(file, widthPx, o = {}) {
  const [w, h] = DIMS[file];
  return new Paragraph({
    alignment: o.align || AlignmentType.CENTER, spacing: { before: o.before ?? 40, after: o.after ?? 40 }, keepNext: o.keepNext,
    children: [new ImageRun({ type: 'jpg', data: fs.readFileSync(path.join(IMG, file)), transformation: { width: widthPx, height: Math.round(widthPx * h / w) },
      altText: { title: o.alt || file, description: o.alt || file, name: file } })],
  });
}
const framed = (file, widthPx, alt) => table([[cell(img(file, widthPx, { alt, before: 0, after: 0 }), (widthPx * 15 + 160), { borders: BOX(C.rule), mt: 60, mb: 60, ml: 80, mr: 80 })]], [widthPx * 15 + 160], { align: AlignmentType.CENTER });

// ───────── cover & back page ─────────
const PAGE_H = 16838, PAGE_W = 11906;
function navyPage(rows, heights) {
  return table(rows, [PAGE_W], { rowHeights: heights });
}
const wm = () => P([R('Tender', { font: SERIF, size: 36, bold: true, color: C.white }), R('Pilot', { font: SERIF, size: 36, bold: true, color: '4FD1C5' })], { after: 0 });

const cover = [
  navyPage([
    [cell([
      P('', { before: 700, after: 0 }),
      wm(),
      P([R('by Inventis Labs', { size: 20, color: C.grey2, spacing: 30 })], { after: 700 }),
      P([R('CONCEPT NOTE', { size: 20, bold: true, color: '4FD1C5', spacing: 80 })], { after: 160 }),
      P([R('Win more GeM bids with a co-pilot that ', { font: SERIF, size: 66, bold: true, color: C.white }), R('never takes the wheel', { font: SERIF, size: 66, bold: true, italics: true, color: '4FD1C5' })], { after: 240, line: 240 }),
      P([R('How TenderPilot helps MSMEs, OEMs and resellers find the right Government e-Marketplace bids, decide faster, and submit complete, compliant bids, while your team keeps control of every price and signature.', { size: 24, color: 'C9D3E0' })], { after: 360, line: 300 }),
      table([
        [cell(P([R('Date', { size: 16, color: C.grey2, spacing: 30, caps: true })], { after: 0 }), 1700, { mt: 40, mb: 0 }), cell(P([R('Prepared for', { size: 16, color: C.grey2, spacing: 30, caps: true })], { after: 0 }), 2800, { mt: 40, mb: 0 }),
         cell(P([R('Prepared by', { size: 16, color: C.grey2, spacing: 30, caps: true })], { after: 0 }), 3300, { mt: 40, mb: 0 }), cell(P([R('Document', { size: 16, color: C.grey2, spacing: 30, caps: true })], { after: 0 }), 2000, { mt: 40, mb: 0 })],
        [cell(P([R('November 2026', { size: 21, bold: true, color: C.white })], { after: 0 }), 1700, { mt: 0 }), cell(P([R('[Client name]', { size: 21, bold: true, color: C.white })], { after: 0 }), 2800, { mt: 0 }),
         cell(P([R('Inventis Labs', { size: 21, bold: true, color: C.white })], { after: 0 }), 3300, { mt: 0 }), cell(P([R('Concept note, v1.0', { size: 21, bold: true, color: C.white })], { after: 0 }), 2000, { mt: 0 })],
      ], [1700, 2800, 3300, 2000]),
      P([R('Confidential. Prepared for the named recipient only; not for onward distribution.', { size: 16, color: C.grey2 })], { before: 260, after: 0 }),
    ], PAGE_W, { fill: C.navy, ml: 1077, mr: 1077, mt: 0, mb: 0 })],
    [cell([img('dashboard.jpg', 640, { alt: 'TenderPilot dashboard', before: 0, after: 0 })], PAGE_W, { fill: C.navy, ml: 1077, mr: 1077, mt: 0, mb: 0, v: VerticalAlign.BOTTOM })],
  ], [10300, 6400]),
];

const back = [
  navyPage([[cell([
    P('', { before: 600, after: 0 }),
    wm(),
    P([R('by Inventis Labs', { size: 20, color: C.grey2, spacing: 30 })], { after: 700 }),
    P([R('NEXT STEPS', { size: 20, bold: true, color: '4FD1C5', spacing: 80 })], { after: 140 }),
    P([R('See it on your own bids in thirty minutes', { font: SERIF, size: 58, bold: true, color: C.white })], { after: 200, line: 240 }),
    P([R('We run TenderPilot live on your product categories, so the first bids you see are ones you could bid on this week.', { size: 24, color: 'C9D3E0' })], { after: 520, line: 300 }),
    ...[['1', 'A 30-minute walkthrough', 'Live on GeM bids in your categories and states, with your bid manager in the room.', 'This week'],
        ['2', 'Onboarding in days', 'Company profile, watchlists and document vault set up together. Alerts start the same day.', 'Days 1 to 5'],
        ['3', 'Four-week pilot review', 'We compare the success metrics with your baseline and agree the rollout plan.', 'Week 4']].map(([n, t, d, when]) =>
      table([[cell(P([R(n, { font: SERIF, size: 44, bold: true, color: '4FD1C5' })], { after: 0 }), 800, { mt: 100 }),
              cell([P([R(t, { size: 26, bold: true, color: C.white })], { after: 40 }), P([R(d, { size: 21, color: 'C9D3E0' })], { after: 0 })], 7000, { mt: 100 }),
              cell(P([R(when, { size: 20, bold: true, color: '4FD1C5' })], { after: 0, align: AlignmentType.RIGHT }), 1952, { mt: 100 })]], [800, 7000, 1952])),
    P('', { before: 200, after: 0 }),
    P([R('YOUR CONTACT', { size: 17, bold: true, color: '4FD1C5', spacing: 60 })], { before: 200, after: 80 }),
    P([R('Shashank', { font: SERIF, size: 34, bold: true, color: C.white })], { after: 20 }),
    P([R('Head of Technology, Inventis Labs', { size: 24, color: 'C9D3E0' })], { after: 60 }),
    P([R('[email]  ·  [phone]', { size: 22, color: C.grey2 })], { after: 700 }),
    P([R('Product screenshots show TenderPilot with a sample company, Aarav Technologies Pvt Ltd, and illustrative bid data. Figures marked target or illustrative are not measured client results. GeM is the Government of India\'s procurement platform; TenderPilot is an independent product and is not affiliated with or endorsed by GeM.', { size: 16, color: C.grey2 })], { after: 0, line: 252 }),
  ], PAGE_W, { fill: C.navy, ml: 1077, mr: 1077, mt: 0, mb: 0 })]], [16700]),
];

// ───────── body pages ─────────
const body = [];
const add = (...x) => body.push(...x);

// 2 — executive summary
add(kicker('01', 'Executive summary', { first: true }),
  title('TenderPilot turns GeM bidding from a late-night scramble into a ten-minute routine that your team still signs off'),
  lead('GeM publishes more opportunity than any bid desk can read. Most of a bid team\'s day goes on finding, reading and assembling, not on winning. TenderPilot does that groundwork continuously, explains every recommendation, and hands your team a ready packet. Price, authentication and the final click stay with your people.'),
  table([[
    ...[['1', 'Identify', 'TenderPilot watches GeM around the clock for bids that match what you sell, where you sell and to whom.', ['Alerts on WhatsApp, email and in-app', 'Corrigenda flagged the moment they appear'], 't-identify.jpg'],
        ['2', 'Analyse', 'It reads the bid documents, checks them against your company profile and gives a Go/No-Go score with its reasons.', ['Each reason linked to the page it came from', 'Exemptions and preferences applied'], 't-analyse.jpg'],
        ['3', 'Apply', 'It pulls certificates from your vault, fills the undertakings and merges one bid packet in the order GeM expects.', ['Expiry alerts before a certificate lapses', 'A checklist for the steps only a person can do'], 't-apply.jpg']].map(([n, t, d, bl, im], i) =>
      cell([P([R(n, { font: SERIF, size: 40, bold: true, color: C.teal })], { after: 0 }), P([R(t, { font: SERIF, size: 28, bold: true, color: C.navy })], { after: 60 }), P([R(d, { size: 19 })], { after: 80, line: 260 }), ...bl.map((b) => bullet(b, { size: 18 })), img(im, 175, { before: 80, align: AlignmentType.LEFT, alt: `${t} screenshot` })],
        3250 + (i === 2 ? 2 : 0), { borders: { ...NONE, top: line(C.teal, 12) }, ml: 90, mr: 150, mt: 120 })),
  ]], [3250, 3250, 3252]),
  exhibit(1, 'What changes for a typical bid desk'),
  table([[
    ...[['3 h → 10 min', 'to assemble a complete bid packet', 'TARGET'], ['< 1 hour', 'from publication on GeM to an alert on your phone', 'TARGET'], ['Minutes', 'to a Go/No-Go decision, with reasons and evidence', 'ILLUSTRATIVE'], ['Zero', 'GeM passwords held. Your team does every submission.', 'BY DESIGN']].map(([n, d, tag]) =>
      cell([P([R(n, { font: SERIF, size: 32, bold: true, color: C.teal })], { after: 20 }), P([R(d, { size: 18 })], { after: 40, line: 240 }), P([R(tag, { size: 14, bold: true, color: C.grey, spacing: 40 })], { after: 0 })], 2438, { borders: { ...NONE, top: line(C.rule) }, mt: 100 })),
  ]], [2438, 2438, 2438, 2438]),
  source('Source: TenderPilot team analysis; illustrative. Figures are targets, not measured client results. They will be baselined during your pilot.'),
  table([[cell([
    P([R('What this means for leadership', { font: SERIF, size: 26, bold: true, color: C.tealDk })], { after: 100 }),
    table([[
      ...[['More of the right bids', 'Your team sees every relevant bid early and does not lose one to a missed corrigendum or deadline.'], ['Fewer wasted bids', 'Bids you cannot win are ruled out in minutes, before anyone spends a day on them.'], ['No risk to the account', 'Humans keep price, OTP/DSC/e-Sign and the final submit, so your GeM seller account stays protected.']].map(([t, d]) =>
        cell([P([R(t, { size: 20, bold: true, color: C.navy })], { after: 30 }), P([R(d, { size: 18 })], { after: 0, line: 250 })], 3000, { mt: 40, mb: 40 })),
    ]], [3000, 3000, 3000]),
  ], W, { fill: C.tealWash, ml: 200, mr: 200, mt: 160, mb: 140 })]], [W]),
);

// 3 — the problem
add(kicker('02', 'The problem'),
  title('GeM is a large market, but bid teams spend most of their time before they even decide to bid'),
  lead('GeM handled more than ₹4 lakh crore of public orders in FY 2023-24, and thousands of bids go live on a typical working day. For a seller the hard part is not access. It is separating the few bids you can win from the many you cannot, and then getting each one right.'),
  exhibit(2, 'From the daily flood to the bids worth your time'),
  table([
    ['3,000+', 'Bids published on GeM on a typical working day', 'All categories, all states, all buyers', C.navy],
    ['~60', 'In your product categories', '', C.navy2],
    ['~12', 'In your states and value range', '', C.tealDk],
    ['~4', 'You are eligible for and can win', 'This is where your team\'s time should go', C.teal],
  ].map(([n, d, sub, fill]) => [
    cell(P([R(n, { font: SERIF, size: 36, bold: true, color: C.white })], { after: 0, align: AlignmentType.CENTER }), 2100, { fill, v: VerticalAlign.CENTER, mt: 90, mb: 90 }),
    cell([P([R(d, { size: 21, bold: true, color: C.ink })], { after: sub ? 20 : 0 }), ...(sub ? [P([R(sub, { size: 18, color: C.grey })], { after: 0 })] : [])], 7652, { v: VerticalAlign.CENTER, borders: { ...NONE, bottom: line(C.rule) } }),
  ]), [2100, 7652]),
  source('Source: GeM public statements (order value); TenderPilot team analysis for a typical IT-hardware seller; illustrative.'),
  h3('Where bids are lost'),
  table([
    ['Volume and noise', 'Someone scans the portal every day. Relevant bids get found late, or not at all.'],
    ['Eligibility fine print', 'Turnover, experience, OEM authorisation and Make in India clauses sit deep in long bid documents.'],
    ['Corrigenda', 'Changed dates, specifications or terms are easy to miss once a bid is being prepared.'],
    ['Document chasing', 'Certificates live in inboxes and on personal drives. An expired one is found on the closing day.'],
    ['Deadlines and rework', 'Undertakings are retyped and PDFs merged by hand at night. A slip can disqualify the bid.'],
  ].map(([t, d], i) => [cell(P([R(String(i + 1).padStart(2, '0'), { font: SERIF, size: 24, bold: true, color: C.teal })], { after: 0 }), 700, { borders: { ...NONE, bottom: line(C.rule) }, mt: 60, mb: 60 }),
    cell([P([R(t, { size: 20, bold: true, color: C.ink }), R('  ' + d, { size: 19 })], { after: 0, line: 252 })], 9052, { borders: { ...NONE, bottom: line(C.rule) }, mt: 60, mb: 60 })]), [700, 9052]),
  h3('GeM terms in plain words'),
  table([
    [['EMD', 'Earnest money deposit: a refundable amount that guarantees you will honour your bid.'], ['ePBG', 'Performance bank guarantee: security the winning seller gives, usually a % of the order value.']],
    [['MSE', 'Micro and small enterprise (Udyam-registered). Often exempt from EMD and some turnover or experience rules.'], ['Make in India Class-I / II', 'Local-content classes (≥50% / ≥20%). Class-I suppliers get purchase preference.']],
    [['ATC', 'Additional terms and conditions a buyer adds to the standard GeM terms. Often where the traps are.'], ['BOQ', 'Bill of quantities: the itemised list of what the buyer wants, in what quantity.']],
    [['Corrigendum', 'An official change to a published bid, such as a new date, specification or term.'], ['OTP / DSC / e-Sign', 'The ways a person legally authenticates a GeM submission: one-time password, digital signature certificate or Aadhaar e-Sign.']],
  ].map((pair) => pair.flatMap(([t, d]) => [cell(P([R(t, { size: 18, bold: true, color: C.teal })], { after: 0 }), 1250, { fill: C.wash, mt: 60, mb: 60 }), cell(P([R(d, { size: 17 })], { after: 0, line: 240 }), 3626, { fill: C.wash, mt: 60, mb: 60 })])), [1250, 3626, 1250, 3626]),
);

// 4 — approach
add(kicker('03', 'Our approach'),
  title('A co-pilot, not an autopilot: TenderPilot prepares everything, and your team keeps the controls that protect your GeM account'),
  lead('GeM expects a named person to enter the price and authenticate every bid. Shared logins and bots that submit on your behalf risk your seller account. TenderPilot is built around that rule, so it does the most preparation for the least account risk.'),
  exhibit(3, 'Bid preparation done for you vs. risk to your account'),
  table([
    [cell(P([R('', { size: 16 })], { after: 0 }), 1500), cell(P([R('Less done for you', { size: 16, bold: true, color: C.grey, spacing: 30, caps: true })], { after: 0, align: AlignmentType.CENTER }), 4126), cell(P([R('More done for you', { size: 16, bold: true, color: C.grey, spacing: 30, caps: true })], { after: 0, align: AlignmentType.CENTER }), 4126)],
    [cell(P([R('Higher risk to your GeM account', { size: 16, bold: true, color: C.grey, spacing: 30, caps: true })], { after: 0 }), 1500, { v: VerticalAlign.CENTER }),
     cell([P([R('Consultant with your login', { size: 21, bold: true, color: C.ink })], { after: 40 }), P([R('Some work done for you, but your credentials are shared outside the company.', { size: 18 })], { after: 0 })], 4126, { borders: BOX(), fill: C.wash, mt: 140, mb: 140 }),
     cell([P([R('Auto-submit bots', { size: 21, bold: true, color: C.ink })], { after: 40 }), P([R('Fast, but automated logins and submissions can get a seller account suspended.', { size: 18 })], { after: 0 })], 4126, { borders: BOX(), fill: C.wash, mt: 140, mb: 140 })],
    [cell(P([R('Lower risk to your GeM account', { size: 16, bold: true, color: C.grey, spacing: 30, caps: true })], { after: 0 }), 1500, { v: VerticalAlign.CENTER }),
     cell([P([R('Do it yourself', { size: 21, bold: true, color: C.ink })], { after: 40 }), P([R('Safe, but slow: portal checks, spreadsheets and late nights.', { size: 18 })], { after: 0 })], 4126, { borders: BOX(), fill: C.wash, mt: 140, mb: 140 }),
     cell([P([R('TenderPilot', { size: 23, bold: true, color: C.white })], { after: 40 }), P([R('Most of the work prepared for you. Your login, price and signature never leave your hands.', { size: 18, color: C.white })], { after: 0 })], 4126, { borders: BOX(C.teal), fill: C.teal, mt: 140, mb: 140 })],
  ], [1500, 4126, 4126]),
  source('Source: TenderPilot team analysis; illustrative positioning.'),
  table([[
    cell([P([R('TenderPilot prepares', { font: SERIF, size: 24, bold: true, color: C.tealDk })], { after: 80 }), ...['Finds and filters matching bids', 'Reads bid documents and corrigenda', 'Checks eligibility and scores Go/No-Go', 'Fills undertakings and annexures', 'Merges the bid packet in order', 'Pre-fills non-financial GeM fields, only when you click'].map((t) => bullet(t))], 4876, { borders: { ...NONE, top: line(C.teal, 12) }, mt: 100 }),
    cell([P([R('Your team always does', { font: SERIF, size: 24, bold: true, color: C.navy })], { after: 80 }), ...['Decides whether to bid', 'Enters the price on GeM', 'Authenticates with OTP, DSC or e-Sign', 'Solves the CAPTCHA', 'Clicks Final Submit'].map((t) => bullet(t))], 4876, { borders: { ...NONE, top: line(C.navy, 12) }, mt: 100 }),
  ]], [4876, 4876]),
  gap(60),
  table([[
    cell([img('submit.jpg', 300, { alt: 'TenderPilot bid workspace submit step', before: 0, after: 20, align: AlignmentType.LEFT }), P([R('Screenshot: TenderPilot bid workspace, submit step.', { size: 15, italics: true, color: C.grey })], { after: 0 })], 4700, { mt: 40 }),
    cell([exhibit(4, 'The human-only steps are part of the product'),
      P([R('At the submit step every bid workspace lists the four actions only your team performs: enter the price, upload the packet, authenticate, and click Final Submit. When the bid is in, a named person marks it submitted, so the pipeline and audit trail stay accurate.', { size: 18 })], { after: 80, line: 252 }),
      P([R('Why it matters: ', { size: 18, bold: true, color: C.navy }), R('your compliance position is simple to explain to auditors, OEM partners and buyers. TenderPilot never holds your GeM password.', { size: 18 })], { after: 0, line: 252 })], 5052, { mt: 0 }),
  ]], [4700, 5052]),
);

// 5 — identify
add(kicker('04', 'Identify'),
  title('Every bid you can win reaches the right person within the hour, on the channel they already use'),
  lead('Your team describes what you sell once. TenderPilot watches GeM continuously and brings back only the bids that fit, already sorted by closing date and fit.'),
  framed('feed.jpg', 620, 'TenderPilot tender feed'),
  caption('Exhibit 5: The tender feed shows live GeM bids matched to your watchlists, with filters by state, ministry, closing date and value.'),
  table([[
    cell([['Always-on watchlists', 'Match by product and keyword, GeM category, state and city, buyer ministry or organisation, and order value. One watchlist per product line or region.'],
          ['Instant alerts, wherever you are', 'New matches, corrigenda, closing-day reminders and expiring certificates go out on WhatsApp, email and in-app, with a daily digest for the owner.'],
          ['Triage in one view', 'Saved views such as "closing this week" or "Go verdicts" let the bid manager plan the week in a few minutes.']].flatMap(([t, d]) =>
      [P([R(t, { font: SERIF, size: 24, bold: true, color: C.navy })], { after: 30, before: 40 }), P([R(d, { size: 19 })], { after: 90, line: 260 })]), 6500, { mt: 40 }),
    cell([img('m-alerts.jpg', 150, { alt: 'Alerts on mobile', before: 0, after: 20 }), P([R('Exhibit 6: Alerts on mobile', { size: 16, italics: true, color: C.grey })], { after: 0, align: AlignmentType.CENTER })], 3252, { v: VerticalAlign.TOP }),
  ]], [6500, 3252]),
);

// 6 — analyse
add(kicker('05', 'Analyse'),
  title('A Go/No-Go verdict in minutes, with every reason traced back to the page of the bid it came from'),
  lead('TenderPilot reads the bid document and any corrigenda, checks each condition against your company profile and vault, and explains its verdict. In the example below it stops a bid early: the bid needs an OEM authorisation that expired five days ago.'),
  framed('analysis.jpg', 590, 'TenderPilot tender analysis'),
  caption('Exhibit 7: Tender analysis for a desktop-computer bid from the Indian Army. Illustrative sample company.'),
  table([[
    ...[['1', 'Score and verdict', 'A single score with a plain-language Go, Review or No-Go, and how confident TenderPilot is.'], ['2', 'Hard blockers first', 'Disqualifying conditions override the score, so a high number never hides a fatal gap.'], ['3', 'Evidence, not opinion', 'Each factor quotes the bid text and page. Your analyst can check it, or override it with a note.'], ['4', 'Document checklist', 'Every document the bid asks for, mapped to your vault, with the ones TenderPilot can generate marked.']].map(([n, t, d]) =>
      cell([P([R(n, { font: SERIF, size: 30, bold: true, color: C.teal })], { after: 0 }), P([R(t, { size: 19, bold: true, color: C.navy })], { after: 30 }), P([R(d, { size: 17 })], { after: 0, line: 240 })], 2438, { borders: { ...NONE, top: line(C.teal, 8) }, mt: 90 })),
  ]], [2438, 2438, 2438, 2438]),
  h3('What TenderPilot checks on every bid'),
  table(['Average annual turnover', 'Years of experience', 'Similar work value', 'OEM authorisation', 'MSE and Startup exemptions', 'Make in India Class-I / II', 'EMD and ePBG', 'Certificates and validity', 'Delivery location and time', 'Time left to prepare', 'ATC clauses', 'Documents in your vault'].reduce((rows, t, i) => {
    if (i % 4 === 0) rows.push([]);
    rows[rows.length - 1].push(cell(P([R(t, { size: 18, bold: true, color: C.navy })], { after: 0, align: AlignmentType.CENTER }), 2438, { fill: C.wash, borders: BOX(C.white), v: VerticalAlign.CENTER, mt: 90, mb: 90 }));
    return rows;
  }, []), [2438, 2438, 2438, 2438]),
);

// 7 — apply
add(kicker('06', 'Apply'),
  title('From a Go decision to a submission-ready bid packet in about ten minutes, with nothing expired and nothing missing'),
  table([[
    ...[['1 · Vault', 'Certificates matched to the bid\'s checklist', C.navy], ['2 · Annexures', 'Undertakings filled from your profile', C.navy2], ['3 · Packet', 'One merged PDF in GeM order', C.tealDk], ['4 · Submit', 'Your team prices and signs on GeM', C.teal]].map(([t, d, fill]) =>
      cell([P([R(t, { size: 21, bold: true, color: C.white })], { after: 20 }), P([R(d, { size: 17, color: 'E6EDF5' })], { after: 0, line: 236 })], 2438, { fill, borders: BOX(C.white), mt: 110, mb: 110 })),
  ]], [2438, 2438, 2438, 2438]),
  gap(100),
  table([[
    cell([img('packet.jpg', 440, { alt: 'Bid workspace packet step', before: 0, after: 20 }), P([R('Exhibit 8: The bid workspace: twelve documents, four of them generated annexures, merged into one 13-page packet.', { size: 16, italics: true, color: C.grey })], { after: 0 })], 6700, {}),
    cell([img('m-vault.jpg', 150, { alt: 'Document vault on mobile', before: 0, after: 20 }), P([R('Exhibit 9 (phone): the document vault with its expiry timeline.', { size: 16, italics: true, color: C.grey })], { after: 0, align: AlignmentType.CENTER })], 3052, {}),
  ]], [6700, 3052]),
  gap(60),
  table([[
    ...[['Document vault with expiry alerts', 'GST, PAN, Udyam, ISO, balance sheets, CA certificates, completion certificates and OEM authorisations in one place. Reminders go out 30, 7 and 1 day before expiry.'], ['Undertakings, written for you', 'EMD exemption requests, Make in India self-certificates, non-blacklisting undertakings and covering letters are filled from your profile and the bid, ready to sign and stamp.'], ['One click to a packet, then you submit', 'The packet comes with a cover index and the file order GeM expects. A submission assistant lists the values to enter and the steps your team completes on GeM.']].map(([t, d]) =>
      cell([P([R(t, { font: SERIF, size: 22, bold: true, color: C.navy })], { after: 40 }), P([R(d, { size: 18 })], { after: 0, line: 250 })], 3250, { borders: { ...NONE, top: line(C.teal, 8) }, mt: 90 })),
  ]], [3250, 3250, 3252]),
);

// 8 — impact
const steps = [['Find the bid', 'Daily manual scan of the portal across categories and states', 'Matched automatically; alert within the hour', '~30 min'],
  ['Read and qualify', 'Read a 20 to 60 page bid and ATC; check eligibility by hand', 'Go/No-Go with reasons and page references', '~45 min'],
  ['Track corrigenda', 'Re-open the bid page and hope nothing changed', 'Changes flagged and re-checked automatically', '~10 min'],
  ['Gather documents', 'Chase colleagues and drives; expired certificates found late', 'Pulled from the vault; expiries flagged weeks ahead', '~40 min'],
  ['Undertakings and annexures', 'Retype last bid\'s Word templates, fix names and numbers', 'Generated from your profile and the bid', '~25 min'],
  ['Assemble the packet', 'Convert, merge, rename and order PDFs by hand', 'One click; merged PDF with index', '~20 min']];
const th = (t, w) => cell(P([R(t, { size: 16, bold: true, color: C.white, spacing: 20, caps: true })], { after: 0 }), w, { fill: C.navy, mt: 70, mb: 70 });
add(kicker('07', 'Impact'),
  title('Your bid desk gets back about three hours on every bid, and spends them on price and buyer relationships'),
  lead('The work does not disappear. It moves from people to TenderPilot, and the time that is left goes to the decisions only your team can make.'),
  exhibit(10, 'One bid, before and after TenderPilot'),
  table([
    [th('Step', 1900), th('Today', 3100), th('With TenderPilot', 3100), th('Time saved', 1652)],
    ...steps.map(([a, b, c, d], i) => [cell(P([R(a, { size: 18, bold: true, color: C.ink })], { after: 0 }), 1900, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) } }), cell(P([R(b, { size: 17 })], { after: 0, line: 236 }), 3100, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) } }), cell(P([R(c, { size: 17 })], { after: 0, line: 236 }), 3100, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) } }), cell(P([R(d, { size: 18, bold: true, color: C.teal })], { after: 0 }), 1652, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) } })]),
    [cell(P([R('Total per bid', { size: 19, bold: true, color: C.navy })], { after: 0 }), 1900, { fill: C.tealWash }), cell(P([R('~3 hours, often after hours', { size: 18, bold: true, color: C.navy })], { after: 0 }), 3100, { fill: C.tealWash }), cell(P([R('~10 minutes of review', { size: 18, bold: true, color: C.navy })], { after: 0 }), 3100, { fill: C.tealWash }), cell(P([R('~2 h 50 min', { size: 19, bold: true, color: C.teal })], { after: 0 }), 1652, { fill: C.tealWash })],
  ], [1900, 3100, 3100, 1652]),
  source('Source: TenderPilot team analysis of a typical goods bid; illustrative. Price entry and authentication on GeM are not included and stay with your team.'),
  exhibit(11, 'Minutes of team effort per bid, by step'),
  (() => {
    const segs = [['Find', 30, C.navy], ['Read & qualify', 55, C.navy2], ['Documents', 40, C.tealDk], ['Annexures', 25, '2F6F9F'], ['Packet', 20, '7A93AE']];
    const BAR = 7600; const totalMin = 170;
    const todayCells = segs.map(([n, m, f]) => cell(P([R(n, { size: 14, bold: true, color: C.white })], { after: 0, align: AlignmentType.CENTER }), Math.round(BAR * m / totalMin), { fill: f, borders: BOX(C.white), v: VerticalAlign.CENTER, mt: 90, mb: 90, ml: 20, mr: 20 }));
    const used = todayCells.length;
    const widths = [1900, ...segs.map(([, m]) => Math.round(BAR * m / totalMin)), W - 1900 - segs.reduce((a, [, m]) => a + Math.round(BAR * m / totalMin), 0)];
    return table([
      [cell(P([R('Today', { size: 19, bold: true, color: C.ink })], { after: 0 }), 1900, { v: VerticalAlign.CENTER }), ...todayCells, cell(P([R('', { size: 14 })], { after: 0 }), widths[widths.length - 1])],
      [cell(P([R('With TenderPilot', { size: 19, bold: true, color: C.teal })], { after: 0 }), 1900, { v: VerticalAlign.CENTER }), cell(P([R('', { size: 14 })], { after: 0 }), widths[1], { fill: C.teal, borders: BOX(C.white), mt: 90, mb: 90 }), cell(P([R('~10 min of review', { size: 17, bold: true, color: C.teal })], { after: 0 }), W - 1900 - widths[1], { v: VerticalAlign.CENTER, span: used })],
    ], widths);
  })(),
  source('Bar length is proportional to minutes per bid (today ≈ 180 minutes).'),
  table([[
    ...[['~45 h', 'returned each month at 15 bids a month', 'ILLUSTRATIVE'], ['0', 'bids lost to expired documents or missed corrigenda', 'TARGET'], ['2×', 'bids your current team can pursue each month', 'TARGET'], ['Earlier', 'No-Go calls, so effort goes only to bids you can win', 'EXPECTED']].map(([n, d, tag]) =>
      cell([P([R(n, { font: SERIF, size: 32, bold: true, color: C.teal })], { after: 20 }), P([R(d, { size: 18 })], { after: 40, line: 240 }), P([R(tag, { size: 14, bold: true, color: C.grey, spacing: 40 })], { after: 0 })], 2438, { borders: { ...NONE, top: line(C.rule) }, mt: 100 })),
  ]], [2438, 2438, 2438, 2438]),
);

// 9 — roles
add(kicker('08', 'Built for every role'),
  title('Each person on the bid desk sees the part of the work they own, from the owner\'s phone to the analyst\'s checklist'),
  exhibit(12, 'Who uses TenderPilot, and for what'),
  table([
    [th('Role', 1700), th('What they see', 4200), th('The question it answers', 3852)],
    ...[['Owner / MD', 'Mobile dashboard: new matches, bids closing, EMD at stake, win rate, documents expiring', '"Are we bidding on the right things, and is anything about to slip?"'],
        ['Bid manager', 'Pipeline board from Identified to Won or Lost, with owners, due dates and packet readiness', '"Who is on which bid, and what is blocking it?"'],
        ['Bid analyst', 'Tender analysis, requirement checklist, annexures and the packet builder', '"Do we qualify, and what is still missing?"'],
        ['Compliance / accounts', 'Document vault, expiry timeline and the audit trail of who did what', '"Is every certificate valid on the closing date?"'],
        ['Viewer', 'Read-only access for partners, OEMs or auditors you invite', '"What was submitted, and on what basis?"']].map(([a, b, c], i) => [
      cell(P([R(a, { size: 19, bold: true, color: C.navy })], { after: 0 }), 1700, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) } }), cell(P([R(b, { size: 18 })], { after: 0, line: 244 }), 4200, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) } }), cell(P([R(c, { size: 18, italics: true, color: C.tealDk })], { after: 0, line: 244 }), 3852, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) } })]),
  ], [1700, 4200, 3852]),
  gap(120),
  table([[
    cell([img('pipeline.jpg', 440, { alt: 'Bid manager pipeline board', before: 0, after: 20 }), P([R('Exhibit 13: The bid manager\'s pipeline: every bid by stage, with score, closing time, EMD and packet readiness.', { size: 16, italics: true, color: C.grey })], { after: 0 })], 6700, {}),
    cell([img('m-dashboard.jpg', 150, { alt: 'Owner dashboard on mobile', before: 0, after: 20 }), P([R('Exhibit 14: The owner\'s dashboard', { size: 16, italics: true, color: C.grey })], { after: 0, align: AlignmentType.CENTER })], 3052, {}),
  ]], [6700, 3052]),
);

// 10 — trust
add(kicker('09', 'Trust, security and compliance'),
  title('Your data, your GeM account and your decisions stay yours: security is part of the design'),
  lead('Bid documents, financials and certificates are among the most sensitive files a company holds. TenderPilot treats them that way and keeps your GeM seller account out of reach.'),
  table([
    [['A separate space for each company', 'Every company\'s bids, documents and analyses are kept apart. No other customer can see or reach them.'], ['Role-based access', 'Owners, bid managers, analysts and viewers each see and do only what their role allows. You invite and remove people yourself.'], ['Complete audit trail', 'Every analysis, override, document change, packet and submission record shows who did it and when.']],
    [['Your data stays yours', 'You own everything you upload or create. Export it whenever you like, and have it deleted if you leave.'], ['No GeM credentials stored', 'TenderPilot reads public bid information only. It never asks for, stores or uses your GeM login.'], ['Enterprise-grade cloud', 'Hosted on enterprise-grade cloud infrastructure, with encrypted connections and continuous monitoring.']],
  ].map((row) => row.map(([t, d]) => cell([P([R(t, { font: SERIF, size: 22, bold: true, color: C.navy })], { after: 40 }), P([R(d, { size: 18 })], { after: 0, line: 250 })], 3250 , { borders: BOX(), fill: C.wash, mt: 110, mb: 110, ml: 130, mr: 130 }))), [3250, 3250, 3250]),
  gap(100),
  table([[
    cell([img('roles.jpg', 305, { alt: 'Team and roles settings', before: 0, after: 20 }), P([R('Exhibit 18: Four roles, with least access by default. Viewers suit compliance reviewers and promoters.', { size: 16, italics: true, color: C.grey })], { after: 0 })], 4876, {}),
    cell([img('activity.jpg', 305, { alt: 'Activity log', before: 0, after: 20 }), P([R('Exhibit 19: The activity log records who did what, and when, in IST.', { size: 16, italics: true, color: C.grey })], { after: 0 })], 4876, {}),
  ]], [4876, 4876]),
  gap(100),
  table([[cell([
    P([R('What TenderPilot never does', { font: SERIF, size: 26, bold: true, color: C.white })], { after: 30 }),
    P([R('These limits are fixed in the product. No setting or plan turns them off.', { size: 18, color: 'C9D3E0' })], { after: 100 }),
    table([[
      ...[['Ask for your password', 'Your GeM login stays with your team.'], ['Enter or suggest a price', 'Your financial bid is yours alone.'], ['Authenticate for you', 'No OTP, DSC or Aadhaar e-Sign.'], ['Solve a CAPTCHA', 'No bots on your seller account.'], ['Click Final Submit', 'A named person does that, every time.']].map(([t, d]) =>
        cell([P([R('✕ ', { size: 18, bold: true, color: 'FF8A94' }), R(t, { size: 17, bold: true, color: C.white })], { after: 20 }), P([R(d, { size: 15, color: 'C9D3E0' })], { after: 0, line: 230 })], 1790, { mt: 30, mb: 30, ml: 60, mr: 60 })),
    ]], [1790, 1790, 1790, 1790, 1792]),
  ], W, { fill: C.navy, ml: 180, mr: 180, mt: 150, mb: 130 })]], [W]),
);

// 11 — engagement
add(kicker('10', 'Engagement model'),
  title('Live in days, proven in a four-week pilot, then scaled on success metrics we agree at the start'),
  exhibit(15, 'From kick-off to full rollout'),
  table([[
    ...[['Onboard · days 1 to 5', 'Company profile, watchlists for each product line, upload certificates to the vault', C.navy], ['Pilot · weeks 1 to 4', 'Live bids and alerts; weekly review with your bid manager; tune watchlists and templates', C.tealDk], ['Rollout · month 2 onward', 'Whole team on board, WhatsApp digests, more categories, entities and regions', C.teal]].map(([t, d, fill]) =>
      cell([P([R(t, { size: 20, bold: true, color: C.white })], { after: 30 }), P([R(d, { size: 17, color: 'E6EDF5' })], { after: 0, line: 240 })], 3250, { fill, borders: BOX(C.white), mt: 120, mb: 120, ml: 140 })),
  ]], [3250, 3250, 3252]),
  exhibit(16, 'Success metrics we track together'),
  table([[th('Metric', 6300), th('Pilot target', 3452)], ...[['Time from GeM publication to alert', '< 1 hour'], ['Time to a Go/No-Go decision', 'same day'], ['Time to assemble a bid packet', '~10 min'], ['Relevant bids reviewed per week', 'vs. baseline'], ['Bids missed or lost on documents', 'zero'], ['Win rate on bids submitted', 'tracked']].map(([a, b], i) => [
    cell(P([R(a, { size: 18 })], { after: 0 }), 6300, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) }, mt: 60, mb: 60 }), cell(P([R(b, { size: 18, bold: true, color: C.teal })], { after: 0 }), 3452, { fill: i % 2 ? C.wash : undefined, borders: { ...NONE, bottom: line(C.rule) }, mt: 60, mb: 60 })])], [6300, 3452]),
  source('Baselines are measured in week 1 of the pilot. Targets are indicative.'),
  table([[
    ...[['A named bid owner', 'About 2 hours in week 1, then 30 minutes a week'], ['Company documents', 'Registrations, financials, experience and OEM letters'], ['Your product focus', 'Categories, states and value bands you want to win']].map(([t, d]) =>
      cell([P([R(t, { size: 19, bold: true, color: C.navy })], { after: 20 }), P([R(d, { size: 17 })], { after: 0, line: 240 })], 3250, { fill: C.tealWash, borders: BOX(C.white), mt: 90, mb: 90, ml: 130 })),
  ]], [3250, 3250, 3252]),
  exhibit(17, 'Indicative pricing, per company per month, excluding GST'),
  table([[
    ...[['Starter', '₹2,999 / month', 'For a founder-led MSME bidding a few times a month', ['3 team members, 5 watchlists', 'Email and in-app alerts', 'Go/No-Go scoring, vault, packet builder'], false],
        ['Pro · recommended', '₹7,999 / month', 'For growing teams bidding every week', ['10 members, unlimited watchlists', 'WhatsApp alerts and daily digest', 'Assisted bid reading, annexure templates', 'Form-fill assistant, pipeline and win-rate analytics'], true],
        ['Enterprise', 'Custom', 'For OEMs, distributors and consultants with many entities', ['Unlimited members and entities', 'Single sign-on and audit exports', 'Custom eligibility rules, success manager'], false]].map(([n, p, d, bl, feat]) =>
      cell([P([R(n, { size: 17, bold: true, color: feat ? C.tealDk : C.grey, spacing: 30, caps: true })], { after: 20 }), P([R(p, { font: SERIF, size: 30, bold: true, color: C.navy })], { after: 40 }), P([R(d, { size: 17, italics: true })], { after: 60, line: 236 }), ...bl.map((b) => bullet(b, { size: 17 }))], 3250, { borders: BOX(feat ? C.teal : C.rule), fill: feat ? C.tealWash : undefined, mt: 110, mb: 110, ml: 140 })),
  ]], [3250, 3250, 3252]),
  source('Indicative only; final commercials are agreed in the proposal. Every plan starts with a 14-day free trial of Pro.'),
);

// ───────── document ─────────
const footer = new Footer({ children: [new Paragraph({
  tabStops: [{ type: TabStopType.RIGHT, position: W }], border: { top: line(C.rule, 4) }, spacing: { before: 60, after: 0 },
  children: [R('TenderPilot  |  Inventis Labs  |  Confidential', { size: 16, color: C.grey }), new TextRun({ text: '\t', size: 16 }), new TextRun({ children: [PageNumber.CURRENT], font: SANS, size: 16, color: C.grey })],
})] });
const noFooter = new Footer({ children: [new Paragraph({ children: [], spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT } })] });
const fullPage = { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 } } };

const endPara = () => new Paragraph({ children: [new TextRun({ text: '', size: 2 })], spacing: { before: 0, after: 0, line: 20 } });

const doc = new Document({
  creator: 'Inventis Labs', title: 'TenderPilot: Concept note', description: 'TenderPilot concept note by Inventis Labs',
  styles: { default: { document: { run: { font: SANS, size: 21, color: C.body } } } },
  numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 300, hanging: 220 } }, run: { color: C.teal } } }] }] },
  sections: [
    { properties: fullPage, footers: { default: noFooter }, children: [...cover, endPara()] },
    { properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: 1000, bottom: 900, left: 1077, right: 1077, header: 400, footer: 450 } } }, footers: { default: footer }, children: body },
    { properties: fullPage, footers: { default: noFooter }, children: [...back, endPara()] },
  ],
});

// fix cover/back row heights (exact) after construction by patching XML-friendly options is not possible in docx-js; sizes are controlled by content.
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log('wrote', OUT, buf.length); });
