// Email subject/text/html builders for invoice sends and payment reminders.
// Both take the flat API-shaped invoice (from invoiceView() in index.js), not the
// stored record, so amounts/names arrive already resolved.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-07-28" → "28 July, 2026". Falls back to the raw string for odd values.
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}, ${m[1]}`;
}

// 2099 → "2,099.00"
function formatMoney(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared inline-styled wrapper — email clients ignore external CSS, so everything
// is inlined. Accent color matches --accent in public/styles.css.
const ACCENT = '#3a7afe';

function detailsTable(rows) {
  const tr = rows
    .map(
      ([label, value, bold]) => `
      <tr>
        <td style="padding:8px 16px;color:#6b7280;font-size:13px;white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:8px 16px;color:#111827;font-size:14px;${bold ? 'font-weight:700;' : ''}">${escapeHtml(value)}</td>
      </tr>`
    )
    .join('');
  return `
    <table cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;margin:16px 0;">
      ${tr}
    </table>`;
}

function wrapHtml(businessName, bodyHtml) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:8px 0;">
    <div style="border-top:3px solid ${ACCENT};padding-top:20px;">
      ${bodyHtml}
      <p style="font-size:14px;line-height:1.6;margin:24px 0 4px;">Regards,<br>
      <b>${escapeHtml(businessName)}</b></p>
    </div>
  </div>`;
}

// ── Invoice email ────────────────────────────────────────────
// view: invoiceView() output. Returns { subject, text, html }.
function invoiceEmail(org, view) {
  const business = org.profile.businessName;
  const cur = view.currency || '$';
  const amount = `${cur}${formatMoney(view.total)}`;
  const buyer = (view.billTo && view.billTo.name) || 'there';

  const subject = `Invoice ${view.number} from ${business}`;

  const text = [
    `Dear ${buyer} team,`,
    '',
    'Please find the attached invoice.',
    '',
    `Invoice amount: ${amount}`,
    `Invoice number: ${view.number}`,
    `Invoice date: ${formatDate(view.invoiceDate)}`,
    `Due date: ${formatDate(view.dueDate)}`,
    '',
    'Regards,',
    business,
  ].join('\n');

  const html = wrapHtml(
    business,
    `
    <p style="font-size:14px;line-height:1.6;margin:0 0 8px;">Dear ${escapeHtml(buyer)} team,</p>
    <p style="font-size:14px;line-height:1.6;margin:0;">Please find the attached invoice.</p>
    ${detailsTable([
      ['Invoice amount', amount, true],
      ['Invoice number', view.number],
      ['Invoice date', formatDate(view.invoiceDate)],
      ['Due date', formatDate(view.dueDate)],
    ])}
    <p style="font-size:13px;color:#6b7280;margin:0;">The invoice PDF is attached to this email.</p>`
  );

  return { subject, text, html };
}

// ── Reminder email ───────────────────────────────────────────
// daysLate: dueDate → today, negative = not yet due, 0 = due today, positive = overdue.
// Tone follows actual lateness at send time so catch-up sends after downtime read right.
function reminderEmail(org, view, daysLate) {
  const business = org.profile.businessName;
  const cur = view.currency || '$';
  const amount = `${cur}${formatMoney(view.balanceDue != null ? view.balanceDue : view.total)}`;
  const buyer = (view.billTo && view.billTo.name) || 'there';
  const due = formatDate(view.dueDate);

  let subject, timing;
  if (daysLate < 0) {
    const n = -daysLate;
    subject = `Reminder: invoice ${view.number} due in ${n} day${n === 1 ? '' : 's'} — ${business}`;
    timing = `This is a friendly reminder that the below invoice is due in ${n} day${n === 1 ? '' : 's'}.`;
  } else if (daysLate === 0) {
    subject = `Invoice DUE TODAY — ${view.number} from ${business}`;
    timing = 'This is to remind you that the below invoice is due today.';
  } else {
    subject = `OVERDUE: invoice ${view.number} from ${business}`;
    timing = `This is to remind you that the below invoice is overdue by ${daysLate} day${daysLate === 1 ? '' : 's'}.`;
  }

  const apology = 'If you have already paid, please accept our apologies and kindly ignore this payment reminder.';

  const text = [
    `Dear ${buyer},`,
    '',
    timing,
    '',
    `Invoice #  : ${view.number}`,
    `Due date   : ${due}`,
    `Amount     : ${amount}`,
    '',
    apology,
    '',
    'Regards,',
    business,
  ].join('\n');

  const html = wrapHtml(
    business,
    `
    <p style="font-size:14px;line-height:1.6;margin:0 0 8px;">Dear ${escapeHtml(buyer)},</p>
    <p style="font-size:14px;line-height:1.6;margin:0;">${escapeHtml(timing)}</p>
    ${detailsTable([
      ['Invoice #', view.number],
      ['Due date', due],
      ['Amount', amount, true],
    ])}
    <p style="font-size:13px;color:#6b7280;margin:0;">${escapeHtml(apology)}</p>`
  );

  return { subject, text, html };
}

// Branded HTML rendering of a user-edited plain-text message (already includes
// its own signature, so no wrapHtml footer here).
function plainHtml(text) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:8px 0;">
    <div style="border-top:3px solid ${ACCENT};padding-top:20px;font-size:14px;line-height:1.6;white-space:pre-line;">${escapeHtml(text)}</div>
  </div>`;
}

module.exports = { invoiceEmail, reminderEmail, plainHtml, formatDate };
