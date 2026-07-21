// Vercel serverless entry for the whole API.
//
// The filename is a catch-all: it matches every /api/* path (/api/config,
// /api/auth/login, …) and — because it's matched directly, not via a rewrite —
// the function receives the ORIGINAL request URL, which is what Express routes on
// (its routes are defined as '/api/...'). api/cron.js is a more specific file, so
// /api/cron still goes there, not here.
//
// The Express app is itself a (req, res) handler. It is *required*, not run:
// server/index.js only calls start() (app.listen + schedulers) under require.main,
// so importing it yields the configured app with no listening socket and no
// process.exit — the Postgres pool connects lazily on the first query. Static
// assets and index.html are served from public/ by Vercel's CDN, not here.
module.exports = require('../server/index.js');
