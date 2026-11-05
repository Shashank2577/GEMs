/**
 * Extension E2E helper (006 T003 / #195): load the unpacked `apps/extension/dist` into Playwright's Chromium,
 * serve the GeM-like fixture form on http://localhost:<port>/gem-form.html and open the popup page.
 *
 *   const ext = await launchWithExtension();
 *   await ext.popup.fill('#token', 'tp_…');            // popup is a normal Playwright Page
 *   await ext.page.locator('#make');                    // the fixture page (content script injected)
 *   await ext.close();
 *
 * Notes:
 *  - Extensions need a persistent context; headless works with `channel: 'chromium'` (new headless).
 *  - The popup is opened as a normal tab, so `chrome.tabs.query({active:true,currentWindow:true})` inside it
 *    returns the popup itself. Use `ext.activate(ext.page)` before clicking Highlight/Fill so the fixture tab
 *    is the one the popup targets; or call `ext.sendToPage(msg)` to message the content script directly.
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION_DIR = join(ROOT, 'apps', 'extension');
export const EXTENSION_DIST = join(EXTENSION_DIR, 'dist');
export const FIXTURE_HTML = join(EXTENSION_DIR, 'test', 'fixtures', 'gem-form.html');

let built = false;
/** Build `apps/extension/dist` once per process (skips when `dist/manifest.json` exists and EXT_REBUILD is unset). */
export function buildExtension(force = process.env.EXT_REBUILD === '1') {
  if (built) return;
  if (force || !existsSync(join(EXTENSION_DIST, 'manifest.json')) || !existsSync(join(EXTENSION_DIST, 'content.js'))) {
    execFileSync('pnpm', ['--filter', '@tp/extension', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
  built = true;
}

/** Unpacked extension id: Chromium derives it from the absolute path (sha256, first 32 hex chars mapped to a-p). */
export function extensionIdFor(path = EXTENSION_DIST) {
  return [...createHash('sha256').update(path).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export interface ExtensionHarness {
  context: BrowserContext;
  extensionId: string;
  /** The GeM-like fixture page (content script injected). */
  page: Page;
  /** `chrome-extension://<id>/popup.html` */
  popup: Page;
  fixtureUrl: string;
  /** Bring a tab to the front (the popup targets the *active* tab of the window). */
  activate(p: Page): Promise<void>;
  /** Send a message to the content script of the fixture page (first non-extension tab) from the popup page (sender.id = extension id). */
  sendToPage(msg: unknown): Promise<any>;
  /** Open another page of the fixture server (e.g. a non-GeM page for the "Open the GeM bid page" message). */
  open(path?: string): Promise<Page>;
  close(): Promise<void>;
}

/** Pre-seed popup settings (apiBase + token) in `chrome.storage.local`, bypassing the host-permission prompt. */
export async function seedSettings(popup: Page, settings: { apiBase?: string; token?: string; workspaceId?: string }) {
  await popup.evaluate((s) => chrome.storage.local.set(s), settings);
}

export async function launchWithExtension(opts: { fixture?: string; videoDir?: string; extraArgs?: string[] } = {}): Promise<ExtensionHarness> {
  buildExtension();
  const html = readFileSync(opts.fixture ?? FIXTURE_HTML);
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/never-submitted')) { res.statusCode = 400; res.end('form must never be submitted'); return; }
    res.setHeader('content-type', 'text/html'); res.end(html);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  // The manifest matches http://localhost/*gem-form* and http://127.0.0.1/*gem-form* (any port).
  const fixtureUrl = `http://localhost:${port}/gem-form.html`;

  const context = await chromium.launchPersistentContext('', {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`, ...(opts.extraArgs ?? [])],
    ...(opts.videoDir ? { recordVideo: { dir: opts.videoDir, size: { width: 1280, height: 900 } } } : {}),
  });
  for (const p of context.pages()) await p.close();
  const extensionId = extensionIdFor();
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const activate = async (p: Page) => { await p.bringToFront(); };
  return {
    context, extensionId, page, popup, fixtureUrl, activate,
    async sendToPage(msg) {
      return popup.evaluate(async (m) => {
        const tabs = await chrome.tabs.query({});
        // tab.url is hidden without host access, so pick the first non-extension tab (the fixture page).
        const tab = tabs.find((t) => !(t.url ?? '').startsWith('chrome-extension'));
        if (!tab?.id) throw new Error('fixture tab not found');
        return chrome.tabs.sendMessage(tab.id, m);
      }, msg);
    },
    async open(path = '/gem-form.html') {
      const p = await context.newPage();
      await p.goto(`http://localhost:${port}${path}`);
      return p;
    },
    async close() { await context.close(); server.close(); },
  };
}
