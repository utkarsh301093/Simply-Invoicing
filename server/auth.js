// Supabase Auth: verify the caller's access token and hand the claims to db.js,
// which replays them into Postgres so RLS can act on them.
//
// Verification is local, against the project's published JWKS (this project signs
// ES256). No shared secret and no round-trip to Supabase per request — the keys
// are fetched once and cached, and rotate automatically.
//
// AUTH_JWKS_URL exists so the test suite can point at a throwaway key server and
// exercise this exact code path rather than a weakened stand-in.
const { createRemoteJWKSet, jwtVerify, decodeJwt } = require('jose');

let jwks = null;

function jwksUrl() {
  if (process.env.AUTH_JWKS_URL) return process.env.AUTH_JWKS_URL;
  const base = process.env.SUPABASE_AUTH_URL || process.env.SUPABASE_URL;
  if (!base) throw new Error('SUPABASE_URL is not set — cannot verify tokens');
  return `${base.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
}

function keys() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(jwksUrl()));
  return jwks;
}

// Exported for tests, which need to drop a cached key set between key servers.
function resetKeys() { jwks = null; }

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// Returns the verified claims, or throws. The claims object is what lands in
// request.jwt.claims, so auth.uid() reads `sub` straight out of it.
async function verifyToken(token) {
  const { payload } = await jwtVerify(token, keys(), {
    // Supabase issues `authenticated` for signed-in users; anon keys carry
    // role=anon and must not be accepted as a user.
    audience: 'authenticated',
  });
  if (!payload.sub) throw new Error('token has no subject');
  if (payload.role && payload.role !== 'authenticated') {
    throw new Error(`unexpected role ${payload.role}`);
  }
  return payload;
}

// Express middleware. Attaches req.claims on success; 401s otherwise.
// Deliberately fail-closed: any verification error is a 401, never a pass-through.
function requireAuth() {
  return async (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    try {
      req.claims = await verifyToken(token);
      req.userId = req.claims.sub;
      next();
    } catch (e) {
      // Distinguish expiry so the frontend knows to refresh rather than re-login.
      const expired = /exp/i.test(e.code || '') || /expired/i.test(e.message || '');
      res.status(401).json({ error: expired ? 'Session expired' : 'Invalid session', expired });
    }
  };
}

module.exports = { requireAuth, verifyToken, resetKeys, bearer, decodeJwt };
