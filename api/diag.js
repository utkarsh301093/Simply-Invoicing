// TEMPORARY diagnostic — no Express, no app dependency. Responds via raw Node so
// it can't crash the way the Express functions do, and reports whether requiring
// the server graph throws on Vercel (and with what stack). Remove once the API is
// confirmed healthy.
module.exports = (req, res) => {
  const out = {
    node: process.version,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 7),
    url: req.url,
    cwd: process.cwd(),
    region: process.env.VERCEL_REGION || null,
    // Presence only — never the values. Pinpoints which env vars are still unset
    // in Vercel without leaking any secret.
    env: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_SECRET_KEY: Boolean(process.env.SUPABASE_SECRET_KEY),
      SUPABASE_PUBLISHABLE_KEY: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY),
      SUPABASE_STORAGE_BUCKET: Boolean(process.env.SUPABASE_STORAGE_BUCKET),
      APP_BASE_URL: Boolean(process.env.APP_BASE_URL),
      CRON_SECRET: Boolean(process.env.CRON_SECRET),
    },
  };
  try {
    const app = require('../server/index.js');
    out.requiredServer = typeof app;
    out.runSweeps = typeof app.runSweeps;
  } catch (e) {
    out.requireError = e.message;
    out.stack = String(e.stack || '').split('\n').slice(0, 10);
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out, null, 2));
};
