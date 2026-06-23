# Data model

The app still stores everything in a single JSON file (`data/db.json`, atomic writes). What
changed is the **shape** of that data: it is now modeled the way you'd model relational tables /
document collections, so new features slot in without reshaping what already exists.

## Principles

1. **Top-level collections, not deep nesting.** Independent entities that grow over time
   (customers, invoices, payments…) live in their own top-level arrays — like tables — instead of
   being buried inside the organization record. Embedding an unbounded, ever-growing list inside a
   parent document is the classic anti-pattern this avoids.

2. **Reference by id (foreign keys), never by copy.** Records point at each other with stable ids
   (`orgId`, `customerId`, `invoiceId`). A fact lives in exactly one place; everything else links to
   it. Renaming a customer updates one row.

3. **Aggregate boundaries decide embed vs. reference** (Domain-Driven Design). Data that is *owned
   by and only reached through* a parent is embedded as a value object — invoice **line items**, an
   address's lines, the issue-time **snapshot**. Data with an independent life of its own is a
   referenced collection — customers, the item catalog, **payments**.

4. **Snapshot vs. reference for financial integrity.** An invoice keeps both a `customerId`
   (a live link, for navigation) **and** a frozen `snapshot` of the seller, buyer and terms exactly
   as they were when it was issued. Editing a customer or your business details never rewrites a
   historical invoice — the legal document is immutable.

5. **A uniform record envelope.** Every record carries `id`, `createdAt`, `updatedAt`,
   `archivedAt` (soft delete — `null` means active, so nothing is ever truly lost), and an open
   `metadata: {}` object. `metadata` is the forward-compatibility hatch: custom fields, tags, or
   integration ids can be added with no schema change.

6. **Derive money state from a ledger.** What an invoice still *owes* is computed from the
   `payments` collection, not stored as a single editable number. That one decision gives you
   partial payments, multiple payments per invoice, payment history, and refunds essentially for
   free. The derived `balanceDue` / `status` are cached back onto the invoice view for fast reads.

7. **Money is explicit about its currency.** Every monetary record names an ISO `currency`. Amounts
   are decimal numbers today; if exact-cent accounting is ever needed, the documented next step is
   integer **minor units** (cents) — a localized change because all money already flows through one
   `amounts` block per invoice and the `payments` ledger.

8. **Versioned + multi-tenant.** A top-level `schemaVersion` drives forward migrations on load.
   Every row carries `orgId`, so the model is multi-organization from the ground up.

## Collections

| Collection           | What it is                          | Key references                |
|----------------------|-------------------------------------|-------------------------------|
| `organizations`      | A tenant: profile, branding, defaults, invoice numbering | —            |
| `customers`          | Who you bill                        | `orgId`                       |
| `items`              | Product / service catalog (default price + tax) | `orgId`, `taxRateId?`   |
| `taxRates`           | Reusable named tax rates            | `orgId`                       |
| `invoices`           | The issued documents                | `orgId`, `customerId`, `recurringScheduleId?` |
| `payments`           | Money received — the ledger         | `orgId`, `invoiceId`          |
| `recurringSchedules` | Subscription templates that mint invoices | `orgId`, `customerId`   |
| `activity`           | Append-only audit / event log       | `orgId`, `refType`/`refId`    |
| `integrations`       | Global third-party connections (Gmail) | —                          |
| `meta`               | App state: `currentOrgId`, timestamps, `schemaVersion` | —          |

## Record shapes (storage)

```jsonc
// organizations[]
{
  "id": "org_…", "name": "Acme Inc",
  "profile":   { "businessName", "addressLines": [], "taxId", "email", "phone", "website" },
  "branding":  { "logo": "data:…|null", "logoBackground": "light|dark" },
  "defaults":  { "currency": "$", "taxLabel": "IGST", "terms": "Net 15", "notes": "…bank details…" },
  "numbering": { "invoicePrefix": "INV-", "nextNumber": 260002 },
  "createdAt", "updatedAt", "archivedAt": null, "metadata": {}
}

// customers[]
{
  "id": "cust_…", "orgId": "org_…", "name",
  "email", "ccEmail", "taxId",
  "billingAddress":  { "lines": [] },
  "shippingAddress": { "lines": [] },   // empty → bill-to is reused
  "contacts": [],                       // future: many people per customer
  "createdAt", "updatedAt", "archivedAt": null, "metadata": {}
}

// items[]
{ "id": "item_…", "orgId", "name", "defaultRate", "defaultTaxPercent", "taxRateId": null,
  "createdAt", "updatedAt", "archivedAt": null, "metadata": {} }

// invoices[]
{
  "id": "inv_…", "orgId", "number": "INV-260001",
  "customerId": "cust_…",               // reference (navigation)
  "recurringScheduleId": null,
  "invoiceDate", "dueDate", "terms", "currency", "taxLabel",
  "snapshot": {                          // frozen at issue time (immutable)
    "seller":  { "businessName", "addressLines": [], "taxId", "logo", "logoBackground" },
    "billTo":  { "name", "addressLines": [], "taxId" },
    "shipTo":  { "addressLines": [] },
    "recipientEmail"
  },
  "lineItems": [ { "id", "description", "quantity", "rate", "taxPercent" } ],  // embedded value objects
  "amounts": { "subTotal", "taxTotal", "total" },
  "notes",
  "sentAt": null, "sentTo": null, "voidedAt": null,
  "pdf": { "file": "INV-260001.pdf", "updatedAt" },
  "createdAt", "updatedAt", "archivedAt": null, "metadata": {}
}

// payments[]  (the ledger — balanceDue & paid-status are derived from these)
{ "id": "pay_…", "orgId", "invoiceId", "amount", "currency",
  "mode": "Bank Transfer", "date", "reference", "note",
  "createdAt", "updatedAt", "archivedAt": null, "metadata": {} }

// recurringSchedules[]
{ "id": "rec_…", "orgId", "customerId", "active": true,
  "frequency": { "unit": "month", "interval": 1, "dayOfMonth": 1 },
  "nextRunDate", "lastGeneratedAt",
  "template": { "terms", "taxLabel", "notes", "lineItems": [] },
  "autoSend": false,
  "createdAt", "updatedAt", "archivedAt": null, "metadata": {} }

// activity[]
{ "id": "act_…", "orgId", "type": "invoice.sent", "refType": "invoice", "refId": "inv_…",
  "message", "at", "metadata": {} }
```

## API stays stable

The REST API and the frontend keep their existing flat shapes — the server maps between the
clean storage model and the API responses (e.g. `snapshot.seller.businessName` ↔ `business.name`,
`lineItems[].taxPercent` ↔ `items[].taxPct`, `taxId` ↔ `gstin`). This is the deliberate split
between a **persistence model** and an **API contract**: storage can be reshaped for the next
feature without breaking clients.

## Where new features plug in

- **Partial / installment payments, refunds, statements** → already: append to `payments`.
- **Credit notes, estimates/quotes** → new top-level collections sharing the same envelope.
- **Multiple contacts / addresses per customer** → `customers[].contacts`, more address objects.
- **Tax engine** → `taxRates` + `items[].taxRateId` + per-line `taxRateId`.
- **Attachments, comments, reminders** → new collections referencing `invoiceId`.
- **Audit trail / “who did what”** → already streaming into `activity`.
- **Per-org Gmail, users/teams, roles** → `integrations` per org, a `users` collection with `orgId`.
- **Custom fields anywhere** → the `metadata` object on every record.
