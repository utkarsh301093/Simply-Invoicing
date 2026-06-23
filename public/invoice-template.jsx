// InvoiceDocument — renders an invoice that visually matches the Zoho-style PDF.
// Also exposes window.generateInvoicePdf(node) -> { blob, base64 } for download/email.
const { useRef } = React;

function money(n, cur) {
  const v = Number(n || 0);
  return (cur || '$') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function plain(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function AddrLines({ lines }) {
  return (lines || []).map((l, i) => <div className="line" key={i}>{l}</div>);
}

function InvoiceDocument({ inv, innerRef, settings }) {
  if (!inv) return null;
  const cur = inv.currency || '$';
  const taxLabel = inv.taxLabel || 'IGST';
  // Logo is branding, not transactional: fall back to the current logo when an
  // older invoice was created before one was uploaded.
  const logo = inv.business?.logo || (settings && settings.logo) || null;
  const logoBg = (inv.business?.logo ? inv.business?.logoBg : (settings && settings.logoBg)) || inv.business?.logoBg || 'light';
  return (
    <div className="invoice" ref={innerRef}>
      {inv.status === 'paid' && <div className="inv-paid-stamp">PAID</div>}

      <div className="inv-top">
        <div className={'inv-logo ' + (logoBg === 'dark' ? 'dark' : 'light')}>
          {logo
            ? <img className="inv-logo-img" src={logo} alt="logo" />
            : <><span className="star">✦</span><span className="lt">{(inv.business?.name || 'Acme').toLowerCase()}</span></>}
        </div>
        <div className="inv-title">
          <div className="h">TAX INVOICE</div>
          <div className="num"># {inv.number}</div>
          <div className="inv-bal">
            <div className="lbl">Balance Due</div>
            <div className="amt">{money(inv.balanceDue, cur)}</div>
          </div>
        </div>
      </div>

      <div className="inv-from">
        <div className="name">{inv.business?.name}</div>
        <AddrLines lines={inv.business?.addressLines} />
        {inv.business?.gstin && <div className="line">GSTIN: {inv.business.gstin}</div>}
      </div>

      <div className="inv-parties">
        <div className="party">
          <div className="party-label">Bill To</div>
          <div className="name">{inv.billTo?.name}</div>
          <AddrLines lines={inv.billTo?.addressLines} />
          {inv.billTo?.gstin && <div className="line">GSTIN: {inv.billTo.gstin}</div>}
        </div>
        <div className="party">
          <div className="party-label">Ship To</div>
          <AddrLines lines={inv.shipTo?.addressLines} />
        </div>
      </div>

      <div className="inv-dates">
        <div className="dcell"><span className="dk">Invoice Date</span><span className="dv">{fmtDate(inv.invoiceDate)}</span></div>
        <div className="dcell"><span className="dk">Terms</span><span className="dv">{inv.terms}</span></div>
        <div className="dcell"><span className="dk">Due Date</span><span className="dv">{fmtDate(inv.dueDate)}</span></div>
      </div>

      <table className="items">
        <thead>
          <tr>
            <th className="l" style={{ width: 26 }}>#</th>
            <th className="l">Item &amp; Description</th>
            <th style={{ width: 60 }}>Qty</th>
            <th style={{ width: 90 }}>Rate</th>
            <th style={{ width: 80 }}>{taxLabel}</th>
            <th style={{ width: 90 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {(inv.items || []).map((it, i) => {
            const amount = (Number(it.qty) || 0) * (Number(it.rate) || 0);
            const tax = amount * ((Number(it.taxPct) || 0) / 100);
            return (
              <tr key={i}>
                <td className="l">{i + 1}</td>
                <td className="l">{it.description}</td>
                <td>{plain(it.qty)}</td>
                <td>{plain(it.rate)}</td>
                <td>{plain(tax)}<div className="sub">{(Number(it.taxPct) || 0)}%</div></td>
                <td>{plain(amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="inv-totals">
        <div className="box">
          <div className="trow"><span className="tk">Sub Total</span><span className="tv">{plain(inv.subTotal)}</span></div>
          <div className="trow"><span className="tk">{taxLabel}0 (0%)</span><span className="tv">{plain(inv.taxTotal)}</span></div>
          <div className="trow grand"><span className="tk">Total</span><span className="tv">{money(inv.total, cur)}</span></div>
          <div className="trow balance"><span className="tk">Balance Due</span><span className="tv">{money(inv.balanceDue, cur)}</span></div>
        </div>
      </div>

      <div className="inwords">
        <div className="wrap">
          <div className="wl">Total In Words:</div>
          <div className="wv">{inv.amountInWords}</div>
        </div>
      </div>

      {inv.notes && (
        <div className="inv-notes">
          <div className="nt">Notes</div>
          <pre>{inv.notes}</pre>
        </div>
      )}

      {inv.payment && (
        <div className="inv-notes" style={{ marginTop: 20 }}>
          <div className="nt">Payment received</div>
          <pre>{`Mode: ${inv.payment.mode}\nDate: ${fmtDate(inv.payment.date)}${inv.payment.reference ? '\nReference: ' + inv.payment.reference : ''}\nAmount: ${money(inv.payment.amount, cur)}`}</pre>
        </div>
      )}

      <div className="inv-foot">Thank you for your business.</div>
    </div>
  );
}

// NOTE: PDFs are rendered server-side as vector text (see server/pdf.js) for crisp
// output and local storage. This component is only the on-screen preview.
window.InvoiceDocument = InvoiceDocument;
window.invFmtDate = fmtDate;
window.invMoney = money;
