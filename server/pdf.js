// Server-side vector PDF renderer (pdfkit) that mirrors the on-screen invoice template.
// Vector text = crisp at any zoom and tiny files (no rasterization / no JPEG blur).
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

// ── palette (matches styles.css) ─────────────────────────────
const NAVY = '#2e3340';
const INK = '#2b2b2b';
const BODY = '#444444';
const GRAY = '#6b6b6b';
const LINE = '#ececec';
const GREEN = '#1f9d63';
const HEADER_BG = '#3c3c3c';
const BAL_BG = '#f0f0f0';

const PAGE_W = 595.28;
const M = 44;                 // page margin
const RIGHT = PAGE_W - M;
const CW = RIGHT - M;         // content width

function money(n, cur) {
  return (cur || '$') + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function plain(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  const p = (x) => String(x).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}
function parseLogo(url) {
  // Returns { kind:'raster', buf } for png/jpeg, { kind:'svg', svg } for SVG, else null.
  if (!url) return null;
  let m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(url);
  if (m) return { kind: 'raster', buf: Buffer.from(m[2], 'base64') };
  m = /^data:image\/svg\+xml;base64,(.+)$/i.exec(url);
  if (m) return { kind: 'svg', svg: Buffer.from(m[1], 'base64').toString('utf8') };
  m = /^data:image\/svg\+xml,(.+)$/i.exec(url);
  if (m) return { kind: 'svg', svg: decodeURIComponent(m[1]) };
  return null;
}

function renderInvoicePdf(inv, settings) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const cur = inv.currency || '$';
      const taxLabel = inv.taxLabel || 'IGST';
      const logoUrl = (inv.business && inv.business.logo) || (settings && settings.logo) || null;
      const logoBg = ((inv.business && inv.business.logo) ? inv.business.logoBg : (settings && settings.logoBg)) || 'light';

      // ── Header: logo box ───────────────────────────────────
      const boxW = 156, boxH = 70, topY = 46;
      const logo = logoUrl ? parseLogo(logoUrl) : null;
      if (logoBg === 'dark') {
        doc.roundedRect(M, topY, boxW, boxH, 12).fill(NAVY);
      } else {
        doc.roundedRect(M, topY, boxW, boxH, 12).fillAndStroke('#ffffff', '#e7e7e7');
      }
      if (logo && logo.kind === 'raster') {
        try { doc.image(logo.buf, M + 10, topY + 10, { fit: [boxW - 20, boxH - 20], align: 'center', valign: 'center' }); }
        catch (e) { drawTextLogo(); }
      } else if (logo && logo.kind === 'svg') {
        try { SVGtoPDF(doc, logo.svg, M + 10, topY + 10, { width: boxW - 20, height: boxH - 20, preserveAspectRatio: 'xMidYMid meet' }); }
        catch (e) { drawTextLogo(); }
      } else {
        drawTextLogo();
      }
      function drawTextLogo() {
        const name = ((inv.business && inv.business.name) || 'Acme').toLowerCase();
        const txtColor = logoBg === 'dark' ? '#ffffff' : NAVY;
        // small accent diamond
        const cx = M + 30, cy = topY + boxH / 2;
        doc.save().fillColor('#c9d14a')
          .moveTo(cx, cy - 6).lineTo(cx + 6, cy).lineTo(cx, cy + 6).lineTo(cx - 6, cy).fill().restore();
        doc.fillColor(txtColor).font('Helvetica-Bold').fontSize(26)
          .text(name, M + 40, cy - 13, { width: boxW - 48, lineBreak: false });
      }

      // ── Header: title + balance (right) ────────────────────
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text('TAX INVOICE', M, topY + 2, { width: CW, align: 'right' });
      doc.fillColor('#555555').font('Helvetica').fontSize(9.5).text('# ' + inv.number, M, topY + 30, { width: CW, align: 'right' });
      doc.fillColor('#555555').font('Helvetica').fontSize(9).text('Balance Due', M, topY + 50, { width: CW, align: 'right' });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(money(inv.balanceDue, cur), M, topY + 61, { width: CW, align: 'right' });

      let y = topY + boxH + 20;

      // ── From block ─────────────────────────────────────────
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text((inv.business && inv.business.name) || '', M, y);
      y = doc.y;
      doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
      for (const ln of (inv.business && inv.business.addressLines) || []) { doc.text(ln, M, doc.y); }
      if (inv.business && inv.business.gstin) doc.text('GSTIN: ' + inv.business.gstin, M, doc.y);
      y = doc.y + 18;

      // ── Parties: Bill To (left) / Ship To (right) ──────────
      const colW = CW / 2 - 10;
      const rightColX = M + CW / 2 + 10;
      const partyTop = y;
      // Bill To
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Bill To', M, partyTop, { width: colW });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text((inv.billTo && inv.billTo.name) || '', M, doc.y, { width: colW });
      doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
      for (const ln of (inv.billTo && inv.billTo.addressLines) || []) doc.text(ln, M, doc.y, { width: colW });
      if (inv.billTo && inv.billTo.gstin) doc.text('GSTIN: ' + inv.billTo.gstin, M, doc.y, { width: colW });
      const leftBottom = doc.y;
      // Ship To
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Ship To', rightColX, partyTop, { width: colW });
      doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
      for (const ln of (inv.shipTo && inv.shipTo.addressLines) || []) doc.text(ln, rightColX, doc.y, { width: colW });
      const rightBottom = doc.y;

      y = Math.max(leftBottom, rightBottom) + 18;

      // ── Dates strip (bordered, 3 cells) ────────────────────
      const dH = 38;
      doc.roundedRect(M, y, CW, dH, 6).lineWidth(1).strokeColor(LINE).stroke();
      const cells = [['Invoice Date', fmtDate(inv.invoiceDate)], ['Terms', inv.terms || ''], ['Due Date', fmtDate(inv.dueDate)]];
      const cellW = CW / 3;
      cells.forEach((c, i) => {
        const cx = M + i * cellW;
        if (i > 0) doc.moveTo(cx, y).lineTo(cx, y + dH).strokeColor(LINE).stroke();
        doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(c[0].toUpperCase(), cx + 12, y + 8, { width: cellW - 20 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(c[1], cx + 12, y + 20, { width: cellW - 20 });
      });
      y += dH + 22;

      // ── Items table ────────────────────────────────────────
      // Column geometry (right-aligned numeric columns).
      const amountX = RIGHT - 74, amountW = 74;
      const taxX = amountX - 56, taxW = 56;
      const rateX = taxX - 74, rateW = 74;
      const qtyX = rateX - 46, qtyW = 46;
      const numX = M, numW = 20;
      const descX = M + 24, descW = qtyX - (M + 24) - 6;

      const headH = 24;
      doc.rect(M, y, CW, headH).fill(HEADER_BG);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      const headY = y + 7.5;
      doc.text('#', numX + 6, headY, { width: numW });
      doc.text('Item & Description', descX, headY, { width: descW });
      doc.text('Qty', qtyX, headY, { width: qtyW, align: 'right' });
      doc.text('Rate', rateX, headY, { width: rateW, align: 'right' });
      doc.text(taxLabel, taxX, headY, { width: taxW, align: 'right' });
      doc.text('Amount', amountX, headY, { width: amountW, align: 'right' });
      y += headH;

      (inv.items || []).forEach((it, i) => {
        const qty = Number(it.qty) || 0, rate = Number(it.rate) || 0, taxPct = Number(it.taxPct) || 0;
        const amount = qty * rate, tax = amount * (taxPct / 100);
        doc.font('Helvetica').fontSize(9.5).fillColor('#3a3a3a');
        const descH = doc.heightOfString(it.description || '', { width: descW });
        const rowH = Math.max(descH, 14) + 14;
        const ty = y + 7;
        doc.fillColor('#3a3a3a').text(String(i + 1), numX + 6, ty, { width: numW });
        doc.text(it.description || '', descX, ty, { width: descW });
        doc.text(plain(qty), qtyX, ty, { width: qtyW, align: 'right' });
        doc.text(plain(rate), rateX, ty, { width: rateW, align: 'right' });
        doc.text(plain(tax), taxX, ty, { width: taxW, align: 'right' });
        doc.fillColor('#888888').fontSize(8).text(taxPct + '%', taxX, ty + 12, { width: taxW, align: 'right' });
        doc.fillColor('#3a3a3a').fontSize(9.5).text(plain(amount), amountX, ty, { width: amountW, align: 'right' });
        // row divider
        doc.moveTo(M, y + rowH).lineTo(RIGHT, y + rowH).lineWidth(1).strokeColor(LINE).stroke();
        y += rowH;
      });

      // ── Totals (right box) ─────────────────────────────────
      y += 6;
      const tBoxW = 250, tBoxX = RIGHT - tBoxW;
      const trow = (label, val, opts = {}) => {
        const h = 22;
        if (opts.bg) doc.rect(tBoxX, y, tBoxW, h).fill(opts.bg);
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 11 : 9.5).fillColor(opts.bg ? INK : (opts.bold ? INK : '#555555'));
        doc.text(label, tBoxX + 10, y + 6.5, { width: tBoxW / 2 - 10 });
        doc.fillColor(INK).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(val, tBoxX + tBoxW / 2, y + 6.5, { width: tBoxW / 2 - 10, align: 'right' });
        y += h;
      };
      trow('Sub Total', plain(inv.subTotal));
      trow(`${taxLabel}0 (0%)`, plain(inv.taxTotal));
      trow('Total', money(inv.total, cur), { bold: true });
      trow('Balance Due', money(inv.balanceDue, cur), { bold: true, bg: BAL_BG });

      // ── Amount in words ────────────────────────────────────
      y += 14;
      const wlW = 84;
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Total In Words:', tBoxX, y, { width: wlW });
      doc.fillColor(INK).font('Helvetica-BoldOblique').fontSize(9.5)
        .text(inv.amountInWords || '', tBoxX + wlW + 6, y, { width: tBoxW - wlW - 6 });
      y = doc.y + 22;

      // ── Notes ──────────────────────────────────────────────
      if (inv.notes) {
        doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Notes', M, y);
        doc.fillColor(BODY).font('Helvetica').fontSize(9).text(inv.notes, M, doc.y + 2, { width: CW * 0.72, lineGap: 1.5 });
        y = doc.y + 16;
      }
      if (inv.payment) {
        doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Payment received', M, y);
        const p = inv.payment;
        const txt = `Mode: ${p.mode}\nDate: ${fmtDate(p.date)}${p.reference ? '\nReference: ' + p.reference : ''}\nAmount: ${money(p.amount, cur)}`;
        doc.fillColor(BODY).font('Helvetica').fontSize(9).text(txt, M, doc.y + 2, { width: CW * 0.72, lineGap: 1.5 });
        y = doc.y + 16;
      }

      // ── PAID stamp ─────────────────────────────────────────
      if (inv.status === 'paid') {
        doc.save();
        const sx = RIGHT - 150, sy = topY + 96;
        doc.rotate(-14, { origin: [sx + 60, sy + 18] });
        doc.lineWidth(2.5).roundedRect(sx, sy, 120, 40, 6).strokeColor(GREEN).stroke();
        doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(26).text('PAID', sx, sy + 7, { width: 120, align: 'center' });
        doc.restore();
      }

      // ── Footer ─────────────────────────────────────────────
      const footY = 800;
      doc.moveTo(M, footY).lineTo(RIGHT, footY).lineWidth(1).strokeColor('#eeeeee').stroke();
      doc.fillColor('#9a9a9a').font('Helvetica').fontSize(9).text('Thank you for your business.', M, footY + 8, { width: CW, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderInvoicePdf };
