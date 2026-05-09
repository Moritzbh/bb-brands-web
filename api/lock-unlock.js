// ============================================================
//  BB Brands — Site-Lock Unlock-Endpoint
//  POST /api/lock-unlock { password: "xxx" }
//    → ok: setzt HttpOnly Cookie bb_unlock=<HMAC>, 30 Tage
//    → 401 wenn Password falsch
//
//  Env vars:
//    BB_LOCK_PASSWORD — der Password-String
//    BB_LOCK_SECRET   — 32+ chars für HMAC (gleicher wie middleware.js)
// ============================================================

const crypto = require('crypto');

const SECRET = process.env.BB_LOCK_SECRET || 'change-me-in-production-please';
const PASSWORD = process.env.BB_LOCK_PASSWORD || 'launchparty';

function expectedToken() {
  return crypto.createHmac('sha256', SECRET).update('bb-unlock-ok').digest('base64url');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Body parsen (Vercel parst JSON automatisch wenn Content-Type:application/json)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const password = (body && body.password) || '';

  if (!password || password !== PASSWORD) {
    // Kleiner Delay gegen Brute-Force
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ error: 'Falsches Passwort' });
  }

  const token = expectedToken();
  // 30 Tage gültig
  const maxAge = 60 * 60 * 24 * 30;
  res.setHeader(
    'Set-Cookie',
    `bb_unlock=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`
  );
  return res.status(200).json({ ok: true });
};
