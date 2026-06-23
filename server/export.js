// Excel (.xlsx) export builder. Pure function of already-mapped API rows — no store
// coupling — so it's easy to test and to extend with more sheets.
const ExcelJS = require('exceljs');

const HEADER_BG = 'FF2E3340'; // navy, matches the app
const MONEY_FMT = '#,##0.00';
const DATE_FMT = 'dd/mm/yyyy';

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function toDate(s) { if (!s) return null; const d = new Date(s + 'T00:00:00'); return isNaN(d) ? s : d; }

// Add a styled worksheet: bold navy header, frozen + auto-filtered first row.
function addSheet(wb, name, columns, rows, opts = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  rows.forEach((r) => ws.addRow(r));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  if (opts.totalRow) {
    const row = ws.addRow(opts.totalRow);
    row.font = { bold: true };
    row.eachCell((c) => { c.border = { top: { style: 'thin', color: { argb: 'FFCCCCCC' } } }; });
  }
  return ws;
}

function addInvoices(wb, invoices, cur) {
  const columns = [
    { header: 'Invoice #', key: 'number', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Customer', key: 'customer', width: 28 },
    { header: 'Invoice Date', key: 'invoiceDate', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Due Date', key: 'dueDate', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Currency', key: 'currency', width: 9 },
    { header: 'Sub Total', key: 'subTotal', width: 13, style: { numFmt: MONEY_FMT } },
    { header: 'Tax', key: 'taxTotal', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Total', key: 'total', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Amount Paid', key: 'amountPaid', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Balance Due', key: 'balanceDue', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Sent To', key: 'sentTo', width: 26 },
  ];
  const rows = invoices.map((inv) => ({
    number: inv.number, status: cap(inv.status), customer: (inv.billTo && inv.billTo.name) || '',
    invoiceDate: toDate(inv.invoiceDate), dueDate: toDate(inv.dueDate), currency: inv.currency || cur,
    subTotal: inv.subTotal, taxTotal: inv.taxTotal, total: inv.total,
    amountPaid: inv.amountPaid || 0, balanceDue: inv.balanceDue, sentTo: inv.sentTo || '',
  }));
  const sum = (k) => invoices.reduce((s, i) => s + (Number(i[k]) || 0), 0);
  const totalRow = invoices.length
    ? { number: `Total (${invoices.length})`, total: sum('total'), amountPaid: sum('amountPaid'), balanceDue: sum('balanceDue') }
    : null;
  addSheet(wb, 'Invoices', columns, rows, { totalRow });
}

function addCustomers(wb, customers) {
  const columns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Cc Email', key: 'ccEmail', width: 24 },
    { header: 'GSTIN / Tax ID', key: 'gstin', width: 20 },
    { header: 'Billing Address', key: 'billing', width: 44 },
    { header: 'Ship-To Address', key: 'shipping', width: 44 },
  ];
  const rows = customers.map((c) => ({
    name: c.name, email: c.email || '', ccEmail: c.ccEmail || '', gstin: c.gstin || '',
    billing: (c.billingAddressLines || []).join(', '),
    shipping: (c.shipToAddressLines || []).join(', '),
  }));
  addSheet(wb, 'Customers', columns, rows);
}

function addItems(wb, items, cur) {
  const columns = [
    { header: 'Item', key: 'name', width: 36 },
    { header: `Default Rate (${cur})`, key: 'rate', width: 18, style: { numFmt: MONEY_FMT } },
    { header: 'Default Tax %', key: 'taxPct', width: 14 },
  ];
  const rows = items.map((i) => ({ name: i.name, rate: i.rate, taxPct: i.taxPct }));
  addSheet(wb, 'Items', columns, rows);
}

async function buildWorkbook({ datasets, invoices, customers, items, settings }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = (settings && settings.businessName) || 'Simple Invoicing Tool';
  wb.created = new Date();
  const cur = (settings && settings.currency) || '$';
  if (datasets.includes('invoices')) addInvoices(wb, invoices || [], cur);
  if (datasets.includes('customers')) addCustomers(wb, customers || []);
  if (datasets.includes('items')) addItems(wb, items || [], cur);
  // Always leave at least one sheet so the file is valid.
  if (wb.worksheets.length === 0) wb.addWorksheet('Export');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildWorkbook };
