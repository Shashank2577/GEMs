# 007/US4 developer API examples

Captured against the real API on :8788 (Postgres, mock-gem on :4011).

## POST /api/demo/seed (owner)
Status: **201**
```json
{
  "ok": true,
  "tenders": 40,
  "watchlists": 3,
  "matches": 28,
  "analyses": 20,
  "workspaces": 16,
  "vaultDocuments": 15,
  "pastContracts": 5,
  "created": true
}
```
## DELETE /api/demo as analyst
Status: **403**
```json
{
  "error": {
    "code": "forbidden",
    "message": "You need to be at least a Bid Manager to do that"
  }
}
```
## DELETE /api/demo (owner, after re-seed)
Status: **200**
```json
{
  "ok": true,
  "removed": {
    "workspaces": 16,
    "analyses": 20,
    "matches": 28,
    "comments": 2,
    "notifications": 6,
    "activity": 12,
    "pastContracts": 5,
    "vaultDocuments": 15,
    "watchlists": 3,
    "profileReset": true
  }
}
```
## DELETE /api/demo again (idempotent)
Status: **200**
```json
{
  "ok": true,
  "removed": {
    "workspaces": 0,
    "analyses": 0,
    "matches": 0,
    "comments": 0,
    "notifications": 0,
    "activity": 0,
    "pastContracts": 0,
    "vaultDocuments": 0,
    "watchlists": 0,
    "profileReset": false
  }
}
```
