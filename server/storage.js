// Supabase Storage client — invoice PDFs and org logos.
//
// Deliberately not @supabase/supabase-js: that SDK bundles Realtime (which needs
// a WebSocket polyfill on Node < 22), Auth and PostgREST, none of which this app
// uses — the database goes through `pg`. Storage is a plain REST API, so a few
// fetch calls cover it with zero dependencies.
//
// The bucket is PRIVATE. Objects are never served directly to the browser; the
// Express layer either streams the bytes or hands out a short-lived signed URL.
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'invoices';

function config() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  // Prefer the current secret key; fall back to the legacy service_role JWT.
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, key, bucket: BUCKET };
}

function configured() {
  const { url, key } = config();
  return Boolean(url && key);
}

// ── Local filesystem driver ─────────────────────────────────────────────────
// Used when Supabase Storage is not configured. This keeps the test suite
// hermetic (no network, no writes to a real bucket) and lets the app run fully
// offline. Same interface as the remote driver, so nothing upstream branches.
function localRoot() {
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'storage');
}

function localPathFor(p) {
  // Contain writes to the storage root: a "../" in a key must not escape it.
  const full = path.resolve(localRoot(), p);
  if (!full.startsWith(path.resolve(localRoot()) + path.sep)) throw new Error(`Unsafe storage path: ${p}`);
  return full;
}

const local = {
  async ensureBucket() {
    fs.mkdirSync(localRoot(), { recursive: true });
    return { created: true, public: false };
  },
  async listBuckets() { return [{ name: BUCKET, public: false }]; },
  async put(p, buf) {
    const full = localPathFor(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // Same atomic write the JSON store used: temp file, then rename.
    fs.writeFileSync(full + '.tmp', buf);
    fs.renameSync(full + '.tmp', full);
    return p;
  },
  async get(p) {
    const full = localPathFor(p);
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  },
  async remove(paths) {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(localPathFor(p), { force: true });
    return [];
  },
  async signedUrl(p) { return `file://${localPathFor(p)}`; },
};

function headers(extra) {
  const { key } = config();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function base() {
  return `${config().url}/storage/v1`;
}

// Storage returns JSON errors; surface the message rather than a bare status.
async function fail(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body.message || body.error || JSON.stringify(body);
  } catch {
    detail = await res.text().catch(() => '');
  }
  throw new Error(`${what} failed (${res.status}): ${detail}`);
}

async function listBuckets() {
  const res = await fetch(`${base()}/bucket`, { headers: headers() });
  if (!res.ok) await fail(res, 'listBuckets');
  return res.json();
}

// Create the private bucket if it isn't there yet. Safe to call repeatedly.
async function ensureBucket() {
  const { bucket } = config();
  const existing = await listBuckets();
  const found = existing.find((b) => b.name === bucket);
  if (found) return { created: false, public: found.public };

  const res = await fetch(`${base()}/bucket`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
  if (!res.ok) await fail(res, 'createBucket');
  return { created: true, public: false };
}

// Upload bytes at `path`, replacing anything already there. Returns the path so
// callers can store it on the row.
async function put(path, buf, contentType = 'application/octet-stream') {
  const { bucket } = config();
  const res = await fetch(`${base()}/object/${bucket}/${encodeURI(path)}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': '3600' }),
    body: buf,
  });
  if (!res.ok) await fail(res, `upload ${path}`);
  return path;
}

// Fetch bytes back. Returns null for a missing object so callers can regenerate
// rather than having to distinguish error shapes.
async function get(path) {
  const { bucket } = config();
  const res = await fetch(`${base()}/object/${bucket}/${encodeURI(path)}`, { headers: headers() });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) await fail(res, `download ${path}`);
  return Buffer.from(await res.arrayBuffer());
}

async function remove(paths) {
  const { bucket } = config();
  const res = await fetch(`${base()}/object/${bucket}`, {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: Array.isArray(paths) ? paths : [paths] }),
  });
  if (!res.ok) await fail(res, 'remove');
  return res.json();
}

// Time-limited URL for a private object. Default 5 minutes: long enough to load
// a PDF in a viewer, short enough that a leaked link expires quickly.
async function signedUrl(path, expiresIn = 300) {
  const { url, bucket } = config();
  const res = await fetch(`${base()}/object/sign/${bucket}/${encodeURI(path)}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) await fail(res, `signedUrl ${path}`);
  const body = await res.json();
  return `${url}/storage/v1${body.signedURL || body.signedUrl}`;
}

// Dispatch to the remote driver when Supabase is configured, the local one
// otherwise. Callers never need to know which is active.
const remote = { ensureBucket, listBuckets, put, get, remove, signedUrl };
const driver = (name) => (...args) => (configured() ? remote[name](...args) : local[name](...args));

module.exports = {
  configured,
  config,
  isLocal: () => !configured(),
  ensureBucket: driver('ensureBucket'),
  listBuckets: driver('listBuckets'),
  put: driver('put'),
  get: driver('get'),
  remove: driver('remove'),
  signedUrl: driver('signedUrl'),
  BUCKET,
};
