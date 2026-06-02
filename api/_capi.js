// ============================================================
//  BB Brands — Meta Conversions API (CAPI) Helper
//  Shared module — NICHT als Endpoint geroutet (Underscore-Präfix).
//
//  Sendet serverseitige Events an Meta. Spiegelt das env-gated
//  Pattern der restlichen Codebase: läuft NUR, wenn beide
//  Env-Vars gesetzt sind — sonst No-Op (loggt + returnt).
//
//  Env vars (in Vercel → Project → Settings → Environment Variables):
//    META_PIXEL_ID         — Pixel-/Datensatz-ID (15–16-stellige Zahl)
//    META_CAPI_TOKEN       — Conversions-API-Zugriffstoken (GEHEIM)
//    META_TEST_EVENT_CODE  — optional, für Live-Test im Events Manager
//    META_GRAPH_VERSION    — optional, default unten
//
//  Verwendung (aus leads.js / calendly.js):
//    const { sendCapiEvent, hashSHA256 } = require('./_capi');
//    await sendCapiEvent({
//      eventName: 'Lead',
//      eventId,                     // gleiche ID wie im Browser-fbq → Dedup
//      userData: { email, phone, fbp, fbc, ip, userAgent },
//      customData: { content_name: 'gratis-profit-analyse' },
//      eventSourceUrl: 'https://bb-brands.de/funnel/diagnose',
//    });
//
//  Fehler werden NICHT geworfen — Tracking ist best-effort und darf
//  niemals einen Lead-Save oder Webhook-Response blockieren.
// ============================================================

const crypto = require('crypto');

const META_PIXEL_ID = (process.env.META_PIXEL_ID || '').trim();
const META_CAPI_TOKEN = (process.env.META_CAPI_TOKEN || '').trim();
const META_TEST_EVENT_CODE = (process.env.META_TEST_EVENT_CODE || '').trim();
const GRAPH_VERSION = (process.env.META_GRAPH_VERSION || 'v21.0').trim();

const CAPI_ENABLED = !!(META_PIXEL_ID && META_CAPI_TOKEN);

// ----- SHA-256 Hashing (Meta-Anforderung für PII) -----------
// Meta erwartet gehashte personenbezogene Daten: lowercase + trim,
// dann SHA-256 hex. Nicht-PII-Felder (fbp/fbc/ip/ua) bleiben Klartext.
function hashSHA256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Telefon: nur Ziffern, dann hashen. Idealerweise inkl. Ländercode.
// DE-Heuristik: führende 0 → 49 (best effort, schadet sonst nicht).
function hashPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = '49' + digits.slice(1);
  return crypto.createHash('sha256').update(digits).digest('hex');
}

// ----- user_data zusammenbauen (nur gesetzte Felder) --------
function buildUserData({ email, phone, fbp, fbc, ip, userAgent } = {}) {
  const ud = {};
  const em = hashSHA256(email);
  const ph = hashPhone(phone);
  if (em) ud.em = [em];
  if (ph) ud.ph = [ph];
  if (fbp) ud.fbp = fbp;                       // Klartext (kein PII)
  if (fbc) ud.fbc = fbc;                       // Klartext (kein PII)
  if (ip) ud.client_ip_address = ip;           // verbessert Match-Quality
  if (userAgent) ud.client_user_agent = userAgent;
  return ud;
}

// ----- Haupt-Funktion: ein Event senden --------------------
// Gibt { ok, skipped?, status?, body?, error? } zurück. Wirft nie.
async function sendCapiEvent({
  eventName,
  eventId,
  eventTime,                 // unix seconds; default = jetzt
  userData = {},
  customData = {},
  eventSourceUrl = 'https://bb-brands.de',
  actionSource = 'website',  // 'website' | 'system_generated'
} = {}) {
  if (!CAPI_ENABLED) {
    console.log('[capi] skipped — META_PIXEL_ID / META_CAPI_TOKEN nicht gesetzt');
    return { ok: true, skipped: true };
  }
  if (!eventName) {
    console.warn('[capi] skipped — eventName fehlt');
    return { ok: false, error: 'missing eventName' };
  }

  const ud = buildUserData(userData);
  // Ohne irgendein Match-Signal ist das Event für Meta wertlos → loggen, aber trotzdem senden
  if (!ud.em && !ud.ph && !ud.fbp && !ud.fbc) {
    console.warn(`[capi] ⚠ event "${eventName}" ohne Match-Daten (kein em/ph/fbp/fbc) — niedrige Match-Quality`);
  }

  const event = {
    event_name: eventName,
    event_time: eventTime || Math.floor(Date.now() / 1000),
    action_source: actionSource,
    event_source_url: eventSourceUrl,
    user_data: ud,
    custom_data: customData && Object.keys(customData).length ? customData : undefined,
  };
  // event_id ist der Dedup-Schlüssel: Browser-fbq + dieser Server-Call
  // müssen dieselbe ID tragen, sonst zählt Meta das Event doppelt.
  if (eventId) event.event_id = eventId;

  const payload = { data: [event] };
  if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(META_CAPI_TOKEN)}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error(`[capi] ✗ ${eventName} → ${resp.status}: ${text}`);
      return { ok: false, status: resp.status, body: text };
    }
    console.log(`[capi] ✓ ${eventName} sent (event_id=${eventId || 'none'}, match=${Object.keys(ud).join(',') || 'none'})`);
    return { ok: true, status: resp.status, body: text };
  } catch (err) {
    console.error('[capi] send failed:', err.message, '| cause:', err.cause?.message || 'n/a');
    return { ok: false, error: err.message };
  }
}

module.exports = { sendCapiEvent, hashSHA256, hashPhone, buildUserData, CAPI_ENABLED };
