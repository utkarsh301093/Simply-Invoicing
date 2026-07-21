// Vercel serverless entry point for the whole API.
//
// The Express app is itself a (req, res) handler, so exporting it is all Vercel's
// Node runtime needs. It is *required* here rather than run: server/index.js only
// calls start() (app.listen + schedulers) when invoked directly, so importing it
// gives us the configured app with no listening socket and no process.exit — the
// Postgres pool connects lazily on the first query.
//
// vercel.json rewrites /api/* and /auth/* here; static assets and index.html are
// served straight from public/ by Vercel's CDN.
module.exports = require('../server/index.js');
