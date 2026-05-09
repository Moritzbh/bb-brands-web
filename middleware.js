// ============================================================
//  BB Brands — Site-Lock (Edge Middleware, pure Web-Standard, no deps)
//  Unauth → 307 redirect zu /lock.html
//  Auth (Cookie bb_unlock=<HMAC>) → pass-through
//
//  Env vars (Vercel-Dashboard → Settings → Environment Variables):
//    BB_LOCK_SECRET   — 32+ chars random, signiert die Auth-Cookie
//    BB_LOCK_PASSWORD — wird in api/lock-unlock.js geprüft
//
//  Defaults wenn env fehlt:
//    BB_LOCK_SECRET="change-me-in-production-please"
//    BB_LOCK_PASSWORD="launchparty"
// ============================================================

export const config = {
  matcher: [
    // Alles außer: /lock(.html), /api, /assets, /_vercel, /favicon, /robots, /sitemap
    // WICHTIG: vercel.json hat cleanUrls:true → /lock.html === /lock
    // Beide Pfade müssen ausgeschlossen sein, sonst Redirect-Loop.
    '/((?!lock|api|assets|_vercel|favicon|robots|sitemap).*)'
  ]
};

const SECRET =
  (typeof process !== 'undefined' && process.env && process.env.BB_LOCK_SECRET) ||
  'change-me-in-production-please';

// HMAC-SHA256 base64url via Web-Crypto-API
async function expectedToken() {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('bb-unlock-ok'));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export default async function middleware(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const m = cookieHeader.match(/(?:^|;\s*)bb_unlock=([^;]+)/);
  const provided = m ? m[1] : null;
  const expected = await expectedToken();

  if (provided && provided === expected) {
    // Authenticated → pass-through (undefined = next() im Edge-Runtime)
    return;
  }

  // Unauthenticated → 307 redirect zur Lock-Page (clean URL wegen cleanUrls:true)
  return Response.redirect(new URL('/lock', request.url), 307);
}
