# ADR-0005: Authentication — hashed opaque sessions, PBKDF2 passwords, and the hardening required before launch

**Status**: Accepted (existing model) · Proposed (hardening already specified in spec 002 + security headers + custom domain)
**Date**: 2026-11-05
**Priority**: MUST (rate limit, password reset, Origin check, security headers, custom domain) · SHOULD (session list, token expiry)

## Context

`apps/api/src/lib/{session,crypto}.ts`, `routes/auth.ts`:

- Session: 256-bit random token, only `sha256` stored (`sessions.token_hash`, unique), cookie `tp_session`
  HttpOnly, SameSite=Lax, Secure on https (via `x-forwarded-proto`), 30-day sliding expiry.
- Passwords: PBKDF2-SHA256, 100,000 iterations (the Workers WebCrypto cap), NFKC, constant-time compare, dummy
  hash on unknown email. Changing a password deletes other sessions.
- API tokens: `tp_` + 256-bit, hashed, per (org, user), role = user's current role, `last_used_at` throttled.
- Invitations: hashed tokens, 7-day expiry, single use.

Verified gaps (all already captured as requirements in `specs/002-platform-tenancy/spec.md`):
no rate limiting on `/auth/login`, `/auth/signup`, `/auth/accept-invite`, `/me/password` (FR-010) — each attempt
costs ~100k PBKDF2 iterations of Worker CPU, so credential stuffing is also a cost attack; no password reset
(FR-011) — a support ticket per forgotten password; no Origin check on cookie-authenticated mutations (FR-028);
no security headers (FR-050); no session listing/revocation (FR-012); API tokens never expire (FR-037).
Additionally: production runs on `*.workers.dev`, which prevents HSTS preload, WAF rules and a trustworthy cookie
domain.

## Decision

Keep the model (no JWTs, no third-party auth provider yet). Before the first paying customer:

1. Implement spec 002 FR-010 (Postgres-backed limiter — see ADR-0014 for the shared helper), FR-011 (password
   reset with hashed one-time token, 60-min TTL, email via `deps.mailer`), FR-028 (Origin check middleware in
   `middleware/request.ts`: for cookie auth and method not in GET/HEAD/OPTIONS, `Origin` must equal
   `config.appUrl` origin, else 403 `bad_origin`; bearer requests exempt).
2. Security headers for the SPA via Workers static assets `_headers` file at `apps/web/public/_headers`
   (copied into `dist` by Vite):
   ```
   /*
     Strict-Transport-Security: max-age=31536000; includeSubDomains
     X-Content-Type-Options: nosniff
     X-Frame-Options: DENY
     Referrer-Policy: strict-origin-when-cross-origin
     Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
   ```
   and the same set for `/api/*` responses in `middleware/request.ts` (`noStore` already exists; extend it).
3. Custom domain (`app.tenderpilot.in` or similar) bound to the Worker; `APP_URL` updated; cookie `Secure` becomes
   unconditional in production.
4. SHOULD: FR-012 session management and FR-037 token expiry (90-day default) — ordinary feature work.

## Consequences

- Login-path CPU is capped by the limiter; account takeover via stuffing is no longer cheap.
- Password reset removes the single biggest predictable support cost.
- CSP must be re-validated when the SPA adds an external script/CDN (none today; `vite build` inlines assets).
- No change to the extension: bearer tokens are exempt from the Origin check and CSP does not apply to it.

## Acceptance

- API tests: 11th failed login for an email within 15 min → 429 with `Retry-After`; successful login resets.
- `POST /auth/forgot-password` → 200 always; reset link works once; all other sessions deleted.
- Cookie-authenticated `POST /api/watchlists` with `Origin: https://evil.example` → 403 `bad_origin`.
- `curl -I https://<custom-domain>/` shows HSTS, CSP, nosniff; `/api/health` shows the same minus CSP.
