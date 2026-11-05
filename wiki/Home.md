# TenderPilot — GeM Tender Co-Pilot

TenderPilot helps Indian MSMEs, OEMs and resellers **find, qualify and prepare** bids on the Government
e-Marketplace (GeM). It is a co-pilot, never an autopilot: price entry, OTP/DSC/e-Sign and the final submit always
stay with a person.

| Module | What it does | Spec |
|---|---|---|
| Identify | Monitors GeM BidPlus, matches watchlists, alerts in-app / email / WhatsApp | [[Spec 003 Identify]] |
| Analyse | Parses bid PDFs, extracts eligibility, Go/No-Go score + document checklist | [[Spec 004 Analyse]] |
| Profile & Vault | Company profile, certificates, expiry reminders | [[Spec 005 Profile and Vault]] |
| Apply | Bid workspace, annexures, merged packet, assisted submission extension | [[Spec 006 Apply]] |
| Experience | Dashboard, pipeline, onboarding, landing, demo | [[Spec 007 Experience]] |
| Platform | Accounts, organizations, roles, settings | [[Spec 002 Platform]] |
| Operations | Cloudflare + Neon deployment, scale, security, CI, QA | [[Spec 008 Operations]] |

- **Delivery process:** [[Delivery Process]] — cairn spec workflow, GitHub issues, story branches, cairn review, QA with evidence.
- **Architecture:** [[Architecture]]
- **Running locally & deploying:** [[Runbook]]
- **QA evidence:** [[QA Evidence]]
- **Ticket board:** issues labelled per [[Delivery Process]]; Projects board "TenderPilot Delivery" is synced by `.github/workflows/project-board.yml`.

> This wiki is generated from the `wiki/` folder in the repository and published by `.github/workflows/wiki-sync.yml`.
> Edit pages through pull requests, not in the GitHub UI (UI edits are overwritten on the next sync).
