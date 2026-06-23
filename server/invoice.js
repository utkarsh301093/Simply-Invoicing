// Shared invoice math + number-to-words. Used by the API and the recurring engine.

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function computeTotals(items) {
  let subTotal = 0;
  let taxTotal = 0;
  for (const it of items || []) {
    const qty = Number(it.qty) || 0;
    const rate = Number(it.rate) || 0;
    const taxPct = Number(it.taxPct) || 0;
    const amount = qty * rate;
    subTotal += amount;
    taxTotal += amount * (taxPct / 100);
  }
  subTotal = round2(subTotal);
  taxTotal = round2(taxTotal);
  return { subTotal, taxTotal, total: round2(subTotal + taxTotal) };
}

// "1488.62" -> "United States Dollar One Thousand Four Hundred Eighty-Eight and Sixty-Two Cents"
const ONES = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
  'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const TENS = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];

function threeDigitsToWords(n) {
  let words = [];
  if (n >= 100) {
    words.push(ONES[Math.floor(n / 100)], 'Hundred');
    n %= 100;
  }
  if (n >= 20) {
    const t = TENS[Math.floor(n / 10)];
    const o = n % 10;
    words.push(o ? `${t}-${ONES[o]}` : t);
  } else if (n > 0) {
    words.push(ONES[n]);
  }
  return words.join(' ');
}

function intToWords(n) {
  if (n === 0) return 'Zero';
  const groups = ['', 'Thousand', 'Million', 'Billion'];
  let parts = [];
  let g = 0;
  while (n > 0) {
    const chunk = n % 1000;
    if (chunk) {
      const label = groups[g] ? ' ' + groups[g] : '';
      parts.unshift(threeDigitsToWords(chunk) + label);
    }
    n = Math.floor(n / 1000);
    g++;
  }
  return parts.join(' ');
}

function amountToWords(amount, currencyWord = 'United States Dollar', centWord = 'Cents') {
  const sign = amount < 0 ? 'Minus ' : '';
  amount = Math.abs(round2(amount));
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);
  let out = `${sign}${currencyWord} ${intToWords(dollars)}`;
  if (cents > 0) out += ` and ${intToWords(cents)} ${centWord}`;
  return out;
}

module.exports = { round2, computeTotals, amountToWords };
