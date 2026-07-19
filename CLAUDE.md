# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
npm install
cp .env.example .env   # fill in Supabase (required) and Gmail (optional)
npm start              # http://localhost:4000
```

`npm start` and `npm run dev` are identical — both run `node server/index.js`. There is no build step; the frontend uses React 18 + Babel loaded via CDN.

The server refuses to start without a reachable database: `start()` verifies the connection and exits 1 on failure, so a bad `DATABASE_URL` fails loudly at boot rather than on the first request.

## Testing

```bash
npm run test:db:up     # throwaway Postgres in Docker + schema (once per session)
npm test               # 48-step characterization suite
npm run test:update    # re-record the golden file after an INTENTIONAL change
npm run test:db:down
```

`test/api-characterization.test.js` drives a full business flow through the HTTP API and snapshots every response to `test/golden/api-flow.json`. It is a **behavioral contract, not a correctness spec** — it records what the app does so refactors can prove they changed nothing. A diff means either a regression or a deliberate change; decide which before re-recording.

The suite **truncates every table**, so `test/harness.js` requires `TEST_DATABASE_URL` and refuses any URL containing `supabase.co`. Tests also run with `SUPABASE_URL` unset, which puts `server/storage.js` on its local-filesystem driver — no test ever touches a real bucket.

Volatile values (generated ids, timestamps, today's date, base64 data URLs) are normalized to stable tokens in `makeNormalizer()`. Ids are tokenized *anywhere in a string*, including URL paths, so the same id maps to the same token everywhere and referential structure stays visible in the golden.

## Architecture overview

**Single-process Node + Express server** on Supabase (Postgres + Storage), serving a no-build React frontend:

- `server/index.js` — all Express routes. Contains the storage↔API mapping layer: the DB is normalized but the REST API and frontend use a flatter legacy shape. All translation happens here via `invoiceView()`, `customerView()`, `settingsView()`, etc. Also hosts both hourly schedulers.
- `server/db.js` — the data-access layer over `pg`. **Every function returns records in the same nested shape the old JSON store used** (`{ profile, branding, defaults, numbering }`, `{ snapshot, amounts, lineItems }`), which is what keeps the mapping layer in `index.js` as the single translation point. Owns the connection pool, transactions, and id generation.
- `server/pgtypes.js` — Postgres type parsers. Must be required before any query. Each one is load-bearing; see the comments before changing them (notably: `date` stays a string so invoice dates can't shift a day, and `numeric` becomes a Number so money doesn't turn into string concatenation).
- `server/storage.js` — Supabase Storage for invoice PDFs and org logos, with a local-filesystem driver used automatically when Supabase isn't configured. Deliberately not `@supabase/supabase-js`: that SDK bundles Realtime (needs a WebSocket polyfill on Node < 22), Auth and PostgREST, none of which this app uses.
- `server/pdf.js` — server-side vector PDF generation with `pdfkit` + `svg-to-pdfkit`. Colors/layout hardcoded to match `public/styles.css`.
- `server/invoice.js` — `computeTotals()`, `amountToWords()`, `round2()`.
- `server/google.js` — Gmail OAuth2 via `googleapis` + `nodemailer`. The connection is **cached in memory** (`load()` at boot) so `status()` can stay synchronous for routes and the reminder sweep.
- `server/export.js` — Excel `.xlsx` export with `exceljs`.
- `server/emailTemplates.js` — subject/text/html builders. Takes the **flat API-shaped** invoice from `invoiceView()`, not the stored record. CSS is inlined; the accent color must stay in sync with `--accent` in `public/styles.css`.
- `public/app.jsx` — React SPA, no compilation.
- `public/invoice-template.jsx` — on-screen invoice preview (mirrors `server/pdf.js`).
- `supabase/migrations/` — SQL schema. `supabase/tests/schema_invariants.sql` proves the constraints actually hold.
- `scripts/migrate-to-supabase.js` — one-shot idempotent import from a legacy `data/db.json`.

## Data model

See `SCHEMA.md`. Tables mirror the old collections, with `organizations` as the tenant boundary and `org_id` on every row. Key decisions:

- **IDs are `TEXT`** (`inv_lx3k2a9f`), not uuid — the app generates them via `db.id(prefix)`, matching the legacy scheme.
- **Money is `numeric`**, never float. `0.1 + 0.2` is exactly `0.30`.
- **`snapshot` is JSONB and deliberately denormalized** — an immutable copy of seller/buyer at issue time, so editing a customer never rewrites historical invoices. Do not normalize it.
- **Snapshots store a logo *path*, not bytes.** `db.js` re-resolves it to a data URL on read (cached per process) because the PDF renderer and email templates expect one. Inlining the base64 cost ~45KB per invoice row.
- **Payment ledger**: `balanceDue` and paid status come from the `invoice_balances` view, never stored. `/pay` appends to `payments`; `/unpay` archives those entries.
- **Invoice status is derived**, never stored: `void` → `paid` → `sent` → `draft`, in that precedence. See `invoiceView()`.
- **Nothing is hard-deleted** — `archived_at IS NULL` means active. Foreign keys use `on delete restrict` for customers so history can't be orphaned.

### Invariants enforced by the database, not by JS

These were previously JS-side checks that a crash or a race could bypass:

- Invoice numbers are unique per org, and `nextInvoiceNumber()` uses `UPDATE … RETURNING` inside the creating transaction. A **failed create rolls the number back**, so the sequence has no gaps — tax authorities in several jurisdictions require this.
- Item names are case-insensitively unique per org (the `/api/products` de-dupe), and archiving frees the name.
- Only one *pending* reminder per (invoice, date); cancelled ones don't block a reschedule.

## Multi-org scoping

Routes call `await requireOrg(res)`, which returns `db.activeOrg()` — the org in `app_state.current_org_id`, falling back to the oldest live org. Every query is scoped by `org_id`.

## Row Level Security

RLS is enabled on all 13 tables with **no policies**, so every role except `service_role` is denied. Note the server connects with the secret key, which **bypasses RLS entirely** — so RLS protects nothing at runtime today. The real control is that the key never leaves the server and the browser never talks to Supabase directly (it only calls this Express API; the publishable key is unused).

RLS is there as defense-in-depth for a leaked publishable key, and as the multi-user on-ramp: `organizations.owner_user_id` and commented-out policies at the bottom of the migration mean enabling auth is a policy change, not a schema change. `integrations` holds Gmail refresh tokens and must stay `service_role`-only regardless.

## Hourly schedulers

Both run at boot and hourly, chained as `runDueSchedules().then(runDueReminders)`. A restart is the only way to force an immediate pass (besides `POST /api/recurring/:id/run`). Both wrap their bodies in try/catch — an unhandled rejection in a timer would take the process down.

- **`runDueSchedules()`** queries schedules with `next_run_date <= today` across all orgs. `generateFromSchedule()` mints the invoice and advances `next_run_date` **in one transaction**, so a mid-run failure can't create an invoice without advancing the schedule (which would duplicate it next pass). The catch-up loop is capped at 36 iterations.
- **`runDueReminders()`** sends pending reminders whose `due_on <= today` with the PDF attached. It **no-ops entirely when Gmail is not connected**, so reminders stay pending. A reminder self-cancels if its invoice is paid, voided or archived; a send failure records `error` and is retried next pass. Reminder tone uses *actual* lateness today, not the planned `offsetDays`, so catch-up sends after downtime still read correctly.

## Adding a feature

- **New entity** → add a table in a new `supabase/migrations/` file, add a repository section in `db.js` returning the nested record shape, add invariants to `supabase/tests/schema_invariants.sql`, document in `SCHEMA.md`.
- **New API field** → add to the relevant `*View()` in `index.js` and its counterpart; the storage shape stays separate.
- **PDF layout** → edit `server/pdf.js` AND `public/invoice-template.jsx` in sync.
- Every route body is wrapped in `route()`, which turns a rejected promise into a 500 instead of a hung request. Use it for new routes.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (use the **transaction pooler**, port 6543 — direct connections are IPv6-only) |
| `SUPABASE_URL` | Project URL, e.g. `https://<ref>.supabase.co` (not the `/rest/v1/` endpoint) |
| `SUPABASE_SECRET_KEY` | `sb_secret_…`, server-side only; replaces the legacy `service_role` JWT |
| `SUPABASE_STORAGE_BUCKET` | Private bucket for PDFs and logos (default `invoices`) |
| `DATA_DIR` | Overrides the data directory; used by tests and the local storage driver |
| `TEST_DATABASE_URL` | Test-only. The suite truncates every table and refuses Supabase URLs |
| `PORT` | Server port (default `4000`) |
| `APP_BASE_URL` | Public URL for the Google OAuth redirect |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail send (optional — everything else works without them) |

If Supabase Storage is unconfigured the app falls back to the local filesystem under `DATA_DIR/storage/`, so it still runs fully offline.
