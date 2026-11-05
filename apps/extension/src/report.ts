/** Popup fill report: what was filled and what was skipped (and why) — 006/FR-075. DOM-only, no network. */
import type { FillReport } from './fill';

export function renderFillReport(root: HTMLElement, report: FillReport): void {
  root.replaceChildren();
  root.hidden = false;
  const h = document.createElement('h3');
  h.textContent = 'Fill report';
  root.append(h);

  const section = (title: string, rows: { label: string; detail: string }[], cls: string) => {
    const t = document.createElement('p');
    t.className = 'report-title';
    t.textContent = `${title} (${rows.length})`;
    const ul = document.createElement('ul');
    ul.className = `report-list ${cls}`;
    for (const r of rows) {
      const li = document.createElement('li');
      const k = document.createElement('b'); k.textContent = r.label;
      const v = document.createElement('span'); v.textContent = r.detail;
      li.append(k, v);
      ul.append(li);
    }
    root.append(t);
    if (rows.length) root.append(ul);
  };

  section('Filled', report.filled.map((f) => ({ label: f.label, detail: f.value })), 'filled');
  section('Skipped', report.skipped.map((s) => ({ label: s.label ?? s.key ?? 'Field', detail: s.reason })), 'skipped');
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = `${report.forbidden} protected field(s) untouched (price, CAPTCHA, OTP, DSC, submit) — you do those on GeM. Please verify every filled value.`;
  root.append(note);
}

export function clearFillReport(root: HTMLElement): void {
  root.replaceChildren();
  root.hidden = true;
}
