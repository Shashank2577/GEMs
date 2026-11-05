# 002 / US6 — developer API examples (FR-042..FR-044)

Captured 2026-11-05 against a local stack (`e2e/support/start-api.sh`, port 8830, fresh DB `tenderpilot_e2e_us6`).
Cookie = web session of the org owner. Ids trimmed; `GET /api/activity` is org-scoped, newest first.

## 1. Change password, then read the audit entry

```
POST /api/me/password   {"currentPassword":"Qa!pass12345","newPassword":"Qa!pass67890x"}
→ 200 {"ok":true}

GET /api/activity?entityType=user&pageSize=2
→ 200 {"items":[{"id":"af0a5308-…","action":"auth.password_changed","entityType":"user",
        "entityId":"d824f27a-…","meta":{"otherSessionsRevoked":1},
        "createdAt":"2026-11-05T06:20:00.851Z","user":{"id":"d824f27a-…","name":"Asha Verma"}}],"total":1}
```
(meta carries only the count of other sessions signed out; no password material.)

## 2. Revoke other sessions

```
POST /api/me/sessions/revoke-others        (user holds 2 other sessions)
→ 200 {"revoked":2}

GET /api/activity?entityType=user&pageSize=2
→ 200 {"items":[
   {"id":"a3579dea-…","action":"auth.sessions_revoked","entityType":"user","entityId":"d824f27a-…",
    "meta":{"count":2,"scope":"others"},"createdAt":"2026-11-05T06:20:00.991Z","user":{"id":"d824f27a-…","name":"Asha Verma"}},
   {"id":"af0a5308-…","action":"auth.password_changed", …}],"total":2}
```

## 3. Wrong current password: 400, no activity row

```
SELECT count(*) FROM activity_log WHERE org_id = …   → 32

POST /api/me/password   {"currentPassword":"WrongPass!1","newPassword":"Qa!pass13579y"}
→ 400 {"error":{"code":"invalid_credentials","message":"Current password is incorrect",
        "details":{"fields":{"currentPassword":"Incorrect password"}}}}

SELECT count(*) FROM activity_log WHERE org_id = …   → 32   (unchanged)
```

## Screenshots

`dev-{desktop,mobile}-{populated,filter-member,filter-type,empty,palette-activity}.png` (1440 px and 375 px, full page, 32 rows -> "Showing 1–25 of 32").
The empty-state org had its single `org.created` row deleted in the throwaway DB, since a new org always logs that entry.
