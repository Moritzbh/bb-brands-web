// ============================================================
//  BB Brands — Site-Lock (Edge Middleware)
//  Schaltet die neue Site hinter Passwort-Gate.
//  Unauth: rewrite → /lock.html (URL bleibt sichtbar gleich).
//  Auth (Cookie bb_unlock=<HMAC>): pass-through.
//
//  Env vars (Vercel-Dashboard → Settings → Environment Variables):
//    BB_LOCK_SECRET   — 32+ chars random, signiert die Auth-Cookie
//    BB_LOCK_PASSWORD — wird in api/lock-unlock.js geprüft
//
//  Fallback (lokal/wenn env nicht gesetzt):
//    BB_LOCK_SECRET="change-me-in-production-please"
//    BB_LOCK_PASSWORD="launchparty"
// ============================================================

import { rewrite, next } from '@vercel/edge';

export const config = {
  matcher: [
    // Alles außer: /lock.html, /api, /assets, /_vercel, /favicon, /robots, /sitemap
    '/((?!lock\\.html|api|assets|_vercel|favicon|robots|sitemap).*)'
  ]
};

const SECRET = (typeof process !== 'undefined' && process.env && process.env.BB_LOCK_SECRET) || 'change-me-in-production-please';

// HMAC-SHA256 base64url via Web-Crypto-API (Edge-kompatibel)
async function expectedToken() {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('bb-unlock-ok'));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default async function middleware(request) {
  // Cookie auslesen
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)bb_unlock=([^;]+)/);
  const provided = match ? match[1] : null;

  const expected = await expectedToken();

  if (provided && provided === expected) {
    // Authenticated → pass-through
    return next();
  }

  // Unauthenticated → rewrite zur Lock-Page (URL bleibt gleich, kein Redirect)
  return rewrite(new URL('/lock.html', request.url));
}
