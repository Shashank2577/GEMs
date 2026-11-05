# 002 / US5 — developer API examples (FR-035..FR-037)

Captured 2026-11-05 against a local server (`e2e/support/start-api.sh`, port 8798, fresh DB) with `curl`.
Tokens/ids trimmed. Cookie = web session from `POST /api/auth/signup`.

## Create with `expiresInDays` (session cookie)

```
POST /api/me/api-tokens   {"name":"Chrome extension","expiresInDays":30}
→ 201 {"id":"1fed2968-…","name":"Chrome extension","lastUsedAt":null,"createdAt":"2026-11-05T04:02:48.943Z",
       "expiresAt":"2026-12-05T04:02:48.943Z","hint":"JofY","token":"tp_l-Vvb…IJofY"}

POST /api/me/api-tokens   {"name":"Office desktop","expiresInDays":null}
→ 201 {…,"expiresAt":null,"hint":"vdtc","token":"tp_…vdtc"}

POST /api/me/api-tokens   {"name":"Laptop"}                       (default = 90 days)
→ 201 {…,"createdAt":"2026-11-05T04:02:49.014Z","expiresAt":"2027-02-03T04:02:49.014Z","hint":"s314",…}

POST /api/me/api-tokens   {"name":"x","expiresInDays":7}
→ 400 {"error":{"code":"validation_error","message":"expiresInDays: Invalid input",…}}

GET /api/me/api-tokens
→ 200 {"items":[{"id":"…","name":"Laptop","lastUsedAt":null,"createdAt":"…","expiresAt":"2027-02-03T04:02:49.014Z","hint":"s314"}, …],"total":10}
   (no `token` field in the list)
```

## Token limit — 11th active token

```
POST /api/me/api-tokens   {"name":"eleventh"}        (user already holds 10 active tokens in this org)
→ 409 {"error":{"code":"token_limit","message":"You already have 10 tokens. Revoke one first."}}
```

## Bearer token works, then expires

```
GET /api/workspaces   Authorization: Bearer tp_…JofY
→ 200 {"items":[],"total":0,"byStage":{}}

(expires_at moved 1 minute into the past)
GET /api/workspaces   Authorization: Bearer tp_…JofY
→ 401 {"error":{"code":"unauthorized","message":"Please sign in to continue"}}
```

## Bearer token refused on account endpoints

```
POST /api/me/api-tokens   Authorization: Bearer tp_…   {"name":"x"}
→ 403 {"error":{"code":"forbidden","message":"This action requires signing in on the web app"}}

POST /api/me/password     Authorization: Bearer tp_…   {"currentPassword":"…","newPassword":"…"}
→ 403 {"error":{"code":"forbidden","message":"This action requires signing in on the web app"}}

POST /api/auth/switch-org Authorization: Bearer tp_…   {"orgId":"…"}
→ 403 {"error":{"code":"forbidden","message":"This action requires signing in on the web app"}}
```
