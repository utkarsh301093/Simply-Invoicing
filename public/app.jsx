const { useState, useEffect, useRef, useCallback } = React;

// ── Session ──────────────────────────────────────────────────
// The server proxies sign-in, so there is no Supabase key in this file — only a
// short-lived user token. Stored in localStorage so a reload keeps you signed in.
const SESSION_KEY = 'inv_session';

const session = {
  get() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  },
  set(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
    _onSessionChange(s);
  },
  token() { const s = session.get(); return s && s.accessToken; },
};
let _onSessionChange = () => {};

// Refresh once, and share the in-flight attempt so a burst of parallel 401s
// does not fire N refreshes (which would invalidate each other's refresh token).
let refreshing = null;
async function refreshSession() {
  const s = session.get();
  if (!s || !s.refreshToken) return null;
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((next) => { session.set(next); return next; })
      .catch(() => { session.set(null); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// ── Email-link callback ──────────────────────────────────────
// Supabase's magic-link and password-recovery emails redirect back here with the
// tokens in the URL *hash* (the default implicit flow), e.g.
//   #access_token=…&refresh_token=…&expires_at=…&type=recovery
// or, when the link is stale, #error=…&error_code=otp_expired. Nothing else reads
// that hash, so before this existed a clicked link just landed on the login page
// and left the user signed out — which is exactly the "leads back to sign in"
// symptom. We parse it once at boot, adopt the session, and scrub the hash so a
// refresh can't replay it and the tokens don't linger in the address bar.
function consumeAuthRedirect() {
  const raw = (window.location.hash || '').replace(/^#/, '');
  if (!raw) return {};
  const p = new URLSearchParams(raw);
  const errorCode = p.get('error_code') || p.get('error');
  const accessToken = p.get('access_token');
  if (!errorCode && !accessToken) return {};

  // Scrub regardless of outcome — the hash has served its purpose either way.
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch {}

  if (errorCode) {
    const desc = p.get('error_description') || 'That link is invalid or has expired. Please request a new one.';
    return { error: desc.replace(/\+/g, ' ') };
  }

  const type = p.get('type') || '';
  session.set({
    accessToken,
    refreshToken: p.get('refresh_token') || null,
    expiresAt: Number(p.get('expires_at')) || null,
    user: null, // filled lazily by /api/auth/me if anything needs it
  });
  // Recovery must land on "set a new password", not straight into the app.
  return { type, recovery: type === 'recovery' };
}
// Captured once at boot, below, before React mounts.
let _bootAuth = {};

// ── Passkeys ─────────────────────────────────────────────────
// supabase-js is used for exactly one thing: the WebAuthn ceremony, which has to
// run in the browser and whose HTTP API is beta. Everything else still goes
// through this app's own API.
//
// persistSession/autoRefreshToken are off on purpose. This app already owns the
// session (localStorage + /api/auth/refresh); letting the SDK keep its own copy
// would create two sources of truth that drift apart on sign-out.
let _sbPromise = null;

function supabaseClient() {
  if (!_sbPromise) {
    _sbPromise = (async () => {
      const cfg = await (await fetch('/api/config')).json();
      if (!cfg.passkeys) return null;
      if (!window.supabase || !window.supabase.createClient) return null;
      return window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: {
          experimental: { passkey: true },
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    })().catch(() => null);
  }
  return _sbPromise;
}

// Supabase session shape -> this app's shape.
function sessionFromSupabase(s) {
  if (!s || !s.access_token) return null;
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: s.expires_at,
    user: s.user ? { id: s.user.id, email: s.user.email } : null,
  };
}

// Passkey management needs the SDK to hold the current session. Ours is the
// authority, so push it in rather than having the SDK fetch its own.
async function supabaseWithSession() {
  const sb = await supabaseClient();
  if (!sb) throw new Error('Passkeys are not configured');
  const s = session.get();
  if (!s || !s.accessToken) throw new Error('Please sign in first');
  await sb.auth.setSession({ access_token: s.accessToken, refresh_token: s.refreshToken });
  return sb;
}

// WebAuthn failures are mostly user actions (cancelled the prompt) rather than
// faults, so they get a plain message instead of a scary one.
function passkeyErrorMessage(e) {
  const msg = (e && e.message) || String(e);
  if (/NotAllowedError|abort/i.test(msg)) return 'Passkey prompt was cancelled';
  if (/not support/i.test(msg)) return 'This browser does not support passkeys';
  if (/no credentials|not found/i.test(msg)) return 'No passkey found for this site on this device';
  // "Failed to fetch" is what a browser reports for any network-level failure —
  // service unreachable, CORS, DNS. Meaningless to a user on its own.
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the passkey service. Check your connection and try again.';
  }
  if (/SecurityError|relying party|rp id/i.test(msg)) {
    return 'Passkeys are not configured for this domain.';
  }
  return msg;
}

// ── API helper ───────────────────────────────────────────────
async function api(path, opts = {}, _retried) {
  const token = session.token();
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));

  // An expired token is recoverable: refresh once and replay. Anything else
  // 401 means the session is genuinely gone, so drop it and show the login.
  if (res.status === 401 && !_retried) {
    if (data.expired && (await refreshSession())) return api(path, opts, true);
    session.set(null);
    throw new Error(data.error || 'Please sign in');
  }
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

// ── Toast ────────────────────────────────────────────────────
let _setToast = () => {};
function toast(msg, isErr) { _setToast({ msg, isErr, t: Date.now() }); }

// ── Small helpers ────────────────────────────────────────────
const PAYMENT_MODES = ['Bank Transfer', 'ACH', 'Wire', 'UPI', 'Credit Card', 'Cash', 'Cheque', 'PayPal', 'Other'];
const today = () => new Date().toISOString().slice(0, 10);
function netDays(terms) { const m = /net\s*(\d+)/i.exec(terms || ''); return m ? Number(m[1]) : 15; }
function addDays(dateStr, days) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function linesToText(a) { return (a || []).join('\n'); }
function textToLines(t) { return (t || '').split('\n').map((s) => s.trim()).filter(Boolean); }
function computeTotals(items) {
  let sub = 0, tax = 0;
  for (const it of items) { const a = (+it.qty || 0) * (+it.rate || 0); sub += a; tax += a * ((+it.taxPct || 0) / 100); }
  const r = (n) => Math.round(n * 100) / 100;
  return { subTotal: r(sub), taxTotal: r(tax), total: r(sub + tax) };
}
function isOverdue(inv) { return inv.status !== 'paid' && inv.dueDate && inv.dueDate < today(); }

// ── Icons (inline emoji-free glyphs) ─────────────────────────
const Ico = {
  dash: '◧', inv: '🧾', cust: '👥', prod: '📦', rec: '🔁', set: '⚙', plus: '＋', back: '‹', exp: '📤',
};

// Smart date-range presets (financial year is Apr–Mar). Each returns inclusive YYYY-MM-DD bounds.
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function datePresets() {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  const q = Math.floor(m / 3);
  const fyStartYear = m >= 3 ? y : y - 1; // FY begins in April
  const lastN = (days) => { const d = new Date(n); d.setDate(d.getDate() - (days - 1)); return d; };
  return [
    { key: 'this_month', label: 'This month', from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) },
    { key: 'last_month', label: 'Last month', from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) },
    { key: 'this_quarter', label: 'This quarter', from: ymd(new Date(y, q * 3, 1)), to: ymd(new Date(y, q * 3 + 3, 0)) },
    { key: 'last_quarter', label: 'Last quarter', from: ymd(new Date(y, q * 3 - 3, 1)), to: ymd(new Date(y, q * 3, 0)) },
    { key: 'this_fy', label: 'This financial year (Apr–Mar)', from: ymd(new Date(fyStartYear, 3, 1)), to: ymd(new Date(fyStartYear + 1, 2, 31)) },
    { key: 'last_fy', label: 'Last financial year', from: ymd(new Date(fyStartYear - 1, 3, 1)), to: ymd(new Date(fyStartYear, 2, 31)) },
    { key: 'this_year', label: 'This calendar year', from: ymd(new Date(y, 0, 1)), to: ymd(new Date(y, 11, 31)) },
    { key: 'ytd', label: 'Year to date', from: ymd(new Date(y, 0, 1)), to: ymd(n) },
    { key: 'last_30', label: 'Last 30 days', from: ymd(lastN(30)), to: ymd(n) },
    { key: 'last_90', label: 'Last 90 days', from: ymd(lastN(90)), to: ymd(n) },
    { key: 'last_12m', label: 'Last 12 months', from: ymd(new Date(y - 1, m, n.getDate())), to: ymd(n) },
    { key: 'all', label: 'All time', from: '', to: '' },
    { key: 'custom', label: 'Custom range…', from: '', to: '' },
  ];
}

