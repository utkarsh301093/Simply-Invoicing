// Google OAuth2 connect + Gmail send (with PDF attachment).
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const store = require('./store');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri() {
  const base = (process.env.APP_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  return `${base}/auth/google/callback`;
}

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

function authUrl() {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force refresh_token every time
    scope: SCOPES,
  });
}

async function handleCallback(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Look up the connected account's email.
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const me = await oauth2.userinfo.get();

  const db = store.get();
  db.integrations.google = {
    email: me.data.email,
    refreshToken: tokens.refresh_token || (db.integrations.google && db.integrations.google.refreshToken) || null,
    connectedAt: new Date().toISOString(),
  };
  store.save();
  return db.integrations.google;
}

function connection() {
  return store.get().integrations.google;
}

function status() {
  const g = connection();
  return {
    configured: isConfigured(),
    connected: Boolean(g && g.refreshToken),
    email: g ? g.email : null,
  };
}

function disconnect() {
  store.get().integrations.google = null;
  store.save();
}

// Build a Gmail OAuth2 nodemailer transport from the stored refresh token.
function transport() {
  const g = connection();
  if (!isConfigured()) throw new Error('Google OAuth client not configured on the server.');
  if (!g || !g.refreshToken)
    throw new Error('No Google account connected. Connect one in Settings.');

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: g.email,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: g.refreshToken,
    },
  });
}

// pdfBase64: raw base64 (no data: prefix). attachmentName e.g. "INV-1001.pdf".
async function sendInvoiceEmail({ to, cc, subject, text, html, pdfBase64, attachmentName }) {
  const g = connection();
  const org = store.activeOrg();
  const fromName = (org && org.profile.businessName) || 'Invoices';
  const tx = transport();
  const attachments = pdfBase64
    ? [{ filename: attachmentName || 'invoice.pdf', content: Buffer.from(pdfBase64, 'base64'), contentType: 'application/pdf' }]
    : [];
  const info = await tx.sendMail({
    from: `${fromName} <${g.email}>`,
    to,
    cc: cc || undefined,
    subject,
    text,
    html,
    attachments,
  });
  return { messageId: info.messageId, from: g.email };
}

module.exports = { isConfigured, authUrl, handleCallback, status, disconnect, sendInvoiceEmail };
