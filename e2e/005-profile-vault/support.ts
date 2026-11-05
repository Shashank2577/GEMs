import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { uniqueUser } from '../support/fixtures';

export type Role = 'viewer' | 'analyst' | 'bid_manager';

/**
 * Invite a second user into the SAME org as `owner` (POST /api/org/invitations, owner session) and accept the
 * invitation in a fresh browser context. Returns that context (authenticated) so tests can drive its page/request.
 */
export async function joinOrgAs(browser: Browser, ownerPage: Page, role: Role, baseURL: string): Promise<{ ctx: BrowserContext; email: string }> {
  const u = uniqueUser(role);
  const inv = await ownerPage.request.post('/api/org/invitations', { data: { email: u.email, role } });
  expect(inv.status(), await inv.text()).toBe(201);
  const { inviteUrl } = (await inv.json()) as { inviteUrl: string };
  const token = inviteUrl.split('/invite/')[1]!;
  const ctx = await browser.newContext({ baseURL, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const acc = await ctx.request.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
  expect(acc.ok(), await acc.text()).toBeTruthy();
  return { ctx, email: u.email };
}

export const VALID_GSTIN = '27AAPFU0939F1ZV';
export const VALID_PAN = 'AAPFU0939F';
