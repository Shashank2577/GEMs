# API examples (002/HARDEN) - live from :8810, commit 3a480ae

## 1. GET /api/auth/me (anonymous) -> 401
```
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: application/json
referrer-policy: no-referrer
x-content-type-options: nosniff
x-frame-options: DENY
x-request-id: df2f9ddf-c30c-40c1-89e8-0eb99d47907f
content-length: 72
Date: Thu, 05 Nov 2026 04:49:48 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":{"code":"unauthorized","message":"Please sign in to continue"}}
```

## 2. POST /api/auth/signup then GET /api/auth/me (session cookie) -> 200
```
signup -> 201
HTTP/1.1 200 OK
cache-control: no-store
content-type: application/json
referrer-policy: no-referrer
x-content-type-options: nosniff
x-frame-options: DENY
x-request-id: d038d39c-df2e-455b-8aba-5b1a68623c7f
content-length: 399
Date: Thu, 05 Nov 2026 04:49:48 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"user":{"id":"c4c43177-74b9-48d4-b167-bf980dda452a","name":"Hard Dev","email":"hard21032@example.in","phone":null},"org":{"id":"02af57a9-cff5-4e6b-af1e-77860969d497","name":"Hard Traders","slug":"hard-traders","plan":"trial","onboardingState":{},"scoringWeights":null},"role":"owner","orgs":[{"id":"02af57a9-cff5-4e6b-af1e-77860969d497","name":"Hard Traders","slug":"hard-traders","role":"owner"}]}
```

## 3. PUT /api/me/notification-prefs (WhatsApp without phone) -> 400
```
HTTP/1.1 400 Bad Request
cache-control: no-store
content-type: application/json
referrer-policy: no-referrer
x-content-type-options: nosniff
x-frame-options: DENY
x-request-id: 955b93b6-383c-4c55-af4c-302c07423ef7
content-length: 168
Date: Thu, 05 Nov 2026 04:49:48 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":{"code":"bad_request","message":"Add your mobile number in your profile to receive WhatsApp alerts","details":{"fields":{"whatsapp":"Phone number required"}}}}
```

## 4. PUT prefs (email on) then POST /api/me/notifications/test -> 200 with skipReasons
```
HTTP/1.1 200 OK
{"inApp":true,"email":true,"whatsapp":false,"frequency":"instant","expiryReminders":true}
HTTP/1.1 200 OK
cache-control: no-store
content-type: application/json
referrer-policy: no-referrer
x-content-type-options: nosniff
x-frame-options: DENY
x-request-id: 82169eef-8fb4-420b-ae2c-c69ba661e89a
content-length: 92
Date: Thu, 05 Nov 2026 04:49:48 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"inApp":"sent","email":"skipped","whatsapp":"off","skipReasons":{"email":"not_configured"}}
```

## 5. Login rate limit: repeated bad passwords -> 429 rate_limited
```
attempt 1 -> 401
attempt 2 -> 401
attempt 3 -> 401
attempt 4 -> 401
attempt 5 -> 401
attempt 6 -> 401
attempt 7 -> 401
attempt 8 -> 401
attempt 9 -> 401
attempt 10 -> 401
attempt 11 -> 429
HTTP/1.1 429 Too Many Requests
cache-control: no-store
content-type: application/json
referrer-policy: no-referrer
retry-after: 900
x-content-type-options: nosniff
x-frame-options: DENY
x-request-id: 2ffa7666-517e-4369-9edc-2427fb9f8f50
content-length: 118
Date: Thu, 05 Nov 2026 04:49:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":{"code":"rate_limited","message":"Too many attempts. Try again in 15 minutes.","details":{"retryAfter":900}}}
```
