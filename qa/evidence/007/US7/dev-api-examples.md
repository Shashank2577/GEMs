# US7 developer evidence: API / HTTP examples and axe summary

## GET /manifest.webmanifest (FR-095)
```
$ curl -si localhost:8788/manifest.webmanifest   -> 200
content-type: application/manifest+json
x-content-type-options: nosniff
```
```json
{
  "name": "TenderPilot",
  "short_name": "TenderPilot",
  "description": "GeM tender co-pilot for Indian sellers: discover, qualify and prepare bids. You type the price and submit on GeM.",
  "id": "/dashboard",
  "start_url": "/dashboard",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "lang": "en-IN",
  "theme_color": "#4f46e5",
  "background_color": "#ffffff",
  "categories": ["business", "productivity"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

## index.html links (served at /)
```
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
```

## Icons
```
icon-192.png -> 200 image/png 8431B
icon-512.png -> 200 image/png 25173B
icon-maskable-512.png -> 200 image/png 15163B
apple-touch-icon.png -> 200 image/png 3783B
```

## CSP unchanged (no new inline script; manifest/icons are same-origin)
```
content-security-policy: default-src 'self'; script-src 'self' 'sha256-nqoN14nhqs9sqqnpm11uljBMqVKo+vqTeqdN4suDF0w=' 'sha256-+SnBFxfekSw5flhxpmr2WDrbwgNZhQ7RwlNzaFeCrPY=' 'sha256-VZBV0evDbc+SMeVpttMtQ
```

## axe + layout sweep (T073) before / after T075

44 combinations = 11 pages x {375, 1440} x {light, dark}. "Before" = same spec run against the main build (2e319fd), "after" = this branch.

| | before | after |
|---|---|---|
| combinations passing | 20 / 44 | 44 / 44 |
| axe violations (all impacts, node count) | 44 nodes, rule label-content-name-mismatch (serious), on tenders + notifications x 4 each | 0 |
| pages with horizontal overflow at 375 px | 2 (profile light/dark, scrollWidth 636) | 0 |
| combinations with targets below 24 px (44 px tab bar) | 20 (landing footer links, login Forgot password, onboarding stepper + switches, profile chips/help/All India/Clear/switches, tenders Show all + switches) | 0 |

Per-page axe JSON: qa/evidence/007/US7/axe/ (after state).