// ── Login ────────────────────────────────────────────────────
function Login({ onSignedIn, initialError }) {
  // mode: 'password' (default) | 'forgot' (reset email) | 'magic' (sign-in link)
  const [mode, setMode] = useState('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(initialError || null);
  const [sent, setSent] = useState(null); // the "check your email" message, once shown
  const [passkeyReady, setPasskeyReady] = useState(false);

  // Only offer the passkey button if the project is configured for it AND the
  // browser can actually do WebAuthn — a dead button is worse than none.
  useEffect(() => {
    let alive = true;
    if (!window.PublicKeyCredential) return;
    supabaseClient().then((sb) => { if (alive) setPasskeyReady(Boolean(sb)); });
    return () => { alive = false; };
  }, []);

  const signInWithPasskey = async () => {
    setBusy(true); setErr(null);
    try {
      const sb = await supabaseClient();
      if (!sb) throw new Error('Passkeys are not configured');
      // Discoverable credential: the authenticator picks the account, so no
      // email is needed up front.
      const { data, error } = await sb.auth.signInWithPasskey();
      if (error) throw error;
      const s = sessionFromSupabase(data && data.session);
      if (!s) throw new Error('Passkey sign-in returned no session');
      session.set(s);
      onSignedIn(s);
    } catch (e2) {
      setErr(passkeyErrorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not sign in');
      session.set(data);
      onSignedIn(data);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  // Reset link and magic link share a shape: POST an email, then show the same
  // deliberately-vague confirmation whether or not the address has an account —
  // the server never reveals which, so neither can we.
  const sendEmailLink = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const path = mode === 'forgot' ? '/api/auth/recover' : '/api/auth/magiclink';
    try {
      await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setSent(
        mode === 'forgot'
          ? 'If an account exists for that address, a password-reset link is on its way. Check your email.'
          : 'If an account exists for that address, a sign-in link is on its way. Check your email.'
      );
    } catch (e2) {
      // A network failure is the only thing that can land here; the request
      // itself always 200s. Keep it plain.
      setErr('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const goMode = (m) => { setMode(m); setErr(null); setSent(null); };

  // After an email link is sent, the form is replaced by a confirmation.
  if (sent) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1 className="login-title">Simple Invoicing</h1>
          <div className="login-sent">{sent}</div>
          <button className="btn login-btn" type="button" onClick={() => goMode('password')}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'forgot' || mode === 'magic') {
    const isForgot = mode === 'forgot';
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={sendEmailLink}>
          <h1 className="login-title">Simple Invoicing</h1>
          <p className="muted small login-sub">
            {isForgot ? 'Reset your password' : 'Sign in with an email link'}
          </p>

          {err && <div className="login-error">{err}</div>}

          <label className="lbl">Email</label>
          <input className="inp" type="email" autoComplete="username" required autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />

          <button className="btn primary login-btn" type="submit" disabled={busy}>
            {busy ? <span className="spin"></span> : (isForgot ? 'Send reset link' : 'Send sign-in link')}
          </button>

          <button className="btn login-btn login-link" type="button" onClick={() => goMode('password')}>
            Back to sign in
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">Simple Invoicing</h1>
        <p className="muted small login-sub">Sign in to continue</p>

        {err && <div className="login-error">{err}</div>}

        <label className="lbl">Email</label>
        <input className="inp" type="email" autoComplete="username" required autoFocus
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />

        <label className="lbl">Password</label>
        <input className="inp" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />

        <button className="btn primary login-btn" type="submit" disabled={busy}>
          {busy ? <span className="spin"></span> : 'Sign in'}
        </button>

        <div className="login-alts">
          <button type="button" className="login-textlink" onClick={() => goMode('forgot')}>Forgot password?</button>
          <span className="login-dot">·</span>
          <button type="button" className="login-textlink" onClick={() => goMode('magic')}>Email me a link</button>
        </div>

        {passkeyReady && (
          <>
            <div className="login-or"><span>or</span></div>
            <button className="btn login-btn login-passkey" type="button" disabled={busy}
              onClick={signInWithPasskey}>
              <span aria-hidden="true">🔑</span> Sign in with a passkey
            </button>
          </>
        )}
      </form>
    </div>
  );
}

// ── Set a new password (after a recovery link) ───────────────
// Shown when a recovery link brought the user back: the hash carried a valid
// (recovery-scoped) session, which api() sends as the bearer, so POST
// /api/auth/password can update the password without any old-password check.
function ResetPassword({ onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 8) return setErr('Password must be at least 8 characters');
    if (pw !== pw2) return setErr('Passwords do not match');
    setBusy(true); setErr(null);
    try {
      await api('/auth/password', { method: 'POST', body: { password: pw } });
      toast('Password updated');
      onDone();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">Set a new password</h1>
        <p className="muted small login-sub">Choose a password to finish signing in.</p>

        {err && <div className="login-error">{err}</div>}

        <label className="lbl">New password</label>
        <input className="inp" type="password" autoComplete="new-password" required autoFocus
          value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" />

        <label className="lbl">Confirm password</label>
        <input className="inp" type="password" autoComplete="new-password" required
          value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="••••••••" />

        <button className="btn primary login-btn" type="submit" disabled={busy}>
          {busy ? <span className="spin"></span> : 'Save password'}
        </button>
      </form>
    </div>
  );
}

// ── Root: routes between login, the landing page, onboarding, and the app ───
function Root() {
  const [signedIn, setSignedIn] = useState(() => Boolean(session.token()));
  // A recovery link signs the user in (valid token) but must divert to the
  // set-password screen before the app proper.
  const [recovering, setRecovering] = useState(() => Boolean(_bootAuth.recovery));
  // api() clears the session on an unrecoverable 401; this bounces to the login
  // screen without every caller having to handle it.
  _onSessionChange = (s) => setSignedIn(Boolean(s && s.accessToken));

  const [screen, setScreen] = useState(() => localStorage.getItem('inv_screen') || 'landing');
  const [orgs, setOrgs] = useState(null);          // null = still loading
  const [currentOrgId, setCurrentOrgId] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  _setToast = setToastMsg;

  const loadOrgs = useCallback(async () => {
    const d = await api('/orgs');
    setOrgs(d.orgs); setCurrentOrgId(d.currentOrgId);
    return d;
  }, []);
  useEffect(() => {
    if (!signedIn) { setOrgs(null); return; }
    loadOrgs().catch((e) => { setOrgs([]); toast(e.message, true); });
  }, [loadOrgs, signedIn]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3200);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const goScreen = (s) => { localStorage.setItem('inv_screen', s); setScreen(s); };

  const switchOrg = async (id) => {
    if (id === currentOrgId) return;
    try {
      await api('/orgs/' + id + '/activate', { method: 'POST' });
      setCurrentOrgId(id); // changes <App> key → remounts and reloads that org's data
      const o = (orgs || []).find((x) => x.id === id);
      toast('Switched to ' + (o ? o.name : 'organization'));
    } catch (e) { toast(e.message, true); }
  };

  const onboarded = async (org) => {
    await loadOrgs();
    setCurrentOrgId(org.id);
    goScreen('app');
  };

  const toastNode = toastMsg && <div className={'toast' + (toastMsg.isErr ? ' err' : '')}>{toastMsg.msg}</div>;

  const signOut = () => {
    session.set(null);
    localStorage.removeItem('inv_screen');
    setScreen('landing');
  };

  // A recovery link takes precedence over everything: finish setting the password
  // before the app loads. On success the session is already valid, so we just
  // drop the diversion and fall through.
  if (recovering) return <>{<ResetPassword onDone={() => setRecovering(false)} />}{toastNode}</>;

  if (!signedIn) return <>{<Login onSignedIn={() => setSignedIn(true)} initialError={_bootAuth.error} />}{toastNode}</>;

  if (orgs === null) return <div className="loading-screen">Loading…</div>;

  // The app needs an org to work in; without one, force onboarding.
  let view;
  if (screen === 'app' && orgs.length === 0) {
    view = <Onboarding first onDone={onboarded} onCancel={() => goScreen('landing')} />;
  } else if (screen === 'landing') {
    view = <LandingPage onGo={() => goScreen(orgs.length ? 'app' : 'onboarding')} />;
  } else if (screen === 'onboarding') {
    view = <Onboarding first={orgs.length === 0} onDone={onboarded} onCancel={() => goScreen(orgs.length ? 'app' : 'landing')} />;
  } else {
    view = <App key={currentOrgId} orgs={orgs} currentOrgId={currentOrgId}
      onSwitchOrg={switchOrg} onAddOrg={() => goScreen('onboarding')} onExit={() => goScreen('landing')}
      onSignOut={signOut} />;
  }
  return <>{view}{toastNode}</>;
}

// ── Authenticated app shell (scoped to the active org) ───────
function App({ orgs, currentOrgId, onSwitchOrg, onAddOrg, onExit, onSignOut }) {
  const [page, setPage] = useState('dashboard');
  const [openInvoiceId, setOpenInvoiceId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [recurring, setRecurring] = useState([]);
  const [gstatus, setGstatus] = useState({ configured: false, connected: false });

  const reload = useCallback(async () => {
    try {
      const [s, c, p, i, r, g] = await Promise.all([
        api('/settings'), api('/customers'), api('/products'), api('/invoices'), api('/recurring'), api('/google/status'),
      ]);
      setSettings(s); setCustomers(c); setProducts(p); setInvoices(i); setRecurring(r); setGstatus(g);
    } catch (e) { toast(e.message, true); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const go = (p) => { setOpenInvoiceId(null); setPage(p); };
  const openInvoice = (id) => { setOpenInvoiceId(id); setPage('invoice-detail'); };

  if (!settings) return <div style={{ padding: 40 }} className="muted">Loading…</div>;

  return (
    <div className="app">
      <Sidebar page={page} go={go} settings={settings}
        orgs={orgs} currentOrgId={currentOrgId} onSwitchOrg={onSwitchOrg} onAddOrg={onAddOrg} onExit={onExit}
        onSignOut={onSignOut} />
      <div className="main">
        {page === 'dashboard' && <Dashboard invoices={invoices} customers={customers} settings={settings} openInvoice={openInvoice} go={go} />}
        {page === 'invoices' && <InvoicesPage invoices={invoices} customers={customers} products={products} settings={settings} reload={reload} openInvoice={openInvoice} />}
        {page === 'invoice-detail' && <InvoiceDetail id={openInvoiceId} settings={settings} gstatus={gstatus} reload={reload} back={() => go('invoices')} />}
        {page === 'customers' && <CustomersPage customers={customers} settings={settings} reload={reload} />}
        {page === 'products' && <ProductsPage products={products} settings={settings} reload={reload} />}
        {page === 'recurring' && <RecurringPage recurring={recurring} customers={customers} products={products} settings={settings} reload={reload} openInvoice={openInvoice} />}
        {page === 'settings' && <SettingsPage settings={settings} gstatus={gstatus} reload={reload} />}
      </div>
    </div>
  );
}

function Sidebar({ page, go, settings, orgs, currentOrgId, onSwitchOrg, onAddOrg, onExit, onSignOut }) {
  const businessName = settings.businessName;
  const items = [
    ['dashboard', Ico.dash, 'Dashboard'],
    ['invoices', Ico.inv, 'Invoices'],
    ['customers', Ico.cust, 'Customers'],
    ['products', Ico.prod, 'Items'],
    ['recurring', Ico.rec, 'Recurring'],
    ['settings', Ico.set, 'Settings'],
  ];
  const isActive = (p) => page === p || (p === 'invoices' && page === 'invoice-detail');
  return (
    <div className="sidebar">
      <OrgSwitcher businessName={businessName} orgs={orgs} currentOrgId={currentOrgId}
        onSwitchOrg={onSwitchOrg} onAddOrg={onAddOrg} onExit={onExit} onSignOut={onSignOut} />
      {items.map(([p, ico, label]) => (
        <div key={p} className={'nav-item' + (isActive(p) ? ' active' : '')} onClick={() => go(p)}>
          <span className="ico">{ico}</span>{label}
        </div>
      ))}
      <div className="sidebar-foot">Simple Invoicing Tool</div>
    </div>
  );
}

function Topbar({ title, sub, actions }) {
  return (
    <div className="topbar">
      <div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
      <div style={{ display: 'flex', gap: 10 }}>{actions}</div>
    </div>
  );
}

// ── Dashboard ────────────────────────────────────────────────
function Dashboard({ invoices, customers, settings, openInvoice, go }) {
  const cur = settings.currency || '$';
  const outstanding = invoices.filter((i) => i.status !== 'paid').reduce((s, i) => s + (i.balanceDue || 0), 0);
  const paid = invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + (i.total || 0), 0);
  const overdue = invoices.filter(isOverdue).length;
  const recent = invoices.slice(0, 6);
  return (
    <>
      <Topbar title="Dashboard" sub={`${settings.businessName} · ${customers.length} customers`} />
      <div className="content">
        <div className="stats">
          <div className="stat"><div className="k">Outstanding</div><div className="v">{window.invMoney(outstanding, cur)}</div></div>
          <div className="stat"><div className="k">Collected</div><div className="v" style={{ color: 'var(--green)' }}>{window.invMoney(paid, cur)}</div></div>
          <div className="stat"><div className="k">Invoices</div><div className="v">{invoices.length}</div></div>
          <div className="stat"><div className="k">Overdue</div><div className="v" style={{ color: overdue ? 'var(--red)' : 'inherit' }}>{overdue}</div></div>
        </div>
        <div className="card">
          <div className="card-pad" style={{ paddingBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="section-title" style={{ margin: 0 }}>Recent invoices</h2>
            <button className="btn sm" onClick={() => go('invoices')}>View all</button>
          </div>
          {recent.length === 0
            ? <div className="empty"><div className="big">🧾</div>No invoices yet. Create one from the Invoices tab.</div>
            : <InvoiceTable invoices={recent} cur={cur} onOpen={openInvoice} />}
        </div>
      </div>
    </>
  );
}

function StatusBadge({ inv }) {
  if (inv.status === 'paid') return <span className="badge paid"><span className="dot"></span>Paid</span>;
  if (isOverdue(inv)) return <span className="badge overdue"><span className="dot"></span>Overdue</span>;
  if (inv.status === 'sent') return <span className="badge sent"><span className="dot"></span>Sent</span>;
  return <span className="badge draft"><span className="dot"></span>Draft</span>;
}

function InvoiceTable({ invoices, cur, onOpen }) {
  return (
    <table className="grid">
      <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Due</th><th className="t-right">Amount</th><th>Status</th></tr></thead>
      <tbody>
        {invoices.map((inv) => (
          <tr key={inv.id} className="row-click" onClick={() => onOpen(inv.id)}>
            <td style={{ fontWeight: 600 }}>{inv.number}</td>
            <td>{inv.billTo?.name}</td>
            <td className="muted">{window.invFmtDate(inv.invoiceDate)}</td>
            <td className="muted">{window.invFmtDate(inv.dueDate)}</td>
            <td className="t-right mono" style={{ fontWeight: 600 }}>{window.invMoney(inv.total, cur)}</td>
            <td><StatusBadge inv={inv} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Invoices page ────────────────────────────────────────────
function InvoicesPage({ invoices, customers, products, settings, reload, openInvoice }) {
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState('all');
  const cur = settings.currency || '$';
  const filtered = invoices.filter((i) => {
    if (filter === 'all') return true;
    if (filter === 'overdue') return isOverdue(i);
    return i.status === filter;
  });
  return (
    <>
      <Topbar title="Invoices" sub={`${invoices.length} total`}
        actions={<>
          <button className="btn" disabled={!invoices.length} onClick={() => setExporting(true)}>📤 Export Excel</button>
          <button className="btn primary" disabled={!customers.length} onClick={() => setCreating(true)}>{Ico.plus} New invoice</button>
        </>} />
      <div className="content">
        {!customers.length && <div className="banner warn">Add a customer first — invoices are addressed to a customer.</div>}
        <div className="toolbar">
          <div style={{ display: 'flex', gap: 8 }}>
            {['all', 'draft', 'sent', 'paid', 'overdue'].map((f) => (
              <button key={f} className={'btn sm' + (filter === f ? ' primary' : '')} onClick={() => setFilter(f)} style={{ textTransform: 'capitalize' }}>{f}</button>
            ))}
          </div>
        </div>
        <div className="card">
          {filtered.length === 0
            ? <div className="empty"><div className="big">🧾</div>No invoices here.</div>
            : <InvoiceTable invoices={filtered} cur={cur} onOpen={openInvoice} />}
        </div>
      </div>
      {creating && <InvoiceFormModal customers={customers} products={products} settings={settings}
        onClose={() => setCreating(false)}
        onSaved={async (inv) => { setCreating(false); await reload(); openInvoice(inv.id); }} />}
      {exporting && <InvoiceExportModal invoices={invoices} customers={customers} settings={settings} onClose={() => setExporting(false)} />}
    </>
  );
}

// ── Line items editor (shared) ───────────────────────────────
function LineItems({ items, setItems, cur, products, onCreateProduct }) {
  products = products || [];
  const matchOf = (val) => products.find((p) => p.name.trim().toLowerCase() === (val || '').trim().toLowerCase());
  const update = (i, key, val) => { const next = items.slice(); next[i] = { ...next[i], [key]: val }; setItems(next); };
  // Picking an existing item (typed or via dropdown) auto-fills its rate & tax.
  const onDesc = (i, val) => {
    const next = items.slice();
    const row = { ...next[i], description: val };
    const m = matchOf(val);
    if (m) { row.rate = m.rate; row.taxPct = m.taxPct; }
    next[i] = row; setItems(next);
  };
  const add = () => setItems([...items, { description: '', qty: 1, rate: 0, taxPct: 0 }]);
  const remove = (i) => setItems(items.filter((_, idx) => idx !== i));
  const isNew = (it) => it.description && it.description.trim() && !matchOf(it.description);
  const t = computeTotals(items);
  return (
    <div>
      {products.length > 0 && <div className="li-pickhint">Start typing to pick a saved item (auto-fills price &amp; tax), or type a new name and press ＋ to save it.</div>}
      <datalist id="li-products">{products.map((p) => <option key={p.id} value={p.name} />)}</datalist>
      <div className="li-head">
        <div>Item &amp; Description</div><div>Qty</div><div>Rate</div><div>Tax %</div><div className="t-right">Amount</div><div></div>
      </div>
      {items.map((it, i) => (
        <div className="li-row" key={i}>
          <input type="text" list="li-products" placeholder="Pick an item or type a new one…" value={it.description} onChange={(e) => onDesc(i, e.target.value)} />
          <input type="number" step="any" value={it.qty} onChange={(e) => update(i, 'qty', e.target.value)} />
          <input type="number" step="any" value={it.rate} onChange={(e) => update(i, 'rate', e.target.value)} />
          <input type="number" step="any" value={it.taxPct} onChange={(e) => update(i, 'taxPct', e.target.value)} />
          <div className="t-right mono" style={{ fontWeight: 600 }}>{((+it.qty || 0) * (+it.rate || 0)).toFixed(2)}</div>
          <div className="li-actions">
            {onCreateProduct && isNew(it) &&
              <button className="li-save" title="Save as a reusable item" onClick={() => onCreateProduct({ name: it.description.trim(), rate: +it.rate || 0, taxPct: +it.taxPct || 0 })}>＋</button>}
            <button className="x" onClick={() => remove(i)} title="Remove">×</button>
          </div>
        </div>
      ))}
      <button className="btn sm" onClick={add} style={{ marginTop: 4 }}>{Ico.plus} Add line</button>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14, gap: 28 }}>
        <div className="muted small" style={{ textAlign: 'right' }}>
          <div>Sub Total</div><div>Tax</div><div style={{ fontWeight: 700, color: 'var(--ink)' }}>Total</div>
        </div>
        <div className="mono small" style={{ textAlign: 'right' }}>
          <div>{window.invMoney(t.subTotal, cur)}</div><div>{window.invMoney(t.taxTotal, cur)}</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{window.invMoney(t.total, cur)}</div>
        </div>
      </div>
    </div>
  );
}

// ── Create invoice modal ─────────────────────────────────────
function InvoiceFormModal({ customers, products, settings, onClose, onSaved }) {
  const [prods, setProds] = useState(products || []);
  const createProduct = async (p) => {
    try { const saved = await api('/products', { method: 'POST', body: p });
      setProds((prev) => [...prev.filter((x) => x.name.toLowerCase() !== saved.name.toLowerCase()), saved]);
      toast('Saved item "' + saved.name + '"');
    } catch (e) { toast(e.message, true); }
  };
  const [customerId, setCustomerId] = useState(customers[0]?.id || '');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [terms, setTerms] = useState(settings.defaultTerms || 'Net 15');
  const [dueDate, setDueDate] = useState(addDays(today(), netDays(settings.defaultTerms)));
  const [dueTouched, setDueTouched] = useState(false);
  const [taxLabel, setTaxLabel] = useState(settings.defaultTaxLabel || 'IGST');
  const [items, setItems] = useState([{ description: '', qty: 1, rate: 0, taxPct: 0 }]);
  const [notes, setNotes] = useState(settings.defaultNotes || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!dueTouched) setDueDate(addDays(invoiceDate, netDays(terms))); }, [invoiceDate, terms, dueTouched]);

  const save = async () => {
    if (!customerId) return toast('Pick a customer', true);
    if (!items.some((i) => i.description)) return toast('Add at least one line item', true);
    setSaving(true);
    try {
      const inv = await api('/invoices', { method: 'POST', body: { customerId, invoiceDate, terms, dueDate, taxLabel, items, notes } });
      toast('Invoice ' + inv.number + ' created');
      onSaved(inv);
    } catch (e) { toast(e.message, true); } finally { setSaving(false); }
  };

  return (
    <Modal wide title="New invoice" onClose={onClose} foot={
      <><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? <span className="spin"></span> : 'Create invoice'}</button></>
    }>
      <div className="row2">
        <div className="field"><label>Customer</label>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Tax label</label><input type="text" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} /></div>
      </div>
      <div className="row3">
        <div className="field"><label>Invoice date</label><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></div>
        <div className="field"><label>Terms</label><input type="text" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Net 15" /></div>
        <div className="field"><label>Due date</label><input type="date" value={dueDate} onChange={(e) => { setDueTouched(true); setDueDate(e.target.value); }} /></div>
      </div>
      <div className="field"><label>Line items</label><LineItems items={items} setItems={setItems} cur={settings.currency} products={prods} onCreateProduct={createProduct} /></div>
      <div className="field"><label>Notes <span className="hint">(bank / payment details shown on the invoice)</span></label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} /></div>
    </Modal>
  );
}

// ── Invoice detail ───────────────────────────────────────────
function InvoiceDetail({ id, settings, gstatus, reload, back }) {
  const [inv, setInv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const docRef = useRef(null);

  const load = useCallback(async () => { try { setInv(await api('/invoices/' + id)); } catch (e) { toast(e.message, true); } }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!inv) return <><Topbar title="Invoice" /><div className="content muted">Loading…</div></>;
  const cur = inv.currency || '$';

  const download = async () => {
    setBusy(true);
    try {
      // Server renders a crisp vector PDF; just fetch the stored copy.
      const res = await fetch('/api/invoices/' + id + '/pdf?download=1');
      if (!res.ok) throw new Error('Server could not produce the PDF');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = inv.number + '.pdf'; a.click();
      URL.revokeObjectURL(url);
      toast('PDF downloaded');
    } catch (e) { toast('PDF failed: ' + e.message, true); } finally { setBusy(false); }
  };

  const del = async () => {
    if (!confirm('Delete invoice ' + inv.number + '?')) return;
    try { await api('/invoices/' + id, { method: 'DELETE' }); toast('Deleted'); await reload(); back(); }
    catch (e) { toast(e.message, true); }
  };

  const unpay = async () => {
    try { setInv(await api('/invoices/' + id + '/unpay', { method: 'POST' })); await reload(); toast('Payment removed'); }
    catch (e) { toast(e.message, true); }
  };

  return (
    <>
      <Topbar title={inv.number} sub={inv.billTo?.name}
        actions={<>
          <button className="btn" onClick={back}>{Ico.back} Back</button>
          <button className="btn" onClick={download} disabled={busy}>{busy ? <span className="spin" style={{ borderTopColor: '#333', borderColor: 'rgba(0,0,0,.2)' }}></span> : '⬇'} Download PDF</button>
          <button className="btn primary" onClick={() => setShowSend(true)}>✉ Send via Gmail</button>
          {inv.status !== 'paid'
            ? <button className="btn green" onClick={() => setShowPay(true)}>✓ Mark as paid</button>
            : <button className="btn" onClick={unpay}>Undo payment</button>}
        </>} />
      <div className="content">
        <div className="split">
          <div>
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <h2 className="section-title">Status</h2>
              <div style={{ marginBottom: 14 }}><StatusBadge inv={inv} /></div>
              <Row k="Total" v={window.invMoney(inv.total, cur)} bold />
              <Row k="Balance due" v={window.invMoney(inv.balanceDue, cur)} />
              <Row k="Invoice date" v={window.invFmtDate(inv.invoiceDate)} />
              <Row k="Due date" v={window.invFmtDate(inv.dueDate)} />
              <Row k="Sent to" v={inv.sentTo || '—'} />
              {inv.payment && <>
                <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '12px 0' }} />
                <Row k="Paid via" v={inv.payment.mode} />
                <Row k="Paid on" v={window.invFmtDate(inv.payment.date)} />
                {inv.payment.reference && <Row k="Reference" v={inv.payment.reference} />}
              </>}
            </div>
            <RemindersCard inv={inv} />
            <button className="btn danger" onClick={del}>Delete invoice</button>
          </div>
          <div className="card inv-scroll" style={{ padding: 16 }}>
            <InvoiceDocument inv={inv} innerRef={docRef} settings={settings} />
          </div>
        </div>
      </div>
      {showPay && <PayModal inv={inv} settings={settings} onClose={() => setShowPay(false)}
        onDone={async (u) => { setShowPay(false); setInv(u); await reload(); toast('Marked as paid'); }} />}
      {showSend && <SendModal inv={inv} settings={settings} gstatus={gstatus} docRef={docRef}
        onClose={() => setShowSend(false)} onSent={async (u) => { setShowSend(false); setInv(u); await reload(); }} />}
    </>
  );
}

function Row({ k, v, bold }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
    <span className="muted small">{k}</span>
    <span className="mono small" style={{ fontWeight: bold ? 700 : 500 }}>{v}</span>
  </div>;
}

// ── Pay modal ────────────────────────────────────────────────
function PayModal({ inv, settings, onClose, onDone }) {
  const [mode, setMode] = useState('Bank Transfer');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  // Prefill what's outstanding, not the total: on a partially-paid invoice the
  // total exceeds the balance and the server rejects it.
  const [amount, setAmount] = useState(inv.balanceDue != null ? inv.balanceDue : inv.total);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { const u = await api('/invoices/' + inv.id + '/pay', { method: 'POST', body: { mode, date, reference, amount: +amount } }); onDone(u); }
    catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Modal title={'Mark ' + inv.number + ' as paid'} onClose={onClose} foot={
      <><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn green" onClick={save} disabled={busy}>{busy ? <span className="spin"></span> : 'Record payment'}</button></>
    }>
      <div className="row2">
        <div className="field"><label>Payment mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>{PAYMENT_MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
        <div className="field"><label>Payment date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </div>
      <div className="row2">
        <div className="field"><label>Amount</label><input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label>Reference <span className="hint">(optional)</span></label><input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Txn / cheque no." /></div>
      </div>
    </Modal>
  );
}

// ── Payment reminder helpers ─────────────────────────────────
// offsetDays: negative = before due date, 0 = on it, positive = after.
function offsetLabel(n) {
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} before due date`;
  if (n === 0) return 'On due date';
  return `${n} day${n === 1 ? '' : 's'} after due date`;
}

function AddOffsetRow({ onAdd }) {
  const [days, setDays] = useState(7);
  const [dir, setDir] = useState('after');
  const add = () => {
    const n = Math.abs(Math.trunc(+days || 0)) * (dir === 'before' ? -1 : 1);
    onAdd(n);
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
      <input type="number" min="0" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 80 }} />
      <select value={dir} onChange={(e) => setDir(e.target.value)} style={{ width: 170 }}>
        <option value="before">days before due date</option>
        <option value="after">days after due date</option>
      </select>
      <button className="btn" onClick={add}>+ Add reminder</button>
    </div>
  );
}

// ── Send modal ───────────────────────────────────────────────
function SendModal({ inv, settings, gstatus, docRef, onClose, onSent }) {
  const [to, setTo] = useState(inv.recipientEmail || '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(`Invoice ${inv.number} from ${settings.businessName}`);
  const [message, setMessage] = useState('');
  const [offsets, setOffsets] = useState([]); // [{days, on}]
  const [busy, setBusy] = useState(false);

  // Server-built defaults: templated subject/body + org default reminder offsets.
  useEffect(() => {
    api('/invoices/' + inv.id + '/email-defaults')
      .then((d) => {
        setSubject(d.subject);
        setMessage(d.message);
        setOffsets((d.reminderOffsets || []).map((n) => ({ days: n, on: true })));
      })
      .catch((e) => toast(e.message, true));
  }, [inv.id]);

  if (!gstatus.connected) {
    return (
      <Modal title="Connect Google to send" onClose={onClose} foot={<button className="btn" onClick={onClose}>Close</button>}>
        {!gstatus.configured
          ? <div className="banner warn">Google OAuth isn't configured on the server. Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> (see README), then restart.</div>
          : <>
            <p>Connect a Google account to send invoices straight from Gmail with the PDF attached.</p>
            <a className="btn primary" href="/auth/google" target="_blank" rel="noreferrer">Connect Google account</a>
            <p className="muted small" style={{ marginTop: 12 }}>After connecting in the popup, close it and reopen this dialog.</p>
          </>}
        <p className="muted small" style={{ marginTop: 16 }}>Or use <b>Download PDF</b> and send it yourself.</p>
      </Modal>
    );
  }

  const send = async () => {
    if (!to) return toast('Recipient email required', true);
    setBusy(true);
    try {
      const reminderOffsets = offsets.filter((o) => o.on).map((o) => o.days);
      // Server attaches the stored vector PDF automatically.
      const r = await api('/invoices/' + inv.id + '/send', { method: 'POST', body: { to, cc, subject, message, reminderOffsets } });
      const n = (r.reminders || []).filter((x) => x.status === 'pending').length;
      toast('Sent to ' + to + (n ? ` · ${n} reminder${n === 1 ? '' : 's'} scheduled` : ''));
      onSent(r.invoice);
    } catch (e) { toast('Send failed: ' + e.message, true); } finally { setBusy(false); }
  };

  const addOffset = (n) => {
    if (offsets.some((o) => o.days === n)) return toast('That reminder is already listed', true);
    setOffsets([...offsets, { days: n, on: true }].sort((a, b) => a.days - b.days));
  };

  return (
    <Modal title={'Send ' + inv.number} onClose={onClose} foot={
      <><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={send} disabled={busy}>{busy ? <span className="spin"></span> : '✉ Send with PDF'}</button></>
    }>
      <div className="banner ok">Sending from {gstatus.email}</div>
      <div className="row2">
        <div className="field"><label>To</label><input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field"><label>Cc <span className="hint">(optional)</span></label><input type="email" value={cc} onChange={(e) => setCc(e.target.value)} /></div>
      </div>
      <div className="field"><label>Subject</label><input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
      <div className="field"><label>Message</label><textarea rows={7} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
      <div className="field">
        <label>Payment reminders <span className="hint">(emailed with the PDF while the app is running; skipped once paid)</span></label>
        {offsets.map((o, i) => (
          <label key={o.days} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500, padding: '2px 0' }}>
            <input type="checkbox" checked={o.on} style={{ width: 'auto' }}
              onChange={() => setOffsets(offsets.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
            {offsetLabel(o.days)}
          </label>
        ))}
        <AddOffsetRow onAdd={addOffset} />
      </div>
      <div className="muted small">The {inv.number}.pdf invoice is attached automatically.</div>
    </Modal>
  );
}

// ── Reminders card (invoice detail) ──────────────────────────
function RemindersCard({ inv }) {
  const [rems, setRems] = useState(null);
  const load = useCallback(async () => {
    try { setRems(await api('/invoices/' + inv.id + '/reminders')); } catch (e) { toast(e.message, true); }
  }, [inv.id]);
  useEffect(() => { load(); }, [load, inv.updatedAt]);

  const cancel = async (r) => {
    try { setRems(await api('/reminders/' + r.id, { method: 'DELETE' })); toast('Reminder cancelled'); }
    catch (e) { toast(e.message, true); }
  };
  const add = async (n) => {
    try { setRems(await api('/invoices/' + inv.id + '/reminders', { method: 'POST', body: { offsetDays: n } })); toast('Reminder scheduled'); }
    catch (e) { toast(e.message, true); }
  };

  const badge = (r) =>
    r.status === 'sent' ? <span className="badge paid">sent</span>
    : r.status === 'cancelled' ? <span className="badge draft">cancelled</span>
    : r.error ? <span className="badge overdue" title={r.error}>retrying</span>
    : <span className="badge sent">scheduled</span>;

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 className="section-title">Payment reminders</h2>
      {!rems ? <div className="muted small">Loading…</div> : <>
        {rems.length === 0 && <p className="muted small" style={{ margin: '4px 0' }}>None scheduled. Reminders are set when sending, or add one below.</p>}
        {rems.map((r) => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
            <span className="small" style={{ flex: 1 }}>{window.invFmtDate(r.dueOn)} <span className="muted">— {offsetLabel(r.offsetDays)}</span></span>
            {badge(r)}
            {r.status === 'pending' && <button className="btn" style={{ padding: '2px 8px' }} onClick={() => cancel(r)} title="Cancel this reminder">✕</button>}
          </div>
        ))}
        {inv.status !== 'paid' && inv.status !== 'void' && <AddOffsetRow onAdd={add} />}
      </>}
    </div>
  );
}

// ── Customers ────────────────────────────────────────────────
function CustomersPage({ customers, settings, reload }) {
  const [editing, setEditing] = useState(null); // customer or {} for new
  const del = async (c) => { if (!confirm('Delete ' + c.name + '?')) return; try { await api('/customers/' + c.id, { method: 'DELETE' }); await reload(); toast('Deleted'); } catch (e) { toast(e.message, true); } };
  return (
    <>
      <Topbar title="Customers" sub={`${customers.length} total`}
        actions={<>
          <ExportButton dataset="customers" name={settings.businessName} disabled={!customers.length} />
          <button className="btn primary" onClick={() => setEditing({})}>{Ico.plus} New customer</button>
        </>} />
      <div className="content">
        <div className="card">
          {customers.length === 0
            ? <div className="empty"><div className="big">👥</div>No customers yet. Add one to start invoicing.</div>
            : <table className="grid">
              <thead><tr><th>Name</th><th>Email</th><th>Billing address</th><th>GSTIN</th><th></th></tr></thead>
              <tbody>{customers.map((c) => (
                <tr key={c.id} className="row-click" onClick={() => setEditing(c)}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="muted">{c.email || '—'}</td>
                  <td className="muted small">{(c.billingAddressLines || []).slice(0, 2).join(', ') || '—'}</td>
                  <td className="muted small">{c.gstin || '—'}</td>
                  <td className="t-right" onClick={(e) => e.stopPropagation()}><button className="btn sm danger" onClick={() => del(c)}>Delete</button></td>
                </tr>))}</tbody>
            </table>}
        </div>
      </div>
      {editing && <CustomerModal customer={editing} onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await reload(); }} />}
    </>
  );
}

function CustomerModal({ customer, onClose, onSaved }) {
  const isNew = !customer.id;
  const [f, setF] = useState({
    name: customer.name || '', email: customer.email || '', ccEmail: customer.ccEmail || '', gstin: customer.gstin || '',
    billing: linesToText(customer.billingAddressLines), shipping: linesToText(customer.shipToAddressLines),
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => {
    if (!f.name) return toast('Name required', true);
    setBusy(true);
    const body = { name: f.name, email: f.email, ccEmail: f.ccEmail, gstin: f.gstin, billingAddressLines: textToLines(f.billing), shipToAddressLines: textToLines(f.shipping) };
    try {
      if (isNew) await api('/customers', { method: 'POST', body });
      else await api('/customers/' + customer.id, { method: 'PUT', body });
      toast('Saved'); onSaved();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Modal title={isNew ? 'New customer' : 'Edit customer'} onClose={onClose} foot={
      <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? <span className="spin"></span> : 'Save'}</button></>
    }>
      <div className="field"><label>Company / customer name</label><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Acme, Inc." /></div>
      <div className="row2">
        <div className="field"><label>Email to send invoices to</label><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="billing@acme.com" /></div>
        <div className="field"><label>Cc email <span className="hint">(optional)</span></label><input type="email" value={f.ccEmail} onChange={(e) => set('ccEmail', e.target.value)} /></div>
      </div>
      <div className="field"><label>GSTIN / Tax ID <span className="hint">(optional)</span></label><input type="text" value={f.gstin} onChange={(e) => set('gstin', e.target.value)} /></div>
      <div className="row2">
        <div className="field"><label>Billing address <span className="hint">(one line per row)</span></label>
          <textarea rows={5} value={f.billing} onChange={(e) => set('billing', e.target.value)} placeholder={'123 Market Street,\nSuite 400\nSan Francisco\n94103 California\nU.S.A'} /></div>
        <div className="field"><label>Ship-to address <span className="hint">(blank = same as billing)</span></label>
          <textarea rows={5} value={f.shipping} onChange={(e) => set('shipping', e.target.value)} /></div>
      </div>
    </Modal>
  );
}

// ── Products / items catalog ─────────────────────────────────
function ProductsPage({ products, settings, reload }) {
  const [editing, setEditing] = useState(null); // product or {} for new
  const cur = settings.currency || '$';
  const del = async (p) => { if (!confirm('Delete item "' + p.name + '"?')) return; try { await api('/products/' + p.id, { method: 'DELETE' }); await reload(); toast('Deleted'); } catch (e) { toast(e.message, true); } };
  return (
    <>
      <Topbar title="Items" sub={`${products.length} saved · reusable on invoices`}
        actions={<>
          <ExportButton dataset="items" name={settings.businessName} disabled={!products.length} />
          <button className="btn primary" onClick={() => setEditing({})}>{Ico.plus} New item</button>
        </>} />
      <div className="content">
        <div className="banner ok">Saved items appear in the line-item dropdown when creating invoices — picking one auto-fills its price &amp; tax. You can also save new items on the fly while editing an invoice (the ＋ button).</div>
        <div className="card">
          {products.length === 0
            ? <div className="empty"><div className="big">📦</div>No items yet. Add the things you sell so you can add them in one click.</div>
            : <table className="grid">
              <thead><tr><th>Item</th><th className="t-right">Default rate</th><th className="t-right">Default tax</th><th></th></tr></thead>
              <tbody>{products.map((p) => (
                <tr key={p.id} className="row-click" onClick={() => setEditing(p)}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td className="t-right mono">{window.invMoney(p.rate, cur)}</td>
                  <td className="t-right mono">{(p.taxPct || 0)}%</td>
                  <td className="t-right" onClick={(e) => e.stopPropagation()}><button className="btn sm danger" onClick={() => del(p)}>Delete</button></td>
                </tr>))}</tbody>
            </table>}
        </div>
      </div>
      {editing && <ProductModal product={editing} settings={settings} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
    </>
  );
}

function ProductModal({ product, settings, onClose, onSaved }) {
  const isNew = !product.id;
  const [name, setName] = useState(product.name || '');
  const [rate, setRate] = useState(product.rate != null ? product.rate : 0);
  const [taxPct, setTaxPct] = useState(product.taxPct != null ? product.taxPct : 0);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast('Item name required', true);
    setBusy(true);
    const body = { name: name.trim(), rate: +rate || 0, taxPct: +taxPct || 0 };
    try {
      if (isNew) await api('/products', { method: 'POST', body });
      else await api('/products/' + product.id, { method: 'PUT', body });
      toast('Saved'); onSaved();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Modal title={isNew ? 'New item' : 'Edit item'} onClose={onClose} foot={
      <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? <span className="spin"></span> : 'Save'}</button></>
    }>
      <div className="field"><label>Item name / description</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. AI x SEO retainer" /></div>
      <div className="row2">
        <div className="field"><label>Default rate ({settings.currency || '$'})</label><input type="number" step="any" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <div className="field"><label>Default tax %</label><input type="number" step="any" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

// ── Recurring ────────────────────────────────────────────────
function RecurringPage({ recurring, customers, products, settings, reload, openInvoice }) {
  const [editing, setEditing] = useState(null);
  const custName = (id) => customers.find((c) => c.id === id)?.name || '—';
  const runNow = async (r) => { try { const inv = await api('/recurring/' + r.id + '/run', { method: 'POST' }); toast('Generated ' + inv.number); await reload(); openInvoice(inv.id); } catch (e) { toast(e.message, true); } };
  const toggle = async (r) => { try { await api('/recurring/' + r.id, { method: 'PUT', body: { active: !r.active } }); await reload(); } catch (e) { toast(e.message, true); } };
  const del = async (r) => { if (!confirm('Delete this recurring schedule?')) return; try { await api('/recurring/' + r.id, { method: 'DELETE' }); await reload(); toast('Deleted'); } catch (e) { toast(e.message, true); } };
  return (
    <>
      <Topbar title="Recurring invoices" sub="Auto-generate invoices every month"
        actions={<button className="btn primary" disabled={!customers.length} onClick={() => setEditing({})}>{Ico.plus} New schedule</button>} />
      <div className="content">
        <div className="banner ok">Schedules generate the next invoice automatically each month on the chosen day. Generated invoices appear as drafts under Invoices.</div>
        <div className="card">
          {recurring.length === 0
            ? <div className="empty"><div className="big">🔁</div>No recurring schedules yet.</div>
            : <table className="grid">
              <thead><tr><th>Customer</th><th>Amount</th><th>Day</th><th>Next run</th><th>Status</th><th></th></tr></thead>
              <tbody>{recurring.map((r) => {
                const t = computeTotals(r.items || []);
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600, cursor: 'pointer' }} onClick={() => setEditing(r)}>{custName(r.customerId)}</td>
                    <td className="mono">{window.invMoney(t.total, settings.currency)}</td>
                    <td className="muted">Day {r.dayOfMonth}</td>
                    <td className="muted">{window.invFmtDate(r.nextRunDate)}</td>
                    <td>{r.active ? <span className="badge paid"><span className="dot"></span>Active</span> : <span className="badge draft">Paused</span>}</td>
                    <td className="t-right" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn sm" onClick={() => runNow(r)}>Run now</button>{' '}
                      <button className="btn sm" onClick={() => toggle(r)}>{r.active ? 'Pause' : 'Resume'}</button>{' '}
                      <button className="btn sm danger" onClick={() => del(r)}>Delete</button>
                    </td>
                  </tr>);
              })}</tbody>
            </table>}
        </div>
      </div>
      {editing && <RecurringModal schedule={editing} customers={customers} products={products} settings={settings}
        onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
    </>
  );
}

function RecurringModal({ schedule, customers, products, settings, onClose, onSaved }) {
  const [prods, setProds] = useState(products || []);
  const createProduct = async (p) => {
    try { const saved = await api('/products', { method: 'POST', body: p });
      setProds((prev) => [...prev.filter((x) => x.name.toLowerCase() !== saved.name.toLowerCase()), saved]);
      toast('Saved item "' + saved.name + '"');
    } catch (e) { toast(e.message, true); }
  };
  const isNew = !schedule.id;
  const [customerId, setCustomerId] = useState(schedule.customerId || customers[0]?.id || '');
  const [dayOfMonth, setDayOfMonth] = useState(schedule.dayOfMonth || 1);
  const [terms, setTerms] = useState(schedule.terms || settings.defaultTerms || 'Net 15');
  const [taxLabel, setTaxLabel] = useState(schedule.taxLabel || settings.defaultTaxLabel || 'IGST');
  const [items, setItems] = useState(schedule.items?.length ? schedule.items : [{ description: '', qty: 1, rate: 0, taxPct: 0 }]);
  const [notes, setNotes] = useState(schedule.notes != null ? schedule.notes : settings.defaultNotes || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!items.some((i) => i.description)) return toast('Add a line item', true);
    setBusy(true);
    const body = { customerId, dayOfMonth: +dayOfMonth, terms, taxLabel, items, notes };
    try {
      if (isNew) await api('/recurring', { method: 'POST', body });
      else await api('/recurring/' + schedule.id, { method: 'PUT', body });
      toast('Schedule saved'); onSaved();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={isNew ? 'New recurring schedule' : 'Edit schedule'} onClose={onClose} foot={
      <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? <span className="spin"></span> : 'Save schedule'}</button></>
    }>
      <div className="row3">
        <div className="field"><label>Customer</label>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label>Bill on day of month</label><input type="number" min="1" max="28" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} /></div>
        <div className="field"><label>Terms</label><input type="text" value={terms} onChange={(e) => setTerms(e.target.value)} /></div>
      </div>
      <div className="field"><label>Line items</label><LineItems items={items} setItems={setItems} cur={settings.currency} products={prods} onCreateProduct={createProduct} /></div>
      <div className="field"><label>Notes</label><textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
    </Modal>
  );
}

// ── Settings ─────────────────────────────────────────────────
// ── Passkeys (Settings) ──────────────────────────────────────
// Enrolment has to happen while signed in: the ceremony binds the new credential
// to the current user, so there is no way to add one from the login page.
function PasskeysCard() {
  const [supported, setSupported] = useState(null); // null = still checking
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const sb = await supabaseWithSession();
      const { data, error } = await sb.auth.passkey.list();
      if (error) throw error;
      setList(Array.isArray(data) ? data : (data && data.passkeys) || []);
    } catch (e) {
      setList([]); // listing is best-effort; enrolment is still worth offering
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const ok = Boolean(window.PublicKeyCredential) && Boolean(await supabaseClient());
      if (!alive) return;
      setSupported(ok);
      if (ok) refresh();
    })();
    return () => { alive = false; };
  }, [refresh]);

  const add = async () => {
    setBusy(true);
    try {
      const sb = await supabaseWithSession();
      const { error } = await sb.auth.registerPasskey();
      if (error) throw error;
      toast('Passkey added');
      await refresh();
    } catch (e) {
      toast(passkeyErrorMessage(e), true);
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    if (!confirm('Remove this passkey? You will no longer be able to sign in with it.')) return;
    try {
      const sb = await supabaseWithSession();
      const { error } = await sb.auth.passkey.delete(id);
      if (error) throw error;
      toast('Passkey removed');
      await refresh();
    } catch (e) { toast(passkeyErrorMessage(e), true); }
  };

  if (supported === null) return null;

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h2 className="section-title">Passkeys</h2>
      {!supported ? (
        <p className="muted small">
          Passkeys are unavailable — either this browser does not support them, or the
          server has no <code>SUPABASE_PUBLISHABLE_KEY</code> configured.
        </p>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            Sign in with Touch ID, Windows Hello or a security key instead of a password.
            A passkey works only on the device you create it on — add one per device.
          </p>

          {list && list.length > 0 && (
            <div className="passkey-list">
              {list.map((p) => (
                <div key={p.id} className="passkey-row">
                  <div>
                    <div className="passkey-name">{p.friendly_name || p.name || 'Passkey'}</div>
                    <div className="muted small">
                      Added {p.created_at ? new Date(p.created_at).toLocaleDateString() : 'recently'}
                    </div>
                  </div>
                  <button className="btn danger sm" onClick={() => remove(p.id)}>Remove</button>
                </div>
              ))}
            </div>
          )}

          {list && list.length === 0 && (
            <p className="muted small">No passkeys yet.</p>
          )}

          <button className="btn primary" onClick={add} disabled={busy}>
            {busy ? <span className="spin"></span> : '＋ Add a passkey'}
          </button>
        </>
      )}
    </div>
  );
}

function SettingsPage({ settings, gstatus, reload }) {
  const [f, setF] = useState({
    businessName: settings.businessName, address: linesToText(settings.addressLines), gstin: settings.gstin,
    currency: settings.currency, invoicePrefix: settings.invoicePrefix, nextNumber: settings.nextNumber,
    defaultTerms: settings.defaultTerms, defaultTaxLabel: settings.defaultTaxLabel, defaultNotes: settings.defaultNotes,
    logo: settings.logo || null, logoBg: settings.logoBg || 'light',
    reminderOffsets: settings.reminderOffsets || [0],
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF({ ...f, [k]: v });
  const onLogoFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast('Please choose an image file', true);
    if (file.size > 2 * 1024 * 1024) return toast('Logo must be under 2 MB', true);
    const reader = new FileReader();
    reader.onload = () => set('logo', reader.result); // data URL
    reader.readAsDataURL(file);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('/settings', { method: 'PUT', body: {
        businessName: f.businessName, addressLines: textToLines(f.address), gstin: f.gstin, currency: f.currency,
        logo: f.logo, logoBg: f.logoBg,
        invoicePrefix: f.invoicePrefix, nextNumber: +f.nextNumber, defaultTerms: f.defaultTerms,
        defaultTaxLabel: f.defaultTaxLabel, defaultNotes: f.defaultNotes,
        reminderOffsets: f.reminderOffsets,
      } });
      toast('Settings saved'); await reload();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  const disconnect = async () => { try { await api('/google/disconnect', { method: 'POST' }); await reload(); toast('Disconnected'); } catch (e) { toast(e.message, true); } };
  return (
    <>
      <Topbar title="Settings" actions={<button className="btn primary" onClick={save} disabled={busy}>{busy ? <span className="spin"></span> : 'Save changes'}</button>} />
      <div className="content" style={{ maxWidth: 760 }}>
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <h2 className="section-title">Your business (sender)</h2>
          <div className="field"><label>Business name</label><input type="text" value={f.businessName} onChange={(e) => set('businessName', e.target.value)} /></div>
          <div className="field"><label>Address <span className="hint">(one line per row)</span></label><textarea rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="row3">
            <div className="field"><label>GSTIN / Tax ID</label><input type="text" value={f.gstin} onChange={(e) => set('gstin', e.target.value)} /></div>
            <div className="field"><label>Currency symbol</label><input type="text" value={f.currency} onChange={(e) => set('currency', e.target.value)} /></div>
            <div className="field"><label>Default tax label</label><input type="text" value={f.defaultTaxLabel} onChange={(e) => set('defaultTaxLabel', e.target.value)} /></div>
          </div>
          <div className="row3">
            <div className="field"><label>Invoice prefix</label><input type="text" value={f.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value)} /></div>
            <div className="field"><label>Next number</label><input type="number" value={f.nextNumber} onChange={(e) => set('nextNumber', e.target.value)} /></div>
            <div className="field"><label>Default terms</label><input type="text" value={f.defaultTerms} onChange={(e) => set('defaultTerms', e.target.value)} /></div>
          </div>
          <div className="field"><label>Default notes / bank details</label><textarea rows={7} value={f.defaultNotes} onChange={(e) => set('defaultNotes', e.target.value)} /></div>
        </div>

        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <h2 className="section-title">Invoice logo</h2>
          <p className="muted small" style={{ marginTop: -6 }}>Upload your logo — it's bounded inside the logo box at the top-left of every invoice (PNG/JPG/SVG, under 2&nbsp;MB). Don't forget to <b>Save changes</b>.</p>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className={'logo-preview ' + (f.logoBg === 'dark' ? 'dark' : 'light')}>
              {f.logo
                ? <img src={f.logo} alt="logo preview" />
                : <span className="muted small">No logo<br />(text fallback)</span>}
            </div>
            <div>
              <label className="btn" style={{ cursor: 'pointer' }}>
                {f.logo ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onLogoFile} />
              </label>
              {f.logo && <button className="btn danger" style={{ marginLeft: 8 }} onClick={() => set('logo', null)}>Remove</button>}
              <div className="field" style={{ marginTop: 14 }}>
                <label>Logo box background</label>
                <div style={{ display: 'flex', gap: 16 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}>
                    <input type="radio" name="logobg" checked={f.logoBg === 'light'} onChange={() => set('logoBg', 'light')} style={{ width: 'auto' }} /> Light
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}>
                    <input type="radio" name="logobg" checked={f.logoBg === 'dark'} onChange={() => set('logoBg', 'dark')} style={{ width: 'auto' }} /> Dark
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <h2 className="section-title">Payment reminders — defaults</h2>
          <p className="muted small" style={{ marginTop: -6 }}>
            Pre-selected reminders when you send an invoice (adjustable per invoice in the send dialog).
            Reminder emails go out via Gmail while the app is running and stop automatically once the invoice is paid.
          </p>
          {f.reminderOffsets.length === 0 && <p className="muted small">No default reminders.</p>}
          {f.reminderOffsets.map((n) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <span className="small" style={{ flex: 1 }}>{offsetLabel(n)}</span>
              <button className="btn" style={{ padding: '2px 8px' }} onClick={() => set('reminderOffsets', f.reminderOffsets.filter((x) => x !== n))} title="Remove">✕</button>
            </div>
          ))}
          <AddOffsetRow onAdd={(n) => {
            if (f.reminderOffsets.includes(n)) return toast('That reminder is already listed', true);
            set('reminderOffsets', [...f.reminderOffsets, n].sort((a, b) => a - b));
          }} />
        </div>

        <PasskeysCard />

        <div className="card card-pad">
          <h2 className="section-title">Email — Google / Gmail</h2>
          {!gstatus.configured && <div className="banner warn">Server OAuth not configured. Add <code>GOOGLE_CLIENT_ID</code> &amp; <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> (see README), then restart the server.</div>}
          {gstatus.connected
            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="banner ok" style={{ margin: 0 }}>Connected as {gstatus.email}</div>
                <button className="btn danger" onClick={disconnect}>Disconnect</button>
              </div>
            : <div>
                <p className="muted small">Connect a Google account so invoices can be emailed from your Gmail with the PDF attached.</p>
                <a className="btn primary" href="/auth/google" target="_blank" rel="noreferrer" style={{ pointerEvents: gstatus.configured ? 'auto' : 'none', opacity: gstatus.configured ? 1 : .5 }}>Connect Google account</a>
              </div>}
        </div>
      </div>
    </>
  );
}

// ── Excel export helper + buttons ────────────────────────────
// Fetch the server-built .xlsx for a single dataset and trigger a download.
async function exportXlsx({ dataset, name, from, to, status, customerId }) {
  const qs = new URLSearchParams({ datasets: dataset });
  if (status) qs.set('status', status);
  if (customerId) qs.set('customerId', customerId);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const res = await fetch('/api/export?' + qs.toString());
  if (!res.ok) throw new Error('Server could not produce the file');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (name || 'export').replace(/[^a-zA-Z0-9._-]+/g, '-') + '-' + dataset + '-' + today() + '.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

// One-click export button for datasets with no filters (customers, items).
function ExportButton({ dataset, name, disabled }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await exportXlsx({ dataset, name }); toast('Excel exported'); }
    catch (e) { toast('Export failed: ' + e.message, true); } finally { setBusy(false); }
  };
  return <button className="btn" onClick={run} disabled={busy || disabled}>{busy ? <span className="spin" style={{ borderTopColor: '#333', borderColor: 'rgba(0,0,0,.2)' }}></span> : '📤'} Export Excel</button>;
}

// Invoice export with smart date range + status + customer filters.
function InvoiceExportModal({ invoices, customers, settings, onClose }) {
  const ranges = datePresets();
  const [rangeKey, setRangeKey] = useState('this_fy');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [status, setStatus] = useState('all');
  const [customerId, setCustomerId] = useState('');
  const [busy, setBusy] = useState(false);

  const active = ranges.find((r) => r.key === rangeKey) || ranges[0];
  const isCustom = rangeKey === 'custom';
  const effFrom = isCustom ? customFrom : active.from;
  const effTo = isCustom ? customTo : active.to;
  const cur = settings.currency || '$';

  // Live preview using the same filter logic the server applies.
  const filtered = invoices.filter((inv) => {
    if (effFrom && (!inv.invoiceDate || inv.invoiceDate < effFrom)) return false;
    if (effTo && (!inv.invoiceDate || inv.invoiceDate > effTo)) return false;
    if (customerId && inv.customerId !== customerId) return false;
    if (status !== 'all') {
      if (status === 'overdue') { if (!isOverdue(inv)) return false; }
      else if (inv.status !== status) return false;
    }
    return true;
  });
  const sum = filtered.reduce((s, i) => s + (i.total || 0), 0);

  const run = async () => {
    setBusy(true);
    try {
      await exportXlsx({ dataset: 'invoices', name: settings.businessName, from: effFrom, to: effTo, status, customerId });
      toast('Excel exported'); onClose();
    } catch (e) { toast('Export failed: ' + e.message, true); } finally { setBusy(false); }
  };

  return (
    <Modal title="Export invoices to Excel" onClose={onClose} foot={
      <><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={run} disabled={busy}>{busy ? <span className="spin"></span> : '📤 Export Excel'}</button></>
    }>
      <div className="row2">
        <div className="field"><label>Date range</label>
          <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)}>
            {ranges.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </div>
        <div className="field"><label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['all', 'draft', 'sent', 'paid', 'overdue'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
      </div>
      {isCustom && (
        <div className="row2">
          <div className="field"><label>From</label><input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></div>
          <div className="field"><label>To</label><input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></div>
        </div>
      )}
      <div className="field"><label>Customer</label>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {!isCustom && active.from && <div className="muted small" style={{ marginTop: -4, marginBottom: 12 }}>Range: {window.invFmtDate(active.from)} – {window.invFmtDate(active.to)}</div>}
      <div className="banner ok" style={{ margin: 0 }}>Ready to export: <b>{filtered.length} invoice{filtered.length === 1 ? '' : 's'} ({window.invMoney(sum, cur)})</b>.</div>
    </Modal>
  );
}

// ── Org switcher (sidebar) ───────────────────────────────────
function OrgSwitcher({ businessName, orgs, currentOrgId, onSwitchOrg, onAddOrg, onExit, onSignOut }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const initial = (businessName || 'I')[0].toUpperCase();
  return (
    <div className="org-switcher" ref={ref}>
      <button className="org-trigger" onClick={() => setOpen((v) => !v)} title="Switch organization">
        <div className="brand-logo">{initial}</div>
        <div className="org-trigger-name">
          <div className="brand-name">{businessName || 'Invoices'}</div>
          <div className="org-trigger-sub">{(orgs || []).length > 1 ? 'Switch organization' : 'Organization'}</div>
        </div>
        <span className="org-caret">⌄</span>
      </button>
      {open && (
        <div className="org-menu">
          <div className="org-menu-label">Organizations</div>
          {(orgs || []).map((o) => (
            <button key={o.id} className={'org-menu-item' + (o.id === currentOrgId ? ' active' : '')}
              onClick={() => { setOpen(false); onSwitchOrg(o.id); }}>
              <span className="org-menu-dot">{(o.name || '?')[0].toUpperCase()}</span>
              <span className="org-menu-text">{o.name}</span>
              {o.id === currentOrgId && <span className="org-menu-check">✓</span>}
            </button>
          ))}
          <div className="org-menu-sep" />
          <button className="org-menu-item action" onClick={() => { setOpen(false); onAddOrg(); }}>
            <span className="org-menu-dot plus">＋</span><span className="org-menu-text">New organization</span>
          </button>
          <button className="org-menu-item action" onClick={() => { setOpen(false); onExit(); }}>
            <span className="org-menu-dot">⤶</span><span className="org-menu-text">Exit to home</span>
          </button>
          <button className="org-menu-item action" onClick={() => { setOpen(false); onSignOut(); }}>
            <span className="org-menu-dot">⏻</span><span className="org-menu-text">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Landing page ─────────────────────────────────────────────
function LandingPage({ onGo }) {
  const features = [
    ['🧾', 'Polished invoices', 'A pixel-matched tax-invoice template, exported as a crisp vector PDF.'],
    ['👥', 'Customers & items', 'Save who you bill and what you sell — add line items in one click.'],
    ['✉️', 'Send from Gmail', 'Connect Google and email invoices with the PDF attached, from your address.'],
    ['🔁', 'Recurring billing', 'Set a monthly schedule and let invoices generate themselves.'],
  ];
  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-badge">Simple Invoicing</div>
        <h1 className="landing-title">Invoicing that stays out of your way.</h1>
        <p className="landing-sub">
          Create customers, raise clean invoices, send them from your own Gmail, and track payments —
          all in one tidy tool. No spreadsheets, no clutter.
        </p>
        <div className="landing-cta">
          <button className="btn primary lg" onClick={onGo}>Go to app →</button>
          <span className="landing-cta-note">Your data is private to your account.</span>
        </div>
        <div className="landing-grid">
          {features.map(([ico, t, d]) => (
            <div className="landing-card" key={t}>
              <div className="landing-card-ico">{ico}</div>
              <div className="landing-card-t">{t}</div>
              <div className="landing-card-d">{d}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="landing-foot">Simple Invoicing Tool</div>
    </div>
  );
}

// ── Onboarding (create the first / a new organization) ───────
function Onboarding({ first, onDone, onCancel }) {
  const [f, setF] = useState({
    businessName: '', address: '', gstin: '', currency: '$',
    invoicePrefix: 'INV-', nextNumber: 1, defaultTaxLabel: 'IGST', defaultTerms: 'Net 15',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const save = async () => {
    if (!f.businessName.trim()) return toast('Business name is required', true);
    setBusy(true);
    try {
      const org = await api('/orgs', { method: 'POST', body: {
        businessName: f.businessName.trim(),
        addressLines: textToLines(f.address),
        gstin: f.gstin, currency: f.currency || '$',
        invoicePrefix: f.invoicePrefix || 'INV-', nextNumber: +f.nextNumber || 1,
        defaultTaxLabel: f.defaultTaxLabel, defaultTerms: f.defaultTerms,
      } });
      toast('Organization created');
      onDone(org);
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-head">
          <div className="onboard-step">{first ? 'Welcome' : 'New organization'}</div>
          <h1>{first ? "Let's set up your business" : 'Add an organization'}</h1>
          <p className="muted">
            These details appear as the sender on your invoices. You can change them anytime in Settings,
            and add a logo there too.
          </p>
        </div>
        <div className="onboard-body">
          <div className="field"><label>Business name</label>
            <input type="text" autoFocus value={f.businessName} onChange={(e) => set('businessName', e.target.value)} placeholder="e.g. Acme Inc" /></div>
          <div className="field"><label>Address <span className="hint">(one line per row)</span></label>
            <textarea rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} placeholder={'123 Business Park Road\nCity, State - 000000\nCountry'} /></div>
          <div className="row2">
            <div className="field"><label>GSTIN / Tax ID <span className="hint">(optional)</span></label>
              <input type="text" value={f.gstin} onChange={(e) => set('gstin', e.target.value)} /></div>
            <div className="field"><label>Currency symbol</label>
              <input type="text" value={f.currency} onChange={(e) => set('currency', e.target.value)} /></div>
          </div>
          <div className="row3">
            <div className="field"><label>Invoice prefix</label>
              <input type="text" value={f.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value)} /></div>
            <div className="field"><label>Start number</label>
              <input type="number" value={f.nextNumber} onChange={(e) => set('nextNumber', e.target.value)} /></div>
            <div className="field"><label>Default terms</label>
              <input type="text" value={f.defaultTerms} onChange={(e) => set('defaultTerms', e.target.value)} /></div>
          </div>
        </div>
        <div className="onboard-foot">
          <button className="btn" onClick={onCancel}>{first ? 'Back' : 'Cancel'}</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? <span className="spin"></span> : (first ? 'Create & open app' : 'Create organization')}</button>
        </div>
      </div>
    </div>
  );
}

// ── Modal shell ──────────────────────────────────────────────
function Modal({ title, children, foot, onClose, wide }) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'modal' + (wide ? ' wide' : '')}>
        <div className="modal-head"><h3>{title}</h3><button className="x" onClick={onClose}>×</button></div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

// Read any email-link tokens out of the URL hash *before* React mounts, so the
// session is in place (or the error captured) by the time Root reads it.
_bootAuth = consumeAuthRedirect();

ReactDOM.createRoot(document.getElementById('root')).render(<Root />);
