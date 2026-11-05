/// <reference types="chrome" />
/** Popup: connect with an API token, pick a bid workspace, view/copy values, and ask the page to highlight/fill. */
import { ApiError, api, ensureHostPermission, loadSettings, normalizeBase, saveSettings, type Settings } from './api';
import type { PayloadField } from './fill';
import { clearFillReport, renderFillReport } from './report';
import type { ContentRequest, ContentResponse } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let settings: Settings;
let fields: PayloadField[] = [];

function showError(msg: string | null) {
  const el = $('error');
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

function setStatus(msg: string, ok = false) {
  const el = $('page-status');
  el.textContent = msg;
  el.classList.toggle('ok', ok);
}

function showSettings(show: boolean) {
  $('settings').hidden = !show;
  $('main').hidden = show;
}

async function sendToPage(msg: ContentRequest): Promise<ContentResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    throw new Error('Open the GeM bid participation page in this tab first (bidplus.gem.gov.in), then try again.');
  }
}

function renderFields() {
  const ul = $('fields');
  ul.replaceChildren();
  for (const f of fields) {
    const li = document.createElement('li');
    const k = document.createElement('span'); k.className = 'k'; k.textContent = f.label;
    const v = document.createElement('span'); v.className = `v${f.value ? '' : ' empty'}`; v.textContent = f.value || 'Not set — add it in the workspace';
    const b = document.createElement('button'); b.className = 'copy'; b.textContent = 'Copy'; b.disabled = !f.value;
    b.setAttribute('aria-label', `Copy ${f.label}`);
    b.addEventListener('click', async () => { await navigator.clipboard.writeText(f.value); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); });
    li.append(k, b, v);
    ul.append(li);
  }
}

async function loadWorkspace(id: string) {
  showError(null);
  const p = await api.assist(settings, id);
  fields = p.fields.map((f) => ({ key: f.key, label: f.label, value: f.value, selectorHints: f.selectorHints }));
  renderFields();
  $('ws-meta').innerHTML = '';
  const meta = $('ws-meta');
  const mk = (label: string, value: string) => { const s = document.createElement('span'); s.innerHTML = `${label} <b></b>`; s.querySelector('b')!.textContent = value; meta.append(s); };
  mk('Bid', p.tender.bidNumber);
  mk('Readiness', p.readiness.analysed ? `${p.readiness.percent}%` : 'Not analysed'); // 006/FR-009
  const open = document.createElement('a'); open.href = p.workspaceUrl; open.target = '_blank'; open.textContent = 'Open workspace ↗'; meta.append(open);
  const docs = $('docs'); docs.replaceChildren();
  for (const d of p.documents) {
    const li = document.createElement('li');
    const a = document.createElement('a'); a.href = d.url; a.target = '_blank'; a.textContent = d.title;
    const small = document.createElement('small'); small.textContent = `${d.fileName}${d.pages ? ` · ${d.pages} page${d.pages === 1 ? '' : 's'}` : ''}`;
    const wrap = document.createElement('div'); wrap.append(a, small); li.append(wrap); docs.append(li);
  }
  if (!p.documents.length) docs.innerHTML = '<li><span class="muted">Build the packet in the workspace first.</span></li>';
  const steps = $('steps'); steps.replaceChildren();
  for (const s of p.humanSteps) {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = s.title;
    const sp = document.createElement('span'); sp.textContent = s.detail;
    li.append(b, sp); steps.append(li);
  }
}

async function loadWorkspaces() {
  const sel = $<HTMLSelectElement>('workspace');
  const { items } = await api.workspaces(settings);
  sel.replaceChildren();
  if (!items.length) {
    const o = document.createElement('option'); o.textContent = 'No active bids — start one in TenderPilot'; o.value = ''; sel.append(o);
    return;
  }
  for (const w of items) {
    const o = document.createElement('option');
    o.value = w.id;
    o.textContent = `${w.tender.bidNumber} — ${w.tender.title.slice(0, 48)}`;
    sel.append(o);
  }
  const chosen = items.find((w) => w.id === settings.workspaceId)?.id ?? items[0].id;
  sel.value = chosen;
  await loadWorkspace(chosen);
}

async function init() {
  settings = await loadSettings();
  $<HTMLInputElement>('api-base').value = settings.apiBase;
  $<HTMLInputElement>('token').value = settings.token;
  $('settings-btn').addEventListener('click', () => showSettings($('settings').hidden));
  $('save').addEventListener('click', async () => {
    const apiBase = normalizeBase($<HTMLInputElement>('api-base').value);
    const token = $<HTMLInputElement>('token').value.trim();
    if (!/^https?:\/\//.test(apiBase)) { $('settings-status').textContent = 'Enter the full URL, e.g. https://app.tenderpilot.in'; return; }
    if (!token.startsWith('tp_')) { $('settings-status').textContent = 'API tokens start with tp_'; return; }
    if (!(await ensureHostPermission(apiBase))) { $('settings-status').textContent = 'Permission to reach that URL was not granted.'; return; }
    settings = { ...settings, apiBase, token };
    try {
      const me = await api.me(settings);
      await saveSettings({ apiBase, token });
      $('settings-status').textContent = `Connected as ${me.user.name} (${me.org.name})`;
      showSettings(false);
      await loadWorkspaces();
    } catch (e) {
      $('settings-status').textContent = (e as Error).message;
    }
  });
  $<HTMLSelectElement>('workspace').addEventListener('change', async (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (!id) return;
    await saveSettings({ workspaceId: id });
    settings.workspaceId = id;
    try { await loadWorkspace(id); } catch (err) { showError((err as Error).message); }
  });
  $('scan').addEventListener('click', async () => {
    try {
      const r = await sendToPage({ type: 'tp:scan', fields });
      if (!r.ok) throw new Error(r.error);
      if ('scan' in r) setStatus(`${r.scan.fillable} field(s) can be filled — click the TP chips or “Fill allowed fields”. ${r.scan.forbidden} price/OTP/submit field(s) left for you${r.scan.manual ? `; ${r.scan.manual} yes/no question(s) to answer yourself` : ''}.`);
    } catch (e) { showError((e as Error).message); }
  });
  $('fill').addEventListener('click', async () => {
    try {
      const r = await sendToPage({ type: 'tp:fill', fields });
      if (!r.ok) throw new Error(r.error);
      if ('report' in r) {
        const manual = r.report.skipped.filter((x) => x.reason.startsWith('left for you')).length;
        setStatus(`Filled ${r.report.filled.length} field(s), skipped ${r.report.skipped.length}${manual ? ` (${manual} for you to choose)` : ''}. ${r.report.forbidden} protected field(s) untouched — enter price and authenticate yourself.`, true);
        renderFillReport($('fill-report'), r.report);
      }
    } catch (e) { showError((e as Error).message); }
  });

  $('clear').addEventListener('click', async () => {
    try {
      const r = await sendToPage({ type: 'tp:clear' });
      if (!r.ok) throw new Error(r.error);
      showError(null);
      clearFillReport($('fill-report'));
      setStatus('Highlights cleared. Values already filled stay in the form.');
    } catch (e) { showError((e as Error).message); }
  });

  if (!settings.token) { showSettings(true); return; }
  showSettings(false);
  try {
    await loadWorkspaces();
  } catch (e) {
    showError((e as Error).message);
    if (e instanceof ApiError && (e.status === 401 || e.status === 0)) showSettings(true);
  }
}

void init();
