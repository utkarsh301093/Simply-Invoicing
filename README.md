# Simply Invoicing

A **self-hosted** invoicing tool you fully own — create customers, raise clean PDF invoices, email them from your own Gmail, mark them paid, and run monthly recurring billing. No subscription, no feature paywalls, no data leaving your machine.

---

## Why this exists

A relative of mine kept being asked to pay more every time they needed one specific feature — the classic SaaS playbook where the thing you actually need is always one tier up.

That model is starting to look outdated. AI has made software cheap to build and easy to tailor to a single person's needs, and walling basic features behind a paywall increasingly feels like a relic of the past. So instead of paying a recurring fee for someone else's roadmap, I built exactly what they needed: a small invoicing tool that does the job, runs on their own machine, and is theirs to keep and change.

That's the whole idea — **own your tools, own your data.**

---

## What it does

- 🧾 **Invoices** — line items, automatic totals & tax, amount-in-words, and a due date worked out from your terms.
- 👥 **Customers & items** — save who you bill (address, email, tax ID) and what you sell (default rate + tax) for one-click reuse.
- 📄 **Clean PDFs** — every invoice renders as a crisp, professional PDF you can download or attach.
- ✉️ **Email from your Gmail** *(optional)* — connect your Google account and send invoices straight from your own address, PDF attached.
- ✅ **Mark as paid** — record the payment mode, date and reference; the invoice gets a **PAID** stamp. Partial payments supported.
- 🔁 **Recurring billing** — monthly schedules auto-generate each invoice on the day you choose (and catch up if the server was off).
- 🏢 **Multiple businesses** — keep separate organizations in one app, each with its own customers, numbering, logo and settings.
- 📊 **Excel export** — export invoices, customers and items to `.xlsx`, with smart date-range filters (this month, last quarter, financial year, and more).
- 🔒 **Your data stays yours** — everything lives in a single local file. No cloud, no account, no tracking.

---

## Quick start

You'll need [Node.js](https://nodejs.org) (v18 or newer).

```bash
git clone https://github.com/utkarsh301093/Simply-Invoicing.git
cd Simply-Invoicing
npm install
npm start
```

Now open **http://localhost:4000** and follow the onboarding to set up your business.

That's it — no database to install, no sign-up. Your local data store is created automatically on first launch, and everything you enter stays on your machine.

> 💡 Want to email invoices from Gmail? That part is optional — see [Sending via Gmail](#sending-via-gmail-optional) below. Without it, everything still works; just use **Download PDF** and send invoices however you like.

---

## Sending via Gmail (optional)

Turn this on if you want to email invoices directly from your own Gmail address.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. **APIs & Services → Library →** enable the **Gmail API**.
3. **APIs & Services → Credentials →** create an **OAuth client ID** (type: *Web application*).
4. Add this authorized redirect URI: `http://localhost:4000/auth/google/callback`
5. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   APP_BASE_URL=http://localhost:4000
   ```
6. Restart the server, then open **Settings → Connect Google account** and approve the `gmail.send` scope.

While your OAuth consent screen is still in "Testing", remember to add your Google address as a **Test user**.

---

## Your data & privacy

Everything is stored in a single git-ignored file, `data/db.json`, with a PDF copy of each invoice under `data/invoices/`. The `data/` folder is created automatically the first time you run the app, so a fresh clone always starts empty and walks you through onboarding. Nothing is committed to git or sent anywhere. To wipe everything and start over, just delete the `data/` folder.

---

## How it works

A single Node + Express process serves a no-build React frontend — no bundler, no database engine, nothing to provision.

- **Backend:** Node + Express with JSON-file storage (atomic writes). The data is modeled as normalized collections with stable ids, soft deletes, a payments ledger, and versioned migrations — details in **[SCHEMA.md](SCHEMA.md)**.
- **PDFs:** rendered server-side as true vector text with `pdfkit` — crisp at any zoom and tiny in size.
- **Email:** Gmail via `nodemailer` + `googleapis` OAuth2.
- **Frontend:** React 18 + Babel loaded from a CDN (no build step).

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
```

---

## License

Released under the [MIT License](LICENSE). Use it, change it, host it — it's yours.
