<!--
Sync Impact Report
Version: 0.0.0 → 1.0.0 (2026-11-04, initial ratification, principles I–VIII)
Templates reviewed: plan/spec/tasks — compatible, no edits required.
-->
# TenderPilot Constitution

TenderPilot helps Indian MSMEs and OEM sellers find, qualify and prepare bids on the
Government e-Marketplace (GeM). It is a seller's co-pilot, never an autonomous bidder.

## Core Principles

### I. Human-in-the-Loop Submission (NON-NEGOTIABLE)
The product never submits a bid, enters a financial price on GeM, solves a CAPTCHA, or performs
Aadhaar OTP / e-Sign / DSC authentication on the seller's behalf. Everything up to the
final submit is prepared and pre-filled; the legally binding steps are always performed by a
named human operator. Any feature that would put a seller's GeM account at risk of suspension
(automated logins, credential storage for GeM, high-rate scraping) is out of scope.

### II. Polite, Public-Only Ingestion
Ingestion reads only publicly listed BidPlus data and documents. It is rate-limited, identifies
itself honestly, backs off on errors, and is idempotent (re-running an ingestion never duplicates
a tender). Every ingested record keeps its source URL and fetch timestamp.

### III. Deterministic First, Models Second
Every eligibility verdict MUST have a deterministic rules path that works with zero API keys.
LLMs extract, enrich and explain; they never silently decide. Every extracted requirement carries
provenance (source document, page, extraction method: `RULE` or `LLM`) and a confidence value, and
the Go/No-Go score shows the factors that produced it.

### IV. Tenant Isolation & Data Protection
Each organization's company profile, vault documents, scores and packets are visible only to its
members. Every query is scoped by organization. Documents are stored privately and served through
short-lived authorized links. Role-based access (Owner, Bid Manager, Analyst, Viewer) is enforced
server-side.

### V. Delightful, Accessible UX for Every Persona
The product is sold on its experience. Every screen has loading, empty and error states; is usable
on a 375 px phone and a 1440 px desktop; meets WCAG 2.1 AA contrast; supports keyboard use and light
and dark themes. Copy is plain English with Indian procurement terms (EMD, ePBG, MII, MSE, ATC, BOQ)
explained inline.

### VI. Test-First, End-to-End Verified
Core logic (parsers, scoring, expiry checks, packet assembly) has unit tests written alongside it.
Each user story has an end-to-end browser test that runs the real API against a real Postgres
database. A story is not done until its E2E test passes.

### VII. Edge-Native, Serverless Operations
The system runs on Cloudflare (Workers, Pages/static assets, Cron Triggers, R2) with Neon Postgres.
Everything also runs locally with plain Node and Postgres for development and CI. Configuration is
through environment variables; missing optional integrations (LLM key, WhatsApp, email) degrade
gracefully to logged no-ops, never to crashes.

### VIII. Simplicity & Traceability
One TypeScript monorepo, shared types between UI and API, one schema source of truth. Each task in
`tasks.md` references its user story and requirements; code that implements a requirement is
traceable back to it.

## Constraints

- Language: TypeScript end to end. Database: Postgres (Neon in production).
- External code reused only under compatible licenses (Apache-2.0, MIT), attributed in `NOTICE`.
- No secrets in the repository; `.dev.vars` / `.env` are git-ignored.

## Governance

This constitution supersedes other practice. Amendments are made by editing this file with a
Sync Impact Report, a semantic version bump and a note of affected templates. Reviews check every
change against Principles I and IV first.

**Version**: 1.0.0 | **Ratified**: 2026-11-04 | **Last Amended**: 2026-11-04
