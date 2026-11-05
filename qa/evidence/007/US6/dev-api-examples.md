# 007/US6 developer API/static examples (Node server on :8788)

## GET /robots.txt
```
HTTP/1.1 200 OK
cache-control: no-cache
content-length: 244
content-type: text/plain; charset=utf-8
x-content-type-options: nosniff
Connection: keep-alive
Keep-Alive: timeout=5

User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /tenders
Disallow: /pipeline
Disallow: /vault
Disallow: /profile
Disallow: /settings
Disallow: /onboarding
Disallow: /workspaces
Disallow: /api/

Sitemap: https://tenderpilot.in/sitemap.xml
```
## GET /sitemap.xml
```
HTTP/1.1 200 OK
cache-control: no-cache
content-length: 432
content-type: application/xml; charset=utf-8
x-content-type-options: nosniff
Connection: keep-alive
Keep-Alive: timeout=5

<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://tenderpilot.in/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://tenderpilot.in/signup</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
  <url><loc>https://tenderpilot.in/login</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>
</urlset>
```
## GET /og.png
```
HTTP/1.1 200 OK
content-type: image/png
x-content-type-options: nosniff
```
## Worker static assets (wrangler dev --local): /robots.txt 200 text/plain, /sitemap.xml 200 application/xml, /og.png 200 image/png
## Head meta of GET /
```html
    <title>TenderPilot — GeM tender co-pilot for Indian sellers</title>
    <meta name="description" content="Win more GeM bids, with a co-pilot that never takes the wheel. Discover, qualify and prepare Government e-Marketplace tenders — you type the price and submit on GeM." />
    <link rel="canonical" href="https://tenderpilot.in/" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="TenderPilot" />
    <meta property="og:url" content="https://tenderpilot.in/" />
    <meta property="og:title" content="TenderPilot — GeM tender co-pilot for Indian sellers" />
    <meta property="og:description" content="Win more GeM bids, with a co-pilot that never takes the wheel. Discover, qualify and prepare tenders; you type the price and submit on GeM." />
    <meta property="og:image" content="https://tenderpilot.in/og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="TenderPilot — Win more GeM bids. A co-pilot that never takes the wheel." />
    <meta property="og:locale" content="en_IN" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="TenderPilot — GeM tender co-pilot for Indian sellers" />
    <meta name="twitter:description" content="Win more GeM bids, with a co-pilot that never takes the wheel." />
    <meta name="twitter:image" content="https://tenderpilot.in/og.png" />
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"SoftwareApplication","name":"TenderPilot","applicationCategory":"BusinessApplication","operatingSystem":"Web","url":"https://tenderpilot.in/","description":"GeM tender co-pilot for Indian sellers: discover, quali
```
## Rendered document.title on /: `TenderPilot — GeM tender co-pilot for Indian sellers` (no doubled suffix); `/signup?plan=bogus` shows no trial note.
