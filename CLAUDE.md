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

Two further suites, each on its own throwaway container (no Supabase project, no credentials):

```bash
npm run test:rls      # 43 policy-level tenant-isolation + invoice-limit checks
npm run test:auth     # 13 HTTP-level auth + isolation + limit checks
```

They run separately from `npm test` on purpose: each truncates every table and binds its own ports, so sharing a database makes them fight.

`test/api-characterization.test.js` drives a full business flow through the HTTP API and snapshots every response to `test/golden/api-flow.json`. It is a **behavioral contract, not a correctness spec** — it records what the app does so refactors can prove they changed nothing. A diff means either a regression or a deliberate change; decide which before re-recording.

The suite **truncates every table**, so `test/harness.js` requires `TEST_DATABASE_URL` and refuses any URL containing `supabase.co`. Tests also run with `SUPABASE_URL` unset, which puts `server/storage.js` on its local-filesystem driver — no test ever touches a real bucket.

Volatile values (generated ids, timestamps, today's date, base64 data URLs) are normalized to stable tokens in `makeNormalizer()`. Ids are tokenized *anywhere in a string*, including URL paths, so the same id maps to the same token everywhere and referential structure stays visible in the golden.

## Architecture overview

**Single-process Node + Express server** on Supabase (Postgres + Storage), serving a no-build React frontend:

- `server/index.js` — all Express routes. Contains the storage↔API mapping layer: the DB is normalized but the REST API and frontend use a flatter legacy shape. All translation happens here via `invoiceView()`, `customerView()`, `settingsView()`, etc. Also hosts both hourly schedulers.
- `server/db.js` — the data-access layer over `pg`. **Every function returns records in the same nested shape the old JSON store used** (`{ profile, branding, defaults, numbering }`, `{ snapshot, amounts, lineItems }`), which is what keeps the mapping layer in `index.js` as the single translation point. Owns the connection pool, transactions, and id generation.
- `server/pgtypes.js` — Postgres type parsers. Must be required before any query. Each one is load-bearing; see the comments before changing them (notably: `date` stays a string so invoice dates can't shift a day, and `numeric` becomes a Number so money doesn't turn into string concatenation).
- `server/auth.js` — verifies Supabase access tokens against the project JWKS (ES256). Local verification, cached keys, fails closed.
- `server/storage.js` — Supabase Storage for invoice PDFs and org logos, with a local-filesystem driver used automatically when Supabase isn't configured. Deliberately not `@supabase/supabase-js` **on the server**: that SDK bundles Realtime (needs a WebSocket polyfill on Node < 22), Auth and PostgREST, none of which the server uses. The browser does load it, for passkeys only — see below.
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

## Authentication

Every `/api/*` data route requires a Supabase access token. `server/auth.js` verifies it locally against the project's published JWKS (ES256) — no shared secret, no round-trip per request. It fails closed, and reports expiry distinctly so the frontend can refresh instead of forcing a re-login.

Sign-in is **proxied** through `POST /api/auth/login` rather than done in the browser, so no Supabase key is needed in client code for passwords. The one exception is passkeys (below).

Three route wrappers make each route's access level visible where it is defined:

- **`route()`** — signed in, runs inside `db.withUser()`, RLS applies.
- **`serviceRoute()`** — signed in but bypasses RLS. Only for what RLS cannot express: creating an org (the `owner_user_id` row RLS keys off does not exist yet) and Gmail tokens (`integrations` has no policy by design).
- **`openRoute()`** — no auth. OAuth redirects, `/api/config`, login/refresh.

## Multi-org scoping

Routes call `await requireOrg(res)`, which returns `db.activeOrg()` — the org in `app_state.current_org_id` **for the signed-in user** (`app_state` is keyed by `user_id`), falling back to the oldest live org. Every query is scoped by `org_id`.

## Row Level Security

RLS is real at runtime. `db.withUser()` opens **one transaction per request**, sets the verified JWT claims and switches to the `authenticated` role; `set local` scopes both to that transaction, so a pooled connection cannot leak one user's identity into the next request. The identity travels in `AsyncLocalStorage`, so `q()`/`one()`/`tx()` pick it up and the ~40 repository functions in `db.js` cannot accidentally opt out.

Policies key off `organizations.owner_user_id` via `owns_org()` (`SECURITY DEFINER`, or the organizations policy would recurse). `integrations` and `user_limits` have **no policy at all** — Gmail refresh tokens and a user's own quota must stay service-role-only.

Two things that are easy to get wrong and are load-bearing:

- **Do not add `force row level security`.** FORCE subjects the table *owner* to policies too, and the connecting role is the owner. The owner bypass **is** the `withService()` mechanism the hourly sweeps depend on; forcing it would blind them.
- **Do not put `archived_at` in a policy predicate.** Soft-deleting a row then fails its own policy and the UPDATE is rejected — this is exactly what `0003` had to undo for org archiving. RLS answers "is this row yours"; lifecycle filtering belongs in the query.

`tx()` nests on a SAVEPOINT inside a request transaction. That is not tidiness: routes answer 4xx without rethrowing, so the request still commits, and without the savepoint a rejected invoice create would keep its `next_number` increment and burn an invoice number.

Verify with `npm run test:rls` (43 policy-level checks) and `npm run test:auth` (13 HTTP-level checks). Both use throwaway containers and need no Supabase project.

## Monthly invoice limit

A `BEFORE INSERT` trigger on `invoices` caps creation at `user_limits.monthly_invoice_limit` (default 30) per user per UTC calendar month. It is in the database because there are three creation paths (`POST /api/invoices`, `POST /api/recurring/:id/run`, the hourly sweep) and a JS check would have to be repeated at each.

Archived invoices still count — archiving is a soft delete, so excluding them would let a user delete and recreate indefinitely. The trigger locks the `user_limits` row before counting, so concurrent requests cannot both slip under the cap. Refusal raises SQLSTATE `IL001`, mapped to **429**, not 500. Edit the limit in the Supabase table editor; it applies on the next insert.

## Passkeys

`supabase-js` is loaded in the browser for **this feature only** — a deliberate exception to "the frontend only calls this API". A WebAuthn ceremony must run in the browser, and Supabase's passkey HTTP API is beta and undocumented, so hand-rolling it against raw endpoints would break silently. The SDK is version-pinned for the same reason.

It is created with `persistSession` and `autoRefreshToken` **off**: this app owns the session, and a second SDK-managed copy would drift on sign-out. `setSession()` pushes ours in when enrolment needs it.

`GET /api/config` serves only the project URL and the publishable key. With no publishable key set, `passkeys` is false and both the login button and the settings card hide themselves. Passkeys are bound to `webauthn_rp_id`, so they only work on the configured origin — they cannot be tested against localhost or a headless browser.

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
