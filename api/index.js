// Vercel serverless entry for the whole API.
//
// vercel.json rewrites every non-static path here (Vercel's filesystem catch-all
// only matched one path segment, so /api/auth/login 404'd; a rewrite doesn't have
// that limit). The rewrite preserves the original request URL, which is what
// Express routes on — its routes are defined as '/api/...'. api/cron.js matches at
// the filesystem layer first, so /api/cron still lands there, not here.
//
// The Express app is itself a (req, res) handler. It is *required*, not run:
// server/index.js only calls start() (app.listen + schedulers) under require.main,
// so importing it yields the configured app with no listening socket and no
// process.exit — the Postgres pool connects lazily on the first query.
module.exports = require('../server/index.js');
