# US4 developer API examples — `POST /api/me/notifications/test` (002/FR-034)

Captured against a local server (log adapters: no RESEND_API_KEY / WHATSAPP_TOKEN configured, so external channels report `skipped`).

## 1. Default preferences (in-app on, email on, WhatsApp off)

```http
POST /api/me/notifications/test
Cookie: tp_session=…
```

→ **200**

```json
{
  "inApp": "sent",
  "email": "skipped",
  "whatsapp": "off"
}
```

## 2. Same user again within a minute

```http
POST /api/me/notifications/test
Cookie: tp_session=…
```

→ **429** · `Retry-After: 60`

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many attempts. Try again in 1 minute.",
    "details": {
      "retryAfter": 60
    }
  }
}
```

## 3. In-app and email off, WhatsApp on with +919812345678

```http
POST /api/me/notifications/test
Cookie: tp_session=…
```

→ **200**

```json
{
  "inApp": "off",
  "email": "off",
  "whatsapp": "skipped"
}
```

## 4. Not signed in

```http
POST /api/me/notifications/test
```

→ **401**

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Please sign in to continue"
  }
}
```
