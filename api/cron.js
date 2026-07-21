// Scheduled trigger for the two sweeps that ran on setInterval in the standalone
// server (recurring-invoice generation + reminder emails). Serverless has no
// long-lived process, so vercel.json registers this path as a Cron Job instead.
//
// Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on cron
// invocations when CRON_SECRET is set. We require it, so the endpoint can't be
// triggered by anyone who guesses the URL. With no CRON_SECRET set the endpoint
// refuses to run rather than fail open.
const app = require('../server/index.js');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' });
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await app.runSweeps();
    res.status(200).json({ ok: true, ranAt: new Date().toISOString() });
  } catch (e) {
    console.error('cron sweep failed:', e.message);
    res.status(500).json({ error: e.message });
  }
};
