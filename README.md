# Simple Invoicing Tool

A small, clean billing tool to create customers, raise invoices, email them from your Gmail (PDF attached), download invoice PDFs, mark invoices paid (recording the payment mode), and run **monthly recurring invoices**. Invoice layout is matched to the Zoho-style "Tax Invoice" template.

## Features

- **Landing → onboarding** — first run shows a minimal landing page; "Go to app" walks a new user through creating their first organization (no login required).
- **Organizations** — keep separate businesses in one tool. Switch between them (or exit back to the landing page) from the switcher at the top of the sidebar. Customers, items, invoices, recurring schedules, numbering, logo and settings are all scoped per org.
- **Customers** — billing & ship-to address, recipient email (+ cc), GSTIN/Tax ID.
- **Invoices** — line items, auto totals, tax, amount-in-words, auto due date from terms.
- **Pixel-matched template** — dark logo block, dark table header, balance-due bar, notes/bank block.
- **Send via Gmail** — Google OAuth connect; emails the invoice with the PDF attached, from your address.
- **Download PDF** — client-side, send it yourself however you like.
- **Mark as paid** — records payment mode, date, reference, amount; shows a PAID stamp.
- **Recurring** — monthly schedules that auto-generate the next invoice on a chosen day. A built-in hourly scheduler materializes due invoices (and catches up if the server was off).
- **Excel export** — download invoices, customers and items as a real `.xlsx` workbook (one sheet each, with auto-filter and a totals row). Invoices can be filtered by status, customer, and a **smart date range** — This month, This/Last quarter, This/Last financial year (Apr–Mar), Year to date, Last 30/90 days, Last 12 months, or a custom from/to.
- **Settings** — your business/sender details, currency, invoice numbering, default terms & bank notes.

## Stack

- **Backend:** Node + Express, JSON-file storage in `data/db.json` (atomic writes, no database to install). The data is modeled as normalized top-level collections with stable ids/foreign keys, a uniform record envelope, soft deletes, a payments ledger, and a versioned migration on load — see **[SCHEMA.md](SCHEMA.md)**. Older databases upgrade automatically on first launch.
- **PDF:** rendered server-side as **true vector text** with `pdfkit` (+ `svg-to-pdfkit` for SVG logos) — crisp at any zoom, tiny files. A copy of every invoice is saved to `data/invoices/<number>.pdf`.
- **Email:** Gmail via `nodemailer` OAuth2 + `googleapis` for the consent flow; emails attach the stored PDF.
- **Frontend:** React 18 + Babel via CDN (no build step). The on-screen invoice is a live preview; downloads/emails use the server-rendered PDF.

## Items catalog

Save the things you sell under **Items** (default rate + tax). When adding invoice line items, pick a saved item from the dropdown (auto-fills price & tax) or type a new name and press **＋** to save it on the fly.

## Run

```bash
cd "Invoicing tool"
npm install
cp .env.example .env      # then edit if you want Gmail sending
npm start                 # http://localhost:4000
```

Everything except **Send via Gmail** works without any Google setup. Use **Download PDF** if you prefer to send invoices yourself.

## Enabling "Send via Gmail" (optional)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → Library →** enable **Gmail API**.
3. **APIs & Services → Credentials →** create an **OAuth client ID** (type: *Web application*).
4. Add an authorized redirect URI: `http://localhost:4000/auth/google/callback`
   (must equal `<APP_BASE_URL>/auth/google/callback`).
5. Put the client ID/secret in `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   APP_BASE_URL=http://localhost:4000
   ```
6. Restart the server, open **Settings → Connect Google account**, approve the `gmail.send` scope.

While the OAuth consent screen is in "Testing", add your Google address as a **Test user**.

## Data & privacy

All data lives in `data/db.json` (git-ignored), with a PDF copy of every invoice under `data/invoices/<org-id>/`. The `data/` directory is created automatically on first launch — a fresh clone starts with an empty database and walks you through onboarding. Nothing you enter is committed to git or sent anywhere; delete `data/` to reset and start again.

## Project structure

```
server/
  index.js   — Express routes + the storage⇄API mapping layer
  store.js   — JSON-file persistence, schema versioning & migrations
  pdf.js     — server-side vector PDF rendering (pdfkit)
  invoice.js — totals, rounding, amount-in-words helpers
  google.js  — Gmail OAuth2 + send (nodemailer)
  export.js  — Excel (.xlsx) export
public/
  index.html, app.jsx, invoice-template.jsx, styles.css  — no-build React SPA
SCHEMA.md    — the normalized data model in detail
```

## API (for reference)

`/api/orgs` (+ `POST`, `/:id/activate`, `DELETE`), `/api/settings`, `/api/customers`, `/api/products`,
`/api/invoices` (+ `/:id/pay`, `/:id/unpay`, `/:id/send`, `/:id/pdf`, `/:id/payments`), `/api/recurring` (+ `/:id/run`),
`/api/export` (xlsx; `?datasets=&from=&to=&status=&customerId=`), `/api/google/status`, `/auth/google`.
All data routes operate on the currently-active org.

## License

Released under the [MIT License](LICENSE).
