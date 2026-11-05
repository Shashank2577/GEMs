# 007 / US2 — developer API examples

Captured against the real API on :8788 with tools/mock-gem on :4011 (demo org). JSON trimmed.

## 1. Result hint — first lookup (fetches GeM public result page)

```http
GET /api/tenders/09ded876-8db1-4964-bc66-5b6e4dec42de/result-hint
```

→ **200** — stored in gem_result_hints

```json
{
  "available": true,
  "l1Price": 3175000,
  "bidders": [
    {
      "rank": 1,
      "level": "L1",
      "price": 3175000
    },
    {
      "rank": 2,
      "level": "L2",
      "price": 3302000
    },
    {
      "rank": 3,
      "level": "L3",
      "price": 3460750
    }
  ],
  "sourceUrl": "http://127.0.0.1:4011/bidding/bid/getBidResultView/8100074",
  "fetchedAt": "2026-11-05T03:41:02.770Z"
}
```

## 2. Result hint — a second org with a workspace for the same bid (served from the DB, no GeM call)

```http
GET /api/tenders/09ded876-8db1-4964-bc66-5b6e4dec42de/result-hint   (cookie: second org)
```

→ **200** — identical hint and fetchedAt

```json
{
  "bidders": [
    {
      "rank": 1,
      "level": "L1",
      "price": 3175000
    },
    {
      "rank": 2,
      "level": "L2",
      "price": 3302000
    },
    {
      "rank": 3,
      "level": "L3",
      "price": 3460750
    }
  ],
  "l1Price": 3175000,
  "available": true,
  "fetchedAt": "2026-11-05T03:41:02.770Z",
  "sourceUrl": "http://127.0.0.1:4011/bidding/bid/getBidResultView/8100074"
}
```

## 3. Result hint — per-org limit (20 per hour) exceeded after 20 more lookups

```http
GET /api/tenders/09ded876-8db1-4964-bc66-5b6e4dec42de/result-hint   (cookie: second org)
```

→ **429 (Retry-After: 3600)**

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many attempts. Try again in 60 minutes.",
    "details": {
      "retryAfter": 3600
    }
  }
}
```

## 4. Record the result — PATCH outcome after the move to Won

```http
PATCH /api/workspaces/c1a00179-8558-4a6c-85b6-39076eb84d32
Content-Type: application/json

{ "outcome": { "result": "won", "l1Price": 1675000, "ourPrice": 1240000, "notes": "L1 confirmed on GeM result page." } }
```

→ **200**

```json
{
  "id": "c1a00179-8558-4a6c-85b6-39076eb84d32",
  "stage": "won",
  "outcome": {
    "at": "2026-11-05T03:41:03.140Z",
    "notes": "L1 confirmed on GeM result page.",
    "result": "won",
    "l1Price": 1675000,
    "ourPrice": 1240000
  },
  "submittedAt": "2026-10-23T07:30:00.000Z",
  "position": 3
}
```
