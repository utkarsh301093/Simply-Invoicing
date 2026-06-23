# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
npm install
cp .env.example .env   # edit for Gmail (optional)
npm start              # http://localhost:4000
```

`npm start` and `npm run dev` are identical — both run `node server/index.js`. There is no build step; the frontend uses React 18 + Babel loaded via CDN.

## Architecture overview

**Single-process Node + Express server** serving a no-build React frontend:

- `server/index.js` — all Express routes (~720 lines). Contains the storage↔API mapping layer: the DB uses a normalized storage model (see below) but the REST API and frontend use a flatter legacy shape. All translation happens here via `invoiceView()`, `customerView()`, `settingsView()`, etc.
- `server/store.js` — JSON-file persistence (`data/db.json`). Owns the schema (`SCHEMA_VERSION = 2`), forward migration logic, and atomic writes (write to `.tmp`, then `rename`). The `migrate()` function handles two legacy shapes (pre-orgs flat layout and nested-orgs layout).
- `server/pdf.js` — server-side vector PDF generation with `pdfkit` + `svg-to-pdfkit`. Colors/layout hardcoded to match `public/styles.css`. PDFs are stored at `data/invoices/<orgId>/<invoiceNumber>.pdf`.
- `server/invoice.js` — `computeTotals()`, `amountToWords()`, `round2()` helpers used by both the server and implicitly by the frontend.
- `server/google.js` — Gmail OAuth2 flow via `googleapis` + `nodemailer`. Tokens stored in `db.integrations.google`.
- `server/export.js` — Excel `.xlsx` export with `exceljs` (one sheet each for invoices, customers, items).
- `public/app.jsx` — React SPA, no compilation. All UI state, views, and API calls.
- `public/invoice-template.jsx` — Live on-screen invoice preview component (mirrors `server/pdf.js` layout).
- `data/db.json` — The entire database. Git-ignored. Delete it to reset to onboarding.

## Data model (critical to understand)

The storage model in `data/db.json` is **normalized** (see `SCHEMA.md`): top-level arrays for each entity type (`organizations`, `customers`, `items`, `invoices`, `payments`, `recurringSchedules`, `activity`), with ids as foreign keys. Every record has a standard envelope: `{ id, orgId, createdAt, updatedAt, archivedAt, metadata }`. `archivedAt: null` means active — nothing is hard-deleted.

Key design decisions:
- **Invoice snapshot**: invoices embed a `snapshot` of seller/buyer at the time of issue so editing a customer doesn't rewrite historical invoices.
- **Payment ledger**: `balanceDue` and `paid` status are computed from the `payments` collection, never stored. `POST /api/invoices/:id/pay` appends to `payments`; `POST /api/invoices/:id/unpay` archives those entries.
- **Persistence ↔ API split**: `server/index.js` maps between the normalized DB shape and the flat API shape the frontend expects (e.g. `snapshot.seller.businessName` ↔ `business.name`, `taxPercent` ↔ `taxPct`). Do not collapse this split.

## Multi-org scoping

All data routes call `requireOrg(res)` first, which returns `store.activeOrg()` — the org matching `db.meta.currentOrgId`. All queries use `store.rows(collection, org.id)` which filters by `orgId` and excludes archived records.

## Recurring invoice scheduler

On startup and every hour, `runDueSchedules()` scans all active `recurringSchedules` across all orgs. If `nextRunDate <= today`, it calls `generateFromSchedule()` (which also advances `nextRunDate` by one month and saves a PDF). The catch-up loop runs up to 36 times per schedule to handle server downtime.

## Adding a new feature

- New entity type → add a top-level array to `emptyDb()` and `COLLECTIONS` in `store.js`, add a `backfill` case, bump `SCHEMA_VERSION`, write a migration branch in `migrate()`.
- New API field → add to the relevant `*View()` function in `index.js` and its `*FromApi()` counterpart; storage shape stays separate.
- PDF layout changes → edit `server/pdf.js` AND `public/invoice-template.jsx` in sync (they must match visually).

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default `4000`) |
| `APP_BASE_URL` | Public URL for Google OAuth redirect |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

Gmail send is the only feature that requires env vars. Everything else works with no `.env`.
