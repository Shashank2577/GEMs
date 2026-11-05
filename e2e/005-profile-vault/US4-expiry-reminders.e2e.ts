/**
 * 005 / US4 (#117) — Know what is expiring and get reminded 30, 7 and 1 day before. Spec FR-042..FR-053, tasks T054.
 * Evidence: qa/evidence/005/US4/. The real clock is used; "N days later" is simulated by shifting the document's
 * expiry date in the DB (equivalent for reminder logic), which is noted in VERDICT.md.
 */
import { request as pwRequest } from '@playwright/test';
import { test, expect, signupViaApi, seedDemo, evidence, collectRunArtifacts, uniqueUser } from '../support/fixtures';
import {
  BASE_URL, addMember, fmtIST, inAppNotifs, istDate, lastReminderDays, notificationsForDoc, pageFor, runReminders, setLastReminderDays,
  setPrefs, shiftExpiry, uploadDoc,
} from './support';

const SPEC = '005', STORY = 'US4';
const ev = (page: import('@playwright/test').Page, name: string) => evidence(page, SPEC, STORY, name);
const sfx = () => Math.random().toString(36).slice(2, 7);

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test.describe('US4 expiry & reminders', () => {
  test('AC1 badges: +45/+30/+10/0/-1 and no expiry', async ({ page }) => {
    await signupViaApi(page);
    const s = sfx();
    const cases = [
      { off: 45, label: 'Valid', status: 'valid' }, { off: 30, label: 'Expires in 30d', status: 'expiring' },
      { off: 10, label: 'Expires in 10d', status: 'expiring' }, { off: 0, label: 'Expires today', status: 'expiring' },
      { off: -1, label: 'Expired 1d ago', status: 'expired' },
    ];
    const docs: { title: string; label: string; status: string; id: string }[] = [];
    for (const c of cases) {
      const title = `Doc ${c.off} ${s}`;
      const d = await uploadDoc(page.request, { title, expiryDate: istDate(c.off) });
      expect(d.status, title).toBe(c.status);
      docs.push({ title, label: c.label, status: c.status, id: d.id });
    }
    const none = await uploadDoc(page.request, { title: `Doc none ${s}`, type: 'other' });
    expect(none.status).toBe('valid');
    await page.goto('/vault');
    await page.getByRole('button', { name: `Open Doc none ${s}` }).waitFor();
    for (const d of docs) {
      const card = page.getByRole('button', { name: `Open ${d.title}` }).locator('xpath=..');
      await expect(card.getByText(d.label, { exact: true }), d.title).toBeVisible();
    }
    await expect(page.getByRole('button', { name: `Open Doc none ${s}` }).locator('xpath=..').getByText('No expiry', { exact: true })).toBeVisible();
    await ev(page, 'ac1-badges-desktop');
  });

  test('AC2/AC3 reminders for 4 roles: exact notifications, titles, body, link, last_reminder_days=30; re-run idempotent', async ({ page, browser }) => {
    const owner = await signupViaApi(page);
    const bm = await addMember(page.request, 'bid_manager', 'bm');
    const analyst = await addMember(page.request, 'analyst', 'an');
    const viewer = await addMember(page.request, 'viewer', 'vw');
    await setPrefs(analyst.request, { email: false });
    await setPrefs(viewer.request, { expiryReminders: false });

    const title = `ISO 9001 ${sfx()}`;
    const exp = istDate(10);
    const doc = await uploadDoc(page.request, { type: 'iso', title, expiryDate: exp });
    const run = await runReminders(page.request);
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ documents: 1, notifications: 5 });

    const rows = notificationsForDoc(doc.id);
    expect(rows).toHaveLength(5);
    const byUser = (email: string) => rows.filter((r) => r.email === email);
    const expectedBody = `Your ISO certificate "${title}" expires in 10 days (on ${exp}). Renew it and upload the new copy to the vault so your bids stay compliant.`;
    for (const email of [owner.email, bm.email]) {
      const r = byUser(email);
      expect(r.map((x) => `${x.channel}:${x.status}`).sort(), email).toEqual(['email:pending', 'in_app:sent']);
      expect(r.find((x) => x.channel === 'in_app')!.title).toBe(`${title} expires in 10 days`);
      expect(r.find((x) => x.channel === 'email')!.title).toBe(`[${owner.orgName}] ${title} expires in 10 days`);
      for (const x of r) { expect(x.body).toBe(expectedBody); expect(x.link).toBe(`/vault?doc=${doc.id}`); expect(x.dedupeKey).toBe(`expiry:${doc.id}:${exp}:30`); }
    }
    expect(byUser(analyst.email).map((x) => `${x.channel}:${x.status}`)).toEqual(['in_app:sent']);
    expect(byUser(viewer.email)).toHaveLength(0);
    expect(lastReminderDays(doc.id)).toBe(30);

    // API view of the bell for each role
    const ownerN = (await inAppNotifs(page.request)).filter((n) => n.kind === 'expiry');
    expect(ownerN.map((n) => n.title)).toEqual([`${title} expires in 10 days`]);
    expect(ownerN[0].link).toBe(`/vault?doc=${doc.id}`);
    expect((await inAppNotifs(viewer.request)).filter((n) => n.kind === 'expiry')).toHaveLength(0);
    expect((await inAppNotifs(analyst.request)).filter((n) => n.kind === 'expiry')).toHaveLength(1);

    // AC3 idempotent
    expect((await runReminders(page.request)).body).toEqual({ documents: 0, notifications: 0 });
    expect(notificationsForDoc(doc.id)).toHaveLength(5);

    // Viewer UI: bell has no reminder
    const v = await pageFor(browser, viewer.request);
    await v.page.goto('/notifications');
    await expect(v.page.getByText(`${title} expires in 10 days`)).toHaveCount(0);
    await ev(v.page, 'ac2-viewer-reminders-off-no-notification');
    await v.context.close();

    // Owner UI: bell title
    await page.goto('/vault');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.getByRole('list', { name: 'Latest notifications' }).getByText(`${title} expires in 10 days`)).toBeVisible();
    await ev(page, 'ac2-owner-bell-title');
  });

  test('AC4 7-day reminder 4 days later; doc with 5 days left gets only the 7-day reminder', async ({ page }) => {
    await signupViaApi(page);
    const t1 = `Later ${sfx()}`;
    const d1 = await uploadDoc(page.request, { title: t1, expiryDate: istDate(10) });
    expect((await runReminders(page.request)).body).toEqual({ documents: 1, notifications: 2 });
    expect(lastReminderDays(d1.id)).toBe(30);
    shiftExpiry(d1.id, -4); // simulate 4 days passing: 6 days left
    expect((await runReminders(page.request)).body).toEqual({ documents: 1, notifications: 2 });
    expect(lastReminderDays(d1.id)).toBe(7);
    const titles = (await inAppNotifs(page.request)).map((n) => n.title);
    expect(titles).toContain(`${t1} expires in 6 days`);
    expect(titles.filter((x) => x.startsWith(t1))).toHaveLength(2); // 30-day and 7-day, once each
    expect((await runReminders(page.request)).body).toEqual({ documents: 0, notifications: 0 });

    const t2 = `Late upload ${sfx()}`;
    const d2 = await uploadDoc(page.request, { title: t2, expiryDate: istDate(5) });
    expect((await runReminders(page.request)).body).toEqual({ documents: 1, notifications: 2 });
    expect(lastReminderDays(d2.id)).toBe(7);
    const keys = notificationsForDoc(d2.id).map((n) => n.dedupeKey);
    expect(new Set(keys)).toEqual(new Set([`expiry:${d2.id}:${istDate(5)}:7`]));
    expect((await inAppNotifs(page.request)).map((n) => n.title)).toContain(`${t2} expires in 5 days`);
    await page.goto('/notifications');
    await expect(page.getByText(`${t2} expires in 5 days`).first()).toBeVisible();
    await ev(page, 'ac4-seven-day-reminders');
  });

  test('AC5 expired yesterday -> one has-expired reminder; expired >30 days -> none', async ({ page }) => {
    const user = await signupViaApi(page);
    const t1 = `Gone ${sfx()}`;
    const d1 = await uploadDoc(page.request, { type: 'iso', title: t1, expiryDate: istDate(-1) });
    setLastReminderDays(d1.id, 1);
    const t2 = `Long gone ${sfx()}`;
    const d2 = await uploadDoc(page.request, { type: 'iso', title: t2, expiryDate: istDate(-31) });
    expect((await runReminders(page.request)).body).toEqual({ documents: 1, notifications: 2 });
    const rows = notificationsForDoc(d1.id);
    expect(rows).toHaveLength(2);
    const inapp = rows.find((r) => r.channel === 'in_app')!;
    expect(inapp.title).toBe(`${t1} has expired`);
    expect(inapp.body).toBe(`Your ISO certificate "${t1}" expired 1 day ago. Bids that need it will be blocked from "Ready to submit" until you upload the renewed copy.`);
    expect(rows.find((r) => r.channel === 'email')!.title).toBe(`[${user.orgName}] ${t1} has expired`);
    expect(lastReminderDays(d1.id)).toBe(0);
    expect(notificationsForDoc(d2.id)).toHaveLength(0);
    expect(lastReminderDays(d2.id)).toBeNull();
    expect((await runReminders(page.request)).body).toEqual({ documents: 0, notifications: 0 });
    await page.goto('/notifications');
    await expect(page.getByText(`${t1} has expired`).first()).toBeVisible();
    await ev(page, 'ac5-expired-reminder');
  });

  test('AC6 editing the expiry restarts the cycle with a new dedupe key', async ({ page }) => {
    await signupViaApi(page);
    const t = `Renewed ${sfx()}`;
    const d = await uploadDoc(page.request, { title: t, expiryDate: istDate(10) });
    await runReminders(page.request);
    expect(lastReminderDays(d.id)).toBe(30);
    // Edit via the UI drawer
    await page.goto(`/vault?doc=${d.id}`);
    await page.getByRole('button', { name: /Edit details/ }).click();
    const newExp = istDate(20);
    await page.getByLabel(/expiry date/i).fill(newExp);
    await ev(page, 'ac6-edit-expiry-form');
    await page.getByRole('button', { name: /Save changes/ }).click();
    await expect.poll(() => lastReminderDays(d.id)).toBeNull();
    expect((await runReminders(page.request)).body).toEqual({ documents: 1, notifications: 2 });
    expect(lastReminderDays(d.id)).toBe(30);
    const keys = new Set(notificationsForDoc(d.id).map((n) => n.dedupeKey));
    expect(keys).toEqual(new Set([`expiry:${d.id}:${istDate(10)}:30`, `expiry:${d.id}:${newExp}:30`]));
    expect((await inAppNotifs(page.request)).map((n) => n.title)).toContain(`${t} expires in 20 days`);
  });

  test('AC7 bell reminder opens the drawer even when the doc is filtered out @mobile', async ({ page }, testInfo) => {
    await signupViaApi(page);
    const t = `Filtered ${sfx()}`;
    const d = await uploadDoc(page.request, { title: t, expiryDate: istDate(10) });
    await uploadDoc(page.request, { type: 'other', title: `Old ${sfx()}`, expiryDate: istDate(-3) });
    await runReminders(page.request);
    await page.goto('/vault?status=expired');
    await expect(page.getByRole('button', { name: `Open ${t}` })).toHaveCount(0); // filtered out of the list
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page.getByRole('list', { name: 'Latest notifications' }).getByText(`${t} expires in 10 days`).click();
    await expect(page).toHaveURL(new RegExp(`/vault\\?.*doc=${d.id}`));
    await expect(page.getByRole('dialog').getByText(t).first()).toBeVisible();
    await ev(page, `ac7-bell-opens-drawer-${testInfo.project.name}`);
  });

  test('AC8 dashboard expiring-documents tile = 3 for the demo org and links to the vault', async ({ page }) => {
    await signupViaApi(page);
    await seedDemo(page.request);
    await page.goto('/dashboard');
    const tile = page.getByRole('link', { name: /Docs expiring/ });
    await expect(tile).toContainText('3');
    await ev(page, 'ac8-dashboard-tile');
    await tile.click();
    await expect(page).toHaveURL(/\/vault/);
    await ev(page, 'ac8-tile-links-to-vault');
  });

  test('AC9 Send reminders now: menu, toasts, idempotent, org-scoped; Analyst/Viewer 403 and no menu @mobile', async ({ page, browser }, testInfo) => {
    await signupViaApi(page);
    const bm = await addMember(page.request, 'bid_manager', 'bm');
    const analyst = await addMember(page.request, 'analyst', 'an');
    const viewer = await addMember(page.request, 'viewer', 'vw');
    const mobile = testInfo.project.name === 'mobile';

    // Another org's expiring doc must not be touched by this org's run (FR-051/052)
    const other = await pwRequest.newContext({ baseURL: BASE_URL });
    expect((await other.post('/api/auth/signup', { data: uniqueUser('other') })).status()).toBe(201);
    const foreign = await uploadDoc(other, { title: `Foreign ${sfx()}`, expiryDate: istDate(10) });

    // No reminders due yet -> "No reminders due"
    await page.goto('/vault');
    await page.getByRole('button', { name: 'More vault actions' }).click();
    await page.getByRole('menuitem', { name: 'Send reminders now' }).click();
    await expect(page.getByText('No reminders due')).toBeVisible();
    await ev(page, `ac9-toast-no-reminders-due-${testInfo.project.name}`);

    const a = await uploadDoc(page.request, { title: `Due A ${sfx()}`, expiryDate: istDate(10) });
    await page.reload();
    await page.getByRole('button', { name: 'More vault actions' }).click();
    await ev(page, `ac9-menu-open-${testInfo.project.name}`);
    await page.getByRole('menuitem', { name: 'Send reminders now' }).click();
    await expect(page.getByText('Reminders sent for 1 document', { exact: true })).toBeVisible();
    await ev(page, `ac9-toast-singular-${testInfo.project.name}`);

    // Pluralised toast
    await uploadDoc(page.request, { title: `Due B ${sfx()}`, expiryDate: istDate(5) });
    await uploadDoc(page.request, { title: `Due C ${sfx()}`, expiryDate: istDate(-1) });
    await page.reload();
    await page.getByRole('button', { name: 'More vault actions' }).click();
    await page.getByRole('menuitem', { name: 'Send reminders now' }).click();
    await expect(page.getByText('Reminders sent for 2 documents', { exact: true })).toBeVisible();
    await ev(page, `ac9-toast-plural-${testInfo.project.name}`);

    // Idempotent
    await page.getByRole('button', { name: 'More vault actions' }).click();
    await page.getByRole('menuitem', { name: 'Send reminders now' }).click();
    await expect(page.getByText('No reminders due').last()).toBeVisible();
    expect(notificationsForDoc(a.id)).toHaveLength(8); // 4 members x (in-app + email)
    expect(notificationsForDoc(foreign.id)).toHaveLength(0);
    expect(lastReminderDays(foreign.id)).toBeNull();

    // API contract and roles
    const bmRun = await runReminders(bm.request);
    expect(bmRun.status).toBe(200);
    expect(bmRun.body).toEqual({ documents: 0, notifications: 0 });
    expect((await runReminders(analyst.request)).status).toBe(403);
    expect((await runReminders(viewer.request)).status).toBe(403);

    // Menu visibility by role
    for (const [m, shown] of [[bm, true], [analyst, false], [viewer, false]] as const) {
      const p = await pageFor(browser, m.request, { mobile });
      await p.page.goto('/vault');
      await expect(p.page.getByRole('heading', { name: 'Document vault' })).toBeVisible();
      await expect(p.page.getByRole('button', { name: 'More vault actions' })).toHaveCount(shown ? 1 : 0);
      await ev(p.page, `ac9-menu-${m.role}-${shown ? 'visible' : 'hidden'}-${testInfo.project.name}`);
      await p.context.close();
    }
    await other.dispose();
  });

  test('AC10 drawer next-reminder line on valid, expiring and expired documents', async ({ page }) => {
    await signupViaApi(page);
    const s = sfx();
    const valid = await uploadDoc(page.request, { title: `Valid ${s}`, expiryDate: istDate(45) });
    const expiring = await uploadDoc(page.request, { title: `Expiring ${s}`, expiryDate: istDate(10) });
    const expired = await uploadDoc(page.request, { title: `Expired ${s}`, expiryDate: istDate(-1) });
    const line = (p: typeof page) => p.getByTestId('next-reminder');

    await page.goto(`/vault?doc=${valid.id}`);
    await expect(line(page)).toHaveText(`Next reminder: 30 days before expiry (${fmtIST(istDate(15))})`);
    await ev(page, 'ac10-drawer-valid');

    await page.goto(`/vault?doc=${expiring.id}`);
    await expect(line(page)).toHaveText(`Next reminder: 30 days before expiry (${fmtIST(istDate(0))})`); // due now
    await ev(page, 'ac10-drawer-expiring-due-now');

    await page.goto(`/vault?doc=${expired.id}`);
    await expect(line(page)).toHaveText(`Next reminder: expiry notice (${fmtIST(istDate(0))})`);
    await ev(page, 'ac10-drawer-expired-due-now');

    await runReminders(page.request);
    await page.goto(`/vault?doc=${expiring.id}`);
    await expect(line(page)).toHaveText(`Next reminder: 7 days before expiry (${fmtIST(istDate(3))})`);
    await ev(page, 'ac10-drawer-expiring-after-30-sent');
    await page.goto(`/vault?doc=${expired.id}`);
    await expect(line(page)).toHaveText('All reminders sent');
    await ev(page, 'ac10-drawer-expired-all-sent');

    // Pending expiry notice for a not-yet-expired doc whose 1-day reminder went out
    const d1 = await uploadDoc(page.request, { title: `OneDay ${s}`, expiryDate: istDate(1) });
    await runReminders(page.request);
    expect(lastReminderDays(d1.id)).toBe(1);
    await page.goto(`/vault?doc=${d1.id}`);
    await expect(line(page)).toHaveText(`Next reminder: expiry notice (${fmtIST(istDate(2))})`);
    await ev(page, 'ac10-drawer-expiry-notice-day-after');
  });
});
