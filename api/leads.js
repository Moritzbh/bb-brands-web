// ============================================================
//  BB Brands — Lead Magnet Backend
//  Vercel Serverless Function (Node runtime)
//
//  Storage: Upstash Redis (via REST API, no SDK needed)
//  Works with either env var pair:
//    - KV_REST_API_URL + KV_REST_API_TOKEN  (Vercel KV / Marketplace)
//    - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Upstash direct)
//
//  Endpoints:
//    POST   /api/leads          → store new lead (public)
//    GET    /api/leads          → list all leads (admin token required)
//    PATCH  /api/leads          → update status  (admin token required)
//    DELETE /api/leads          → delete lead    (admin token required)
//
//  Required env vars:
//    KV_REST_API_URL (or UPSTASH_REDIS_REST_URL)
//    KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN)
//    ADMIN_TOKEN  → secret for /admin dashboard
// ============================================================

const KV_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  '';
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Email notifications (optional — runs only if RESEND_API_KEY is set)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'info@bb-brands.de';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'BB Brands Lead <leads@bb-brands.de>';

// Push notifications via ntfy.sh (optional — runs only if NTFY_TOPIC is set)
// Sanitize: trim whitespace + strip accidental https://... Präfix (User-Error-Resilient)
const NTFY_TOPIC_RAW = process.env.NTFY_TOPIC || '';
const NTFY_TOPIC = NTFY_TOPIC_RAW
  .trim()
  .replace(/^https?:\/\/[^/]+\//, '') // strip "https://ntfy.sh/" if accidentally included
  .replace(/^\/+/, '');               // strip leading slashes
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');

// Klaviyo (optional — Email-Marketing; läuft nur wenn beide Env-Vars gesetzt sind)
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY || '';
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID || '';

// Meta Conversions API (optional — läuft nur wenn META_PIXEL_ID + META_CAPI_TOKEN gesetzt)
const { sendCapiEvent } = require('./_capi');

// DNS für E-Mail-Domain-Prüfung (Bordmittel, keine Dependency)
const dns = require('dns').promises;

// Neues CRM-Modell (Supabase) — schreibt zusätzlich Contact/Submission/Deal.
// No-Op solange SUPABASE_* nicht gesetzt ist → bestehender Flow bleibt unberührt.
const { writeToCrm } = require('./_crm');

const HASH_KEY = 'bb:leads';

const PAIN_LABELS = {
  branding: 'Brand & Identity',
  shop: 'Shopify Store & CVR',
  ads: 'Meta & Performance Ads',
  ai: 'KI im Store & Support',
};

// Push-Notification Labels (Human-readable)
const UMSATZ_PUSH_LABELS = {
  '<5k': '<5k/Mo',
  '5-25k': '5–25k/Mo',
  '25-100k': '25–100k/Mo',
  '100k+': '100k+/Mo',
  'unklar': 'Umsatz unklar',
};
const BAUSTELLE_PUSH_LABELS = {
  'store-neu': 'Shop neu',
  'store-optimize': 'Shop optimieren',
  'store-rebuild': 'Shop Rebuild',
  'branding': 'Branding',
  'ads': 'Ads',
  'mehrere': 'Mehrere Bereiche',
};
const TIMELINE_PUSH_LABELS = {
  'sofort': '2 Wochen',
  '1-monat': '~1 Monat',
  '2-3-monate': '2–3 Monate',
  'explorativ': 'Explorativ',
};
const QUAL_PUSH_LABELS = {
  hot: 'Budget bereit',
  warm: 'Bereit, wenn Plan passt',
  diy: 'Will selbst machen',
  none: 'Kein Budget',
};

// Erstgespräch-Form enums (aus website/erstgespraech.html)
const ERSTGESPRAECH_UMSATZ = ['<5k', '5-25k', '25-100k', '100k+', 'unklar'];
const ERSTGESPRAECH_BAUSTELLE = [
  'store-neu',
  'store-optimize',
  'store-rebuild',
  'branding',
  'ads',
  'mehrere',
];
const ERSTGESPRAECH_TIMELINE = ['sofort', '1-monat', '2-3-monate', 'explorativ'];
const ERSTGESPRAECH_BUDGET = ['<5k', '5-10k', '10-20k', '20k+', 'unklar', ''];
const ERSTGESPRAECH_ATTRIBUTION = [
  'google',
  'linkedin',
  'instagram',
  'empfehlung',
  'cold-outreach',
  'andere',
  '',
];

// ----- Redis helper (single REST call) ----------------------
async function redis(...command) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('Redis not configured (missing env vars)');
  }
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.result;
}

// Findet einen bestehenden Lead per Email (für Dedup). → { id, record } | null
async function findLeadByEmail(email) {
  const needle = String(email || '').toLowerCase().trim();
  if (!needle) return null;
  const all = (await redis('HGETALL', HASH_KEY)) || [];
  // HGETALL returns [field, value, field, value, ...]
  for (let i = 0; i < all.length; i += 2) {
    try {
      const rec = JSON.parse(all[i + 1]);
      if (rec && String(rec.email || '').toLowerCase().trim() === needle) {
        return { id: all[i], record: rec };
      }
    } catch {
      /* kaputten Eintrag überspringen */
    }
  }
  return null;
}

// ----- Validation helpers -----------------------------------
function str(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isUrl(s) {
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s);
    return !!u.host;
  } catch {
    return false;
  }
}

// ----- Kontakt-Verifizierung (E-Mail-Domain + Telefon) ------
// Bewusst ohne Paid-API: prüft Plausibilität/Erreichbarkeit, NICHT die echte
// Existenz des Postfachs/Anschlusses (das bräuchte ZeroBounce/Twilio Lookup).
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'trashmail.com', 'yopmail.com', 'getnada.com', 'sharklasers.com',
  'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'throwawaymail.com', 'mohmal.com',
  'mailnesia.com', 'emailondeck.com', 'tempr.email', 'discard.email', 'spam4.me',
]);
function isDisposableEmail(email) {
  const d = String(email || '').toLowerCase().split('@')[1] || '';
  return DISPOSABLE_DOMAINS.has(d);
}
// Prüft, ob die E-Mail-Domain überhaupt Mails annehmen kann (MX, sonst A/AAAA).
async function emailDomainHasMx(email) {
  const domain = String(email || '').toLowerCase().split('@')[1];
  if (!domain) return false;
  try {
    const mx = await dns.resolveMx(domain);
    if (Array.isArray(mx) && mx.length > 0) return true;
  } catch { /* keine MX → weiter mit A/AAAA */ }
  try { const a = await dns.resolve4(domain); if (a && a.length) return true; } catch { /* noop */ }
  try { const a6 = await dns.resolve6(domain); if (a6 && a6.length) return true; } catch { /* noop */ }
  return false;
}
// Normalisiert eine Telefonnummer nach E.164 (+49…). Default-Land DE (DACH).
// Gibt { ok, e164 } zurück; ok=false wenn keine plausible Nummer.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false };
  const startsPlus = s.startsWith('+');
  const starts00 = /^\s*00/.test(s);
  let d = s.replace(/\D/g, '');
  if (!d) return { ok: false };
  if (starts00) d = d.replace(/^00/, '');
  else if (startsPlus) { /* schon internationale Ziffern */ }
  else if (d.startsWith('0')) d = '49' + d.replace(/^0+/, '');        // DE-national → +49
  else if (!/^(49|41|43)/.test(d) && d.length <= 11) d = '49' + d;    // kurze Nummer ohne Land → DE
  const e164 = '+' + d;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return { ok: false };
  return { ok: true, e164 };
}

// Extrahiert Attribution-Felder (UTMs + Referrer + Landing + Submit-Page) aus Request-Body.
// Wird von allen 3 Magnet-Handlern gleich benutzt, damit jeder Lead Herkunft hat.
function extractAttribution(body) {
  return {
    // First-Party Funnel-Session-ID (bb_sid) → verknüpft den Lead mit seiner
    // kompletten Klick-Journey im Event-Store (/api/events?sid=…).
    sid: str(body.sid, 60),
    utmSource: str(body.utm_source, 120),
    utmMedium: str(body.utm_medium, 120),
    utmCampaign: str(body.utm_campaign, 120),
    utmContent: str(body.utm_content, 120),
    utmTerm: str(body.utm_term, 120),
    referrer: str(body.referrer, 300),
    referrerDomain: str(body.referrer_domain, 120),
    landingPath: str(body.landing_path, 300),
    submitPath: str(body.submit_path, 300),
    // Meta-Attribution: für CAPI-Match + Browser/Server-Dedup
    fbp: str(body.fbp, 120),               // _fbp Cookie (vom Pixel gesetzt)
    fbc: str(body.fbc, 200),               // _fbc Cookie / aus fbclid abgeleitet
    fbEventId: str(body.event_id, 80),     // gleiche ID wie das Browser-fbq-Event
    // Tracking-Consent (DSGVO): nur wenn true, darf serverseitig an Meta gesendet werden.
    // Setzt das Frontend (bb-tracking.js attachToLead) erst nach CMP-Opt-in.
    trackingConsent:
      body.tracking_consent === true ||
      body.tracking_consent === 'true' ||
      body.tracking_consent === 'on',
  };
}

// Feuert ein serverseitiges Meta-"Lead"-Event für einen frisch gespeicherten Lead.
// Best-effort: No-Op ohne CAPI-Env-Vars, wirft nie. event_id = fbEventId des
// Browsers → Meta dedupliziert Browser-Pixel + dieses Server-Event.
async function fireLeadCapi(record, req) {
  try {
    // DSGVO: ohne Tracking-Consent kein serverseitiges Meta-Event.
    if (!record.trackingConsent) {
      console.log('[capi] Lead skip — kein Tracking-Consent');
      return;
    }
    const submitPath = record.submitPath || record.landingPath || '';
    const eventSourceUrl = submitPath
      ? `https://bb-brands.de${submitPath.startsWith('/') ? '' : '/'}${submitPath}`
      : 'https://bb-brands.de';
    await sendCapiEvent({
      eventName: 'Lead',
      eventId: record.fbEventId || record.id,
      userData: {
        email: record.email,
        phone: record.phone,
        fbp: record.fbp,
        fbc: record.fbc,
        ip: record.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
        userAgent: record.userAgent || str(req.headers['user-agent'] || '', 300),
      },
      customData: {
        content_name: record.magnet || 'lead',
        ...(record.segment ? { segment: record.segment } : {}),
        ...(record.tier ? { tier: record.tier } : {}),
      },
      eventSourceUrl,
      actionSource: 'website',
    });

    // Qualified Lead = ICP-Segment (red/yellow) + Budget (hot/warm).
    // Eigenes Meta-Event für qualitäts-basierte Ad-Optimierung statt rohem
    // Lead-Volumen. Server-only (Browser feuert es nicht → kein Doppelzählen).
    const _seg = record.segment, _q = record.qualification;
    if ((_seg === 'red' || _seg === 'yellow') && (_q === 'hot' || _q === 'warm')) {
      await sendCapiEvent({
        eventName: 'QualifiedLead',
        eventId: 'ql_' + record.id,
        userData: {
          email: record.email,
          phone: record.phone,
          fbp: record.fbp,
          fbc: record.fbc,
          ip: record.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
          userAgent: record.userAgent || str(req.headers['user-agent'] || '', 300),
        },
        customData: {
          content_name: record.magnet || 'lead',
          segment: _seg,
          ...(record.tier ? { tier: record.tier } : {}),
        },
        eventSourceUrl,
        actionSource: 'website',
      });
      console.log('[capi] QualifiedLead fired for', record.id, _seg, _q);
    }
  } catch (err) {
    console.error('[/api/leads] CAPI Lead failed:', err.message);
  }
}

function checkAdmin(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return ADMIN_TOKEN && token && token === ADMIN_TOKEN;
}

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// ----- Handler ----------------------------------------------
module.exports = async function handler(req, res) {
  // CORS: allow same-origin only by default; allow cross-origin GET preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    // ============ POST: create lead ============
    if (req.method === 'POST') {
      // Body parsing (Vercel doesn't always parse JSON automatically)
      let body = req.body;
      if (!body || typeof body === 'string') {
        try {
          body = body ? JSON.parse(body) : await readBody(req);
        } catch {
          body = await readBody(req);
        }
      }
      body = body || {};

      // Honeypot
      if (body._gotcha) {
        return jsonResponse(res, 200, { ok: true });
      }

      const magnet = str(body.magnet, 40) || 'style-guide';

      // ========== KONTAKT-IMPORT (eigener Typ, KEIN Sales-Lead) ==========
      // Bulk-Import aus Kalender / Klaviyo / Gmail. Bewusst STILL: kein Push,
      // kein CAPI, kein Klaviyo-Sync. Geparkt im 'nurture'-Bucket, type='contact'
      // → taucht NICHT in der heißen Pipeline auf. Dedup reichert bestehende
      // (echte) Leads nur an, stuft sie nie herab.
      if (magnet === 'contact') {
        const email = str(body.email, 200).toLowerCase();
        if (!email || !isEmail(email)) return jsonResponse(res, 400, { ok: false, error: 'invalid email' });
        const name = str(body.name, 120);
        const company = str(body.company || body.brand, 160);
        const source = str(body.source, 40) || 'import';
        const note = str(body.note, 300);
        const now = new Date().toISOString();
        const existing = await findLeadByEmail(email);
        if (existing) {
          const rec = existing.record;
          rec.name = rec.name || name;
          rec.brand = rec.brand || company;
          rec.importSources = Array.from(new Set([...(rec.importSources || []), source]));
          if (note) { rec.activity = rec.activity || []; rec.activity.push({ ts: now, text: 'Import (' + source + '): ' + note }); }
          rec.updatedAt = now;
          await redis('HSET', HASH_KEY, existing.id, JSON.stringify(rec));
          await writeToCrm(rec).catch(function () {});
          return jsonResponse(res, 200, { ok: true, id: existing.id, deduped: true });
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record = {
          id, email, name, brand: company,
          magnet: 'contact', type: 'contact', source, importSources: [source],
          status: 'nurture', consentNewsletter: false,
          activity: note ? [{ ts: now, text: 'Importiert (' + source + '): ' + note }] : [],
          createdAt: now, updatedAt: now,
        };
        await redis('HSET', HASH_KEY, id, JSON.stringify(record));
        await writeToCrm(record).catch(function () {});
        return jsonResponse(res, 200, { ok: true, id });
      }

      // ========== YOUTUBE CASE-BEWERBUNG (videos.bb-brands.de/case) ==========
      // Eigener Lead-Typ. Echte Inbound-Bewerbung → type:'lead' + Push-Notify.
      // Falls die E-Mail schon existiert: bestehenden Lead als Bewerber MARKIEREN
      // (campaigns += youtube-case), niemals herabstufen oder Quelle überschreiben.
      if (magnet === 'youtube-case') {
        const email = str(body.email, 200).toLowerCase();
        if (!email || !isEmail(email)) return jsonResponse(res, 400, { ok: false, error: 'invalid email' });
        const now = new Date().toISOString();
        const app = {
          name: str(body.name, 120),
          shop: str(body.website || body.shop || body.company, 300),
          phone: str(body.phone, 60),
          revenue: str(body.revenue, 160),
          pain: str(body.pain, 1000),
          appliedAt: now,
        };
        const summary = [
          app.phone ? 'Tel: ' + app.phone : null,
          app.shop ? 'Shop: ' + app.shop : null,
          app.revenue ? 'Umsatz/Traffic: ' + app.revenue : null,
          app.pain ? 'Engpass: ' + app.pain : null,
        ].filter(Boolean).join(' · ');
        const existing = await findLeadByEmail(email);
        if (existing) {
          const rec = existing.record;
          rec.campaigns = Array.from(new Set([...(rec.campaigns || []), 'youtube-case']));
          rec.caseApplication = app;
          rec.name = rec.name || app.name;
          rec.brand = rec.brand || app.shop;
          rec.website = rec.website || app.shop;
          rec.phone = rec.phone || app.phone;
          rec.activity = rec.activity || [];
          rec.activity.push({ ts: now, text: 'YouTube Case-Bewerbung: ' + summary });
          rec.updatedAt = now;
          await redis('HSET', HASH_KEY, existing.id, JSON.stringify(rec));
          await writeToCrm(rec).catch(function () {});
          await sendPushNotification(rec).catch((err) => console.error('[/api/leads] push (youtube-case dedup) failed:', err));
          return jsonResponse(res, 200, { ok: true, id: existing.id, deduped: true });
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record = {
          id, email,
          magnet: 'youtube-case', type: 'lead', source: 'youtube-case',
          campaigns: ['youtube-case'],
          name: app.name, brand: app.shop, website: app.shop, phone: app.phone,
          revenue: app.revenue, pain: app.pain, caseApplication: app,
          status: 'new', consentNewsletter: false,
          activity: [{ ts: now, text: 'YouTube Case-Bewerbung: ' + summary }],
          createdAt: now, updatedAt: now,
          ...extractAttribution(body),
        };
        await redis('HSET', HASH_KEY, id, JSON.stringify(record));
        await writeToCrm(record).catch(function () {});
        await sendPushNotification(record).catch((err) => console.error('[/api/leads] push (youtube-case) failed:', err));
        return jsonResponse(res, 200, { ok: true, id });
      }

      // ========== GRATIS PROFIT-RECHNER (Landingpage /gratis-profit-rechner) ==========
      // Lead-Gate VOR dem Ergebnis: Name + E-Mail + Telefon sind Pflicht.
      // Speichert die Rechner-Daten (Shop, Zahlen, Profit-Leck, Segment) mit,
      // feuert Push + Meta-CAPI. Dedup per E-Mail: bestehenden Lead anreichern,
      // nie herabstufen oder Quelle überschreiben.
      if (magnet === 'profit-rechner') {
        const SEGMENTS = ['tier1', 'red', 'yellow', 'green'];
        const name = str(body.name, 120);
        const email = str(body.email, 200).toLowerCase();
        let phone = str(body.phone, 60);
        const website = str(body.website || body.url, 300);
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

        const consentContact =
          body.consentContact === true ||
          body.consentContact === 'true' ||
          body.consentContact === 'on';
        const deliveryPreference =
          body.deliveryPreference === 'email' ? 'email'
          : body.deliveryPreference === 'whatsapp' ? 'whatsapp'
          : '';

        const errors = {};
        if (!name) errors.name = 'Name fehlt';
        if (!consentContact) errors.consentContact = 'Einwilligung erforderlich';
        // E-Mail: Format + Wegwerf-Domain
        if (!email || !isEmail(email)) errors.email = 'E-Mail ungültig';
        else if (isDisposableEmail(email)) errors.email = 'Bitte eine echte E-Mail (keine Wegwerf-Adresse)';
        // Telefon: nach E.164 normalisieren (Default DE)
        const pn = normalizePhone(phone);
        if (!pn.ok) errors.phone = 'Telefon ungültig (bitte mit Vorwahl, z. B. +49 …)';
        else phone = pn.e164;
        // E-Mail-Domain-Erreichbarkeit (MX/A) nur prüfen, wenn Format ok — spart DNS-Calls.
        // Best-effort: bei DNS-Fehler NICHT blocken (kein false-negative durch Netz-Hänger).
        if (!errors.email) {
          let mxOk = true;
          try { mxOk = await emailDomainHasMx(email); } catch { mxOk = true; }
          if (!mxOk) errors.email = 'E-Mail-Domain nicht erreichbar — bitte Adresse prüfen';
        }
        if (Object.keys(errors).length) {
          return jsonResponse(res, 400, { ok: false, errors });
        }

        const analysis = {
          visitors: num(body.visitors),
          aov: num(body.aov),
          cr: num(body.cr),
          leakMo: num(body.leakMo),
          leakYr: num(body.leakYr),
          segment: SEGMENTS.includes(body.segment) ? body.segment : '',
          qualification: ['hot', 'warm', 'diy', 'none'].includes(body.qualification) ? body.qualification : '',
          tier: [1, 2, 3].includes(Number(body.tier)) ? Number(body.tier) : null,
        };
        const summary = [
          website ? 'Shop: ' + website : null,
          analysis.leakMo != null ? 'Profit-Leck: ' + analysis.leakMo + ' €/Mo' : null,
          analysis.cr != null ? 'CR: ' + analysis.cr + ' %' : null,
          analysis.segment ? 'Segment: ' + analysis.segment : null,
        ].filter(Boolean).join(' · ');
        const now = new Date().toISOString();
        const attribution = extractAttribution(body);

        const existing = await findLeadByEmail(email);
        if (existing) {
          const rec = existing.record;
          rec.campaigns = Array.from(new Set([...(rec.campaigns || []), 'profit-rechner']));
          rec.name = rec.name || name;
          rec.phone = rec.phone || phone;
          rec.website = rec.website || website;
          rec.brand = rec.brand || website;
          // jüngste Analyse-Werte gewinnen (User kann Zahlen korrigieren)
          if (analysis.segment) rec.segment = analysis.segment;
          if (analysis.tier != null) rec.tier = analysis.tier;
          if (analysis.qualification) rec.qualification = analysis.qualification;
          if (analysis.leakMo != null) rec.leakMo = analysis.leakMo;
          if (analysis.leakYr != null) rec.leakYr = analysis.leakYr;
          rec.profitRechner = { ...analysis, website, at: now };
          rec.consentContact = true;
          rec.consentContactAt = rec.consentContactAt || now;
          rec.activity = rec.activity || [];
          if (deliveryPreference) {
            rec.deliveryPreference = deliveryPreference;
            rec.activity.push({ ts: now, text: 'Zustell-Wunsch: ' + (deliveryPreference === 'email' ? 'Ergebnis per E-Mail' : 'per WhatsApp') });
          } else {
            rec.activity.push({ ts: now, text: 'Profit-Rechner: ' + summary });
          }
          rec.updatedAt = now;
          // Tracking-Match-Keys nachziehen, falls vorher nicht vorhanden
          if (attribution.fbp && !rec.fbp) rec.fbp = attribution.fbp;
          if (attribution.fbc && !rec.fbc) rec.fbc = attribution.fbc;
          if (attribution.trackingConsent) rec.trackingConsent = true;
          await redis('HSET', HASH_KEY, existing.id, JSON.stringify(rec));
          await writeToCrm(rec).catch(function () {});
          await sendPushNotification(rec).catch((err) => console.error('[/api/leads] push (profit-rechner dedup) failed:', err));
          if (deliveryPreference === 'email') {
            await sendResultEmail(rec).catch((err) => console.error('[/api/leads] result email failed:', err));
          }
          await fireLeadCapi(rec, req);
          return jsonResponse(res, 200, { ok: true, id: existing.id, deduped: true });
        }

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record = {
          id, email, name, phone,
          magnet: 'profit-rechner', type: 'lead', source: 'profit-rechner',
          campaigns: ['profit-rechner'],
          website, brand: website,
          segment: analysis.segment, tier: analysis.tier, qualification: analysis.qualification,
          leakMo: analysis.leakMo, leakYr: analysis.leakYr,
          profitRechner: { ...analysis, website, at: now },
          deliveryPreference: deliveryPreference || null,
          status: 'new', consentNewsletter: false,
          consentContact: true, consentContactAt: now,
          activity: [{ ts: now, text: 'Profit-Rechner: ' + summary }],
          createdAt: now, updatedAt: now,
          ...attribution,
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
          userAgent: str(req.headers['user-agent'] || '', 300),
        };
        await redis('HSET', HASH_KEY, id, JSON.stringify(record));
        await writeToCrm(record).catch(function () {});
        await sendPushNotification(record).catch((err) => console.error('[/api/leads] push (profit-rechner) failed:', err));
        if (deliveryPreference === 'email') {
          await sendResultEmail(record).catch((err) => console.error('[/api/leads] result email failed:', err));
        }
        await fireLeadCapi(record, req);
        return jsonResponse(res, 200, { ok: true, id });
      }

      const isWhatsAppFunnel = magnet === 'whatsapp-chat';
      const isErstgespraech = magnet === 'erstgespraech';
      const isQuizDiagnose = magnet === 'quiz-diagnose';

      // ========== QUIZ-DIAGNOSE (Per-Order-Math-Funnel /diagnose) ==========
      if (isQuizDiagnose) {
        const SEGMENTS = ['tier1', 'red', 'yellow', 'green'];
        // answers: [{q, label}, ...] — defensiv parsen + kürzen
        let answers = [];
        if (Array.isArray(body.answers)) {
          answers = body.answers.slice(0, 12).map((a) => ({
            q: str(a && a.q, 40),
            label: str(a && a.label, 200),
          }));
        }

        const lead = {
          magnet: 'quiz-diagnose',
          email: str(body.email, 200),
          tier: [1, 2, 3].includes(Number(body.tier)) ? Number(body.tier) : null,
          segment: SEGMENTS.includes(body.segment) ? body.segment : '',
          profitScore: Number.isFinite(Number(body.profit_score)) ? Number(body.profit_score) : null,
          growthScore: Number.isFinite(Number(body.growth_score)) ? Number(body.growth_score) : null,
          bias: str(body.bias, 20),
          qualification: ['hot', 'warm', 'diy', 'none'].includes(body.qualification) ? body.qualification : '',
          answers,
          consentNewsletter:
            body.consentNewsletter === true ||
            body.consentNewsletter === 'true' ||
            body.consentNewsletter === 'on',
          ...extractAttribution(body),
        };

        const errors = {};
        if (!lead.email || !isEmail(lead.email)) errors.email = 'E-Mail ungültig';
        if (!lead.consentNewsletter) errors.consentNewsletter = 'Einwilligung erforderlich';
        if (!lead.segment) errors.segment = 'Segment fehlt';
        if (Object.keys(errors).length) {
          return jsonResponse(res, 400, { ok: false, errors });
        }

        // Dedup: existiert schon ein Lead mit dieser Email? → updaten statt duplizieren
        const existing = await findLeadByEmail(lead.email);
        const prev = existing ? existing.record : null;
        const id = existing ? existing.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();

        // Status nie zurückstufen: alles außer 'new' bleibt erhalten (z.B. call-booked, won)
        const status = prev && prev.status && prev.status !== 'new' ? prev.status : 'new';
        // Consent: einmal gegeben, bleibt gegeben
        const consentNewsletter = lead.consentNewsletter || !!(prev && prev.consentNewsletter);

        const record = {
          ...(prev || {}),          // bewahrt z.B. callBookedAt, calendlyEvent, name, deliveredAt
          id,
          ...lead,                  // überschreibt mit den aktuellen Quiz-Daten (Segment, Scores, Antworten)
          status,
          consentNewsletter,
          createdAt: (prev && prev.createdAt) || now,
          updatedAt: now,
          deliveredAt: prev ? (prev.deliveredAt ?? null) : null,
          consentNewsletterAt: consentNewsletter
            ? ((prev && prev.consentNewsletterAt) || now)
            : null,
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
          userAgent: str(req.headers['user-agent'] || '', 300),
        };

        await redis('HSET', HASH_KEY, id, JSON.stringify(record));
        await writeToCrm(record).catch(function () {});

        // Email-Marketing: Lead in Klaviyo-Liste (nur bei Newsletter-Consent)
        if (record.consentNewsletter) {
          await sendToKlaviyo(record).catch((err) =>
            console.error('[/api/leads] klaviyo failed:', err)
          );
        }

        // Await: siehe Kommentar oben — Push ist sonst race-condition-anfällig
        await sendPushNotification(record).catch((err) =>
          console.error('[/api/leads] push notify failed:', err)
        );

        // Meta CAPI: serverseitiges Lead-Event (dedupt mit Browser-fbq via event_id)
        await fireLeadCapi(record, req);

        return jsonResponse(res, 200, { ok: true, id });
      }

      // ========== ERSTGESPRÄCH FORMULAR ==========
      if (isErstgespraech) {
        const lead = {
          magnet: 'erstgespraech',
          name: str(body.name, 120),
          email: str(body.email, 200),
          brand: str(body.brand, 200),
          website: str(body.website, 300),
          wasVerkauft: str(body.was_verkauft || body.wasVerkauft, 1000),
          umsatz: ERSTGESPRAECH_UMSATZ.includes(body.umsatz) ? body.umsatz : '',
          baustelle: ERSTGESPRAECH_BAUSTELLE.includes(body.baustelle) ? body.baustelle : '',
          timeline: ERSTGESPRAECH_TIMELINE.includes(body.timeline) ? body.timeline : '',
          budget: ERSTGESPRAECH_BUDGET.includes(body.budget || '') ? (body.budget || '') : '',
          attribution: ERSTGESPRAECH_ATTRIBUTION.includes(body.attribution || '') ? (body.attribution || '') : '',
          consentContact:
            body.consentContact === true ||
            body.consentContact === 'true' ||
            body.consentContact === 'on',
          ...extractAttribution(body),
        };

        const errors = {};
        if (!lead.name) errors.name = 'Name fehlt';
        if (!lead.email || !isEmail(lead.email)) errors.email = 'E-Mail ungültig';
        if (!lead.brand) errors.brand = 'Marke fehlt';
        if (lead.website && !isUrl(lead.website)) errors.website = 'Webseite ungültig';
        if (!lead.wasVerkauft) errors.was_verkauft = 'Beschreibung fehlt';
        if (!lead.umsatz) errors.umsatz = 'Umsatz-Range fehlt';
        if (!lead.baustelle) errors.baustelle = 'Baustelle fehlt';
        if (!lead.timeline) errors.timeline = 'Timeline fehlt';
        if (!lead.consentContact) errors.consentContact = 'Einwilligung erforderlich';
        if (Object.keys(errors).length) {
          return jsonResponse(res, 400, { ok: false, errors });
        }

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const record = {
          id,
          ...lead,
          // Shim-Felder, damit das Admin-Dashboard bestehende Spalten nutzen kann
          company: lead.brand,
          delivery: 'email',
          status: 'new',
          createdAt: now,
          deliveredAt: null,
          consentContactAt: now,
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
          userAgent: str(req.headers['user-agent'] || '', 300),
        };

        await redis('HSET', HASH_KEY, id, JSON.stringify(record));
        await writeToCrm(record).catch(function () {});

        // Await: Vercel Serverless killed die Function sofort nach res.end(),
        // dadurch wurde der fire-and-forget fetch() zu ntfy mittendrin abgebrochen.
        // Kostet ~200-500ms Response-Time, ist aber zuverlässig.
        await sendPushNotification(record).catch((err) =>
          console.error('[/api/leads] push notify failed:', err)
        );

        // Meta CAPI: serverseitiges Lead-Event
        await fireLeadCapi(record, req);

        return jsonResponse(res, 200, { ok: true, id });
      }

      // ========== WHATSAPP CHAT FUNNEL ==========
      if (isWhatsAppFunnel) {
        const lead = {
          magnet: 'whatsapp-chat',
          name: str(body.name, 120),
          brand: str(body.brand, 200),
          website: str(body.website, 300),
          pain: ['branding', 'shop', 'ads', 'ai'].includes(body.pain) ? body.pain : '',
          context: str(body.context, 1000),
          phone: str(body.phone, 60),
          source: str(body.source, 60) || 'unknown',
          consentChat: body.consentChat === true || body.consentChat === 'true' || body.consentChat === 'on',
          ...extractAttribution(body),
        };

        const errors = {};
        if (!lead.name) errors.name = 'Name fehlt';
        if (!lead.brand) errors.brand = 'Marke fehlt';
        if (!lead.website || !isUrl(lead.website)) errors.website = 'Webseite ungültig';
        if (!lead.pain) errors.pain = 'Engpass nicht ausgewählt';
        if (!lead.phone || lead.phone.replace(/\D/g, '').length < 6) errors.phone = 'Telefon ungültig';
        if (!lead.consentChat) errors.consentChat = 'Einwilligung erforderlich';
        if (Object.keys(errors).length) {
          return jsonResponse(res, 400, { ok: false, errors });
        }

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const record = {
          id,
          ...lead,
          status: 'new',
          createdAt: now,
          deliveredAt: null,
          consentChatAt: now,
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
          userAgent: str(req.headers['user-agent'] || '', 300),
        };

        await redis('HSET', HASH_KEY, id, JSON.stringify(record));
        await writeToCrm(record).catch(function () {});

        // Fire-and-forget email notification (don't block response on failure)
        sendWhatsAppLeadEmail(record).catch((err) =>
          console.error('[/api/leads] email notify failed:', err)
        );

        // Await: siehe Kommentar oben beim Erstgespräch-Handler
        await sendPushNotification(record).catch((err) =>
          console.error('[/api/leads] push notify failed:', err)
        );

        // Meta CAPI: serverseitiges Lead-Event
        await fireLeadCapi(record, req);

        return jsonResponse(res, 200, { ok: true, id });
      }

      // ========== EXISTING LEAD MAGNETS (style-guide / ai-readiness-check) ==========
      const lead = {
        name: str(body.name, 120),
        company: str(body.company, 200),
        website: str(body.website, 300),
        email: str(body.email, 200),
        phone: str(body.phone, 60),
        delivery: body.delivery === 'whatsapp' ? 'whatsapp' : 'email',
        consentGuide: body.consentGuide === true || body.consentGuide === 'true' || body.consentGuide === 'on',
        consentReference: body.consentReference === true || body.consentReference === 'true' || body.consentReference === 'on',
        ...extractAttribution(body),
      };

      // Validation
      const errors = {};
      if (!lead.name) errors.name = 'Name fehlt';
      if (!lead.company) errors.company = 'Unternehmen fehlt';
      if (!lead.website || !isUrl(lead.website)) errors.website = 'Webseite ungültig';
      if (lead.delivery === 'whatsapp') {
        if (!lead.phone) errors.phone = 'WhatsApp-Nummer fehlt';
      } else {
        if (!lead.email || !isEmail(lead.email)) errors.email = 'E-Mail ungültig';
      }
      if (!lead.consentGuide) errors.consentGuide = 'Einwilligung zur Datenverarbeitung erforderlich';
      if (Object.keys(errors).length) {
        return jsonResponse(res, 400, { ok: false, errors });
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const record = {
        id,
        magnet,
        ...lead,
        status: 'new',
        createdAt: now,
        deliveredAt: null,
        // GDPR consent audit trail (Art. 7 Abs. 1 DSGVO — Nachweispflicht)
        consentGuideAt: lead.consentGuide ? now : null,
        consentReferenceAt: lead.consentReference ? now : null,
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
        userAgent: str(req.headers['user-agent'] || '', 300),
      };

      await redis('HSET', HASH_KEY, id, JSON.stringify(record));
      await writeToCrm(record).catch(function () {});

      // Await: siehe Kommentar oben
      await sendPushNotification(record).catch((err) =>
        console.error('[/api/leads] push notify failed:', err)
      );

      // Meta CAPI: serverseitiges Lead-Event
      await fireLeadCapi(record, req);

      return jsonResponse(res, 200, { ok: true, id });
    }

    // ============ GET: list leads (admin) ============
    if (req.method === 'GET') {
      if (!checkAdmin(req)) {
        return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      }
      const all = (await redis('HGETALL', HASH_KEY)) || [];
      // HGETALL returns [field, value, field, value, ...]
      const leads = [];
      for (let i = 0; i < all.length; i += 2) {
        try {
          leads.push(JSON.parse(all[i + 1]));
        } catch {
          // skip corrupted
        }
      }
      leads.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return jsonResponse(res, 200, { ok: true, leads, count: leads.length });
    }

    // ============ PATCH: update lead — Sales-CRM-Felder (admin) ============
    if (req.method === 'PATCH') {
      if (!checkAdmin(req)) {
        return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      }
      const body = req.body || (await readJsonBody(req));
      const id = str(body.id, 80);
      if (!id) return jsonResponse(res, 400, { ok: false, error: 'invalid input' });
      const existing = await redis('HGET', HASH_KEY, id);
      if (!existing) return jsonResponse(res, 404, { ok: false, error: 'not found' });
      const record = JSON.parse(existing);
      const now = new Date().toISOString();

      // Pipeline-Stufen (1-Call-Close) + Legacy-Status (Abwärtskompatibilität)
      const STATUSES = [
        'new', 'qualified', 'call-booked', 'call-done', 'proposal',
        'negotiation', 'won', 'lost', 'nurture',
        'contacted', 'in-progress', 'delivered',
      ];
      const DISPOSITIONS = [
        '', 'connected', 'no-answer', 'showed', 'no-show', 'rescheduled',
        'interested', 'not-interested', 'proposal-sent', 'closed',
      ];

      let changed = false;
      let contactTouch = false; // setzt lastContact (echter Kontakt: Notiz/Disposition)

      if (typeof body.status === 'string' && STATUSES.includes(body.status)) {
        record.status = body.status;
        if (body.status === 'delivered' && !record.deliveredAt) record.deliveredAt = now;
        changed = true;
      }
      if (body.dealValue !== undefined) {
        const v = Number(body.dealValue);
        record.dealValue = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
        changed = true;
      }
      if (body.nextAction !== undefined) {
        record.nextAction = str(body.nextAction, 300);
        changed = true;
      }
      if (body.nextFollowUp !== undefined) {
        record.nextFollowUp = str(body.nextFollowUp, 40) || null;
        changed = true;
      }
      if (body.disposition !== undefined && DISPOSITIONS.includes(body.disposition)) {
        record.disposition = body.disposition;
        changed = true;
        contactTouch = true;
      }
      if (body.lostReason !== undefined) {
        record.lostReason = str(body.lostReason, 120);
        changed = true;
      }
      if (body.addNote !== undefined) {
        const text = str(body.addNote, 2000);
        if (text) {
          if (!Array.isArray(record.activity)) record.activity = [];
          record.activity.push({ ts: now, text });
          changed = true;
          contactTouch = true;
        }
      }

      if (!changed) return jsonResponse(res, 400, { ok: false, error: 'nothing to update' });
      record.updatedAt = now;
      if (contactTouch) record.lastContact = now;
      await redis('HSET', HASH_KEY, id, JSON.stringify(record));
      await writeToCrm(record).catch(function () {});
      return jsonResponse(res, 200, { ok: true, lead: record });
    }

    // ============ DELETE: remove lead (admin) ============
    if (req.method === 'DELETE') {
      if (!checkAdmin(req)) {
        return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      }
      const body = req.body || (await readJsonBody(req));
      const id = str(body.id, 80);
      if (!id) return jsonResponse(res, 400, { ok: false, error: 'invalid input' });
      await redis('HDEL', HASH_KEY, id);
      return jsonResponse(res, 200, { ok: true });
    }

    return jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    console.error('[/api/leads] error:', err);
    return jsonResponse(res, 500, { ok: false, error: 'server error' });
  }
};

// ----- WhatsApp lead email notifier (Resend API, optional) -----
async function sendWhatsAppLeadEmail(record) {
  if (!RESEND_API_KEY) {
    console.log('[/api/leads] RESEND_API_KEY not set — skipping email notification');
    return;
  }
  const painLabel = PAIN_LABELS[record.pain] || record.pain;
  const subject = `WhatsApp-Lead · ${record.brand} · ${painLabel}`;
  const escapeHtml = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0B0B12;">
      <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:#25D366;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:16px;">Neuer WhatsApp-Lead</div>
      <h2 style="font-size:22px;margin:0 0 6px;font-weight:700;letter-spacing:-0.6px;">${escapeHtml(record.name)} · ${escapeHtml(record.brand)}</h2>
      <p style="margin:0 0 20px;color:#55555C;font-size:14px;">Quelle: ${escapeHtml(record.source)} · ${new Date(record.createdAt).toLocaleString('de-DE')}</p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:8px 0;color:#8C8C95;width:120px;">Engpass</td><td style="padding:8px 0;font-weight:600;">${escapeHtml(painLabel)}</td></tr>
        <tr><td style="padding:8px 0;color:#8C8C95;">Webseite</td><td style="padding:8px 0;"><a href="${escapeHtml(record.website)}" style="color:#0305C6;">${escapeHtml(record.website)}</a></td></tr>
        <tr><td style="padding:8px 0;color:#8C8C95;">WhatsApp</td><td style="padding:8px 0;"><a href="https://wa.me/${escapeHtml((record.phone || '').replace(/\D/g, ''))}" style="color:#25D366;font-weight:600;">${escapeHtml(record.phone)}</a></td></tr>
        ${record.context ? `<tr><td style="padding:8px 0;color:#8C8C95;vertical-align:top;">Kontext</td><td style="padding:8px 0;">${escapeHtml(record.context)}</td></tr>` : ''}
      </table>

      <div style="margin-top:24px;padding:14px 18px;background:#F4F4FF;border-radius:12px;font-size:13px;color:#55555C;">
        Lead-ID: <code style="font-family:monospace;">${escapeHtml(record.id)}</code><br>
        Im Admin-Dashboard: <a href="https://bb-brands.de/admin" style="color:#0305C6;">bb-brands.de/admin</a>
      </div>
    </div>
  `;

  const text = [
    `Neuer WhatsApp-Lead`,
    ``,
    `Name: ${record.name}`,
    `Marke: ${record.brand}`,
    `Webseite: ${record.website}`,
    `Engpass: ${painLabel}`,
    `WhatsApp: ${record.phone}`,
    record.context ? `Kontext: ${record.context}` : null,
    `Quelle: ${record.source}`,
    `Zeit: ${new Date(record.createdAt).toLocaleString('de-DE')}`,
    ``,
    `Lead-ID: ${record.id}`,
    `Admin: https://bb-brands.de/admin`,
  ].filter(Boolean).join('\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [NOTIFY_EMAIL],
      reply_to: `https://wa.me/${(record.phone || '').replace(/\D/g, '')}`,
      subject,
      html,
      text,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend ${resp.status}: ${errText}`);
  }
}

// ----- Result-Email an den Lead (Resend, optional) ---------
// Schickt dem Interessenten sein Profit-Analyse-Ergebnis, wenn er im Ergebnis
// "Ergebnis per E-Mail" wählt. No-Op ohne RESEND_API_KEY, wirft nur bei echtem
// Resend-Fehler (Caller fängt das ab).
async function sendResultEmail(record) {
  if (!RESEND_API_KEY) {
    console.log('[/api/leads] RESEND_API_KEY not set — skipping result email');
    return;
  }
  if (!record.email || !isEmail(record.email)) return;
  const pr = record.profitRechner || {};
  const shop = record.website || 'deinen Shop';
  const fmtEur = (n) => (n == null ? null : Number(n).toLocaleString('de-DE') + ' €');
  const leakMo = pr.leakMo != null ? pr.leakMo : record.leakMo;
  const escapeHtml = (s) =>
    String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const firstName = (record.name || '').trim().split(/\s+/)[0] || '';
  const greet = firstName ? `Hey ${escapeHtml(firstName)},` : 'Hey,';
  const leakLine = leakMo != null
    ? `Deine KI Profit-Analyse für <b>${escapeHtml(shop)}</b> zeigt ein behebbares Profit-Leck von rund <b>${escapeHtml(fmtEur(leakMo))}/Monat</b>${pr.cr != null ? ` (aktuelle Conversion ${escapeHtml(String(pr.cr).replace('.', ','))} %)` : ''}.`
    : `Deine KI Profit-Analyse für <b>${escapeHtml(shop)}</b> ist fertig.`;
  const subject = leakMo != null
    ? `Deine Profit-Analyse: ~${fmtEur(leakMo)}/Monat liegen drin`
    : `Deine Profit-Analyse für ${shop}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0B0B12;line-height:1.55;">
      <p style="font-size:16px;margin:0 0 14px;">${greet}</p>
      <p style="font-size:15px;margin:0 0 14px;">${leakLine}</p>
      <p style="font-size:15px;margin:0 0 14px;">Den kompletten Fix-Plan mit den <b>3 wichtigsten Hebeln</b> für ${escapeHtml(shop)} schicke ich dir persönlich. Ich melde mich in Kürze, kein Bot.</p>
      <p style="font-size:15px;margin:0 0 20px;">Wenn es schneller gehen soll, schreib mir einfach direkt auf WhatsApp zurück.</p>
      <p style="font-size:15px;margin:0;">Beste Grüße<br>Moritz Bohmbach · BB Brands</p>
    </div>`;
  const text = [
    greet, '',
    leakMo != null
      ? `Deine KI Profit-Analyse für ${shop} zeigt ein behebbares Profit-Leck von rund ${fmtEur(leakMo)}/Monat${pr.cr != null ? ` (Conversion ${String(pr.cr).replace('.', ',')} %)` : ''}.`
      : `Deine KI Profit-Analyse für ${shop} ist fertig.`,
    '',
    'Den kompletten Fix-Plan mit den 3 wichtigsten Hebeln schicke ich dir persönlich. Ich melde mich in Kürze.',
    '', 'Beste Grüße', 'Moritz Bohmbach · BB Brands',
  ].join('\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: NOTIFY_FROM, to: [record.email], reply_to: NOTIFY_EMAIL, subject, html, text }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend result-email ${resp.status}: ${errText}`);
  }
  console.log('[/api/leads] result email sent to', record.email);
}

// ----- Klaviyo subscribe (Email-Marketing, optional) -------
// Legt/aktualisiert ein Profil an + abonniert die Liste MIT Consent (Double-Opt-in
// via Klaviyo-Flow möglich). Custom-Properties (Segment/Tier/Scores/Qualifikation)
// landen als Profil-Properties für Segmentierung. Läuft nur wenn Env-Vars gesetzt.
async function sendToKlaviyo(record) {
  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    console.log('[klaviyo] skipped — KLAVIYO_API_KEY / KLAVIYO_LIST_ID nicht gesetzt');
    return;
  }
  const props = {
    bb_segment: record.segment || '',
    bb_tier: record.tier != null ? record.tier : '',
    bb_profit_score: record.profitScore != null ? record.profitScore : '',
    bb_growth_score: record.growthScore != null ? record.growthScore : '',
    bb_qualification: record.qualification || '',
    bb_magnet: record.magnet || '',
    bb_source: record.utmSource || record.referrerDomain || 'direct',
    bb_utm_campaign: record.utmCampaign || '',
    bb_lead_id: record.id || '',
  };

  const headers = {
    Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
    revision: '2024-10-15',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // --- Schritt 1: Profil mit Custom-Properties anlegen/aktualisieren ---
  // Der Bulk-Subscribe-Endpoint akzeptiert KEINE 'properties' am Profil
  // ("'properties' is not a valid field for the resource 'profile'").
  // Deshalb hier separat: POST /profiles/ — bei 409 (existiert schon) PATCH.
  const profileBody = {
    data: { type: 'profile', attributes: { email: record.email, properties: props } },
  };
  let pr = await fetch('https://a.klaviyo.com/api/profiles/', {
    method: 'POST',
    headers,
    body: JSON.stringify(profileBody),
  });
  if (pr.status === 409) {
    const dup = await pr.json().catch(() => null);
    const existingId = dup && dup.errors && dup.errors[0] && dup.errors[0].meta
      ? dup.errors[0].meta.duplicate_profile_id
      : null;
    if (existingId) {
      pr = await fetch(`https://a.klaviyo.com/api/profiles/${existingId}/`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          data: { type: 'profile', id: existingId, attributes: { properties: props } },
        }),
      });
    }
  }
  if (!pr.ok) {
    const t = await pr.text();
    throw new Error(`Klaviyo profile-upsert ${pr.status}: ${t}`);
  }

  // --- Schritt 2: Profil mit Consent in die Liste abonnieren (ohne properties) ---
  const subBody = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: {
          data: [{
            type: 'profile',
            attributes: {
              email: record.email,
              subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
            },
          }],
        },
      },
      relationships: { list: { data: { type: 'list', id: KLAVIYO_LIST_ID } } },
    },
  };
  const sr = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers,
    body: JSON.stringify(subBody),
  });
  if (!sr.ok) {
    const t = await sr.text();
    throw new Error(`Klaviyo subscribe ${sr.status}: ${t}`);
  }
  console.log(`[klaviyo] ok — ${record.email} → properties gesetzt + list ${KLAVIYO_LIST_ID} subscribed`);
}

// ----- ntfy.sh push notifier (optional) --------------------
async function sendPushNotification(record) {
  if (!NTFY_TOPIC) {
    console.log('[ntfy] skipped — NTFY_TOPIC not configured');
    return;
  }

  const payload = buildPushPayload(record);
  const publishUrl = `${NTFY_SERVER}/${NTFY_TOPIC}`;
  console.log(`[ntfy] publishing to ${publishUrl} for lead ${record.id} (magnet=${record.magnet})`);

  try {
    const resp = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        // ntfy nutzt HTTP-Headers für Metadata. Latin-1-safe damit Umlaute nicht crashen.
        'Title': encodeLatin1Header(payload.title),
        'Priority': payload.priority,
        'Tags': payload.tags,
        'Click': payload.clickUrl,
        'Actions': payload.actions,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: payload.message,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`ntfy ${resp.status}: ${errText}`);
    }
    console.log(`[ntfy] publish ok — lead ${record.id}`);
  } catch (err) {
    // Fehler nicht weiterwerfen — Push ist best-effort, blockiert nicht den Lead-Save
    // err.cause hat bei Node fetch "fetch failed" den echten Grund (DNS, Timeout, TLS)
    console.error(
      '[ntfy] send failed:',
      err.message,
      '| cause:', err.cause?.message || err.cause?.code || 'n/a',
      '| URL:', publishUrl
    );
  }
}

// ----- Push-Payload-Builder pro Magnet-Typ -----------------
// Baut Title, Message, Priority, Tags, Actions abhängig vom Lead-Typ.
// Neuer Magnet-Typ? → unten im else-Zweig wird er generisch verarbeitet,
// plus optional expliziter Case für reicheres Formatting.
function buildPushPayload(record) {
  const ADMIN_URL = 'https://bb-brands.de/admin';
  const time = record.createdAt
    ? new Date(record.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : '';

  // Shared: Is this a high-value lead? (→ High-Priority Push)
  const isHighValue =
    (record.umsatz && (record.umsatz === '25-100k' || record.umsatz === '100k+')) ||
    (record.budget && record.budget === '20k+') ||
    record.timeline === 'sofort' ||
    record.magnet === 'whatsapp-chat';

  // Shared: Source-Zeile für Push (kompakt)
  // Priorisiert: UTM-Source > manuelles attribution-Feld > Referrer-Domain > "Direct"
  function formatSource() {
    if (record.utmSource) {
      const parts = [record.utmSource];
      if (record.utmMedium) parts.push(record.utmMedium);
      if (record.utmCampaign) parts.push(`"${record.utmCampaign}"`);
      return `🔗 ${parts.join(' · ')}`;
    }
    if (record.attribution) return `🔗 ${record.attribution}`;
    if (record.referrerDomain) return `🔗 via ${record.referrerDomain}`;
    return '🔗 Direct';
  }
  const sourceLine = formatSource();

  // Shared: Action-Buttons bauen (max 3 — ntfy-Limit)
  // Labels bewusst ohne Umlaute, damit HTTP-Header Latin-1 safe bleibt.
  const actions = [];
  const phoneClean = (record.phone || '').replace(/\D/g, '');
  if (phoneClean) {
    actions.push(`view, WhatsApp, https://wa.me/${phoneClean}, clear=true`);
  } else if (record.email) {
    actions.push(`view, Antworten, mailto:${record.email}?subject=Deine%20Anfrage%20bei%20BB%20Brands, clear=false`);
  }
  actions.push(`view, Admin, ${ADMIN_URL}, clear=true`);
  if (record.website) {
    const webHref = record.website.startsWith('http') ? record.website : `https://${record.website}`;
    actions.push(`view, Website, ${webHref}, clear=false`);
  }
  const actionsHeader = actions.slice(0, 3).join('; ');

  // === ERSTGESPRÄCH ===
  if (record.magnet === 'erstgespraech') {
    const prefix = isHighValue ? '🔥 HOT LEAD · ' : 'Lead · ';
    const title = `${prefix}${record.brand || record.name}`;
    const lines = [
      `👤 ${record.name}`,
      record.email ? `✉️ ${record.email}` : null,
      record.umsatz ? `💰 Umsatz: ${UMSATZ_PUSH_LABELS[record.umsatz] || record.umsatz}` : null,
      record.baustelle ? `🎯 Baustelle: ${BAUSTELLE_PUSH_LABELS[record.baustelle] || record.baustelle}` : null,
      record.timeline ? `⏱ Timeline: ${TIMELINE_PUSH_LABELS[record.timeline] || record.timeline}` : null,
      record.budget ? `💶 Budget: ${record.budget}` : null,
      record.wasVerkauft ? `\n📝 ${record.wasVerkauft}` : null,
      `\n${sourceLine}`,
      time ? `🕐 ${time} Uhr` : null,
    ].filter(Boolean);
    return {
      title,
      message: lines.join('\n'),
      priority: isHighValue ? 'high' : 'default',
      tags: isHighValue ? 'fire,moneybag' : 'mailbox_with_mail',
      clickUrl: ADMIN_URL,
      actions: actionsHeader,
    };
  }

  // === QUIZ-DIAGNOSE (Per-Order-Math-Funnel) ===
  if (record.magnet === 'quiz-diagnose') {
    const SEG_LABELS = {
      tier1: '⚪ Tier 1 · Noch nicht ready',
      red: '🔴 RED · Profit erodiert',
      yellow: '🟡 YELLOW · Wachstum stoppt',
      green: '🟢 GREEN · Sauber aufgestellt',
    };
    const TIER_LABELS = { 1: 'Pre-Revenue', 2: 'Tier 2', 3: 'Tier 3 · Premium' };
    // Qualifiziert = Tier 2/3 mit Engpass (RED/YELLOW) → das sind die Audit-Kandidaten
    const isQualified = (record.tier === 2 || record.tier === 3) &&
      (record.segment === 'red' || record.segment === 'yellow');
    const prefix = isQualified ? '🔥 QUIZ-LEAD · ' : 'Quiz · ';
    const title = `${prefix}${SEG_LABELS[record.segment] || record.segment}`;
    const lines = [
      record.email ? `✉️ ${record.email}` : null,
      record.tier ? `📊 ${TIER_LABELS[record.tier] || 'Tier ' + record.tier}` : null,
      `🩺 Profit-Score: ${record.profitScore != null ? record.profitScore : '?'}/9 · Growth-Score: ${record.growthScore != null ? record.growthScore : '?'}/6`,
      record.qualification ? `💸 Bereitschaft: ${QUAL_PUSH_LABELS[record.qualification] || record.qualification}` : null,
      `\n${sourceLine}`,
      time ? `🕐 ${time} Uhr` : null,
    ].filter(Boolean);
    return {
      title,
      message: lines.join('\n'),
      priority: isQualified ? 'high' : 'default',
      tags: isQualified ? 'fire,stethoscope' : 'stethoscope',
      clickUrl: ADMIN_URL,
      actions: actionsHeader,
    };
  }

  // === WHATSAPP-CHAT ===
  if (record.magnet === 'whatsapp-chat') {
    const painLabel = PAIN_LABELS[record.pain] || record.pain;
    const title = `📱 WhatsApp-Lead · ${record.brand}`;
    const lines = [
      `👤 ${record.name}`,
      record.phone ? `📱 ${record.phone}` : null,
      painLabel ? `🎯 Engpass: ${painLabel}` : null,
      record.website ? `🌐 ${record.website}` : null,
      record.context ? `\n💬 ${record.context}` : null,
      `\n${sourceLine}`,
      time ? `🕐 ${time} Uhr` : null,
    ].filter(Boolean);
    // WhatsApp-Primary: Chat direkt öffnen
    const waAction = phoneClean
      ? `view, Chat, https://wa.me/${phoneClean}, clear=true`
      : null;
    const whatsappActions = [
      waAction,
      `view, Admin, ${ADMIN_URL}, clear=true`,
      record.website ? `view, Website, ${record.website.startsWith('http') ? record.website : 'https://' + record.website}, clear=false` : null,
    ].filter(Boolean).slice(0, 3).join('; ');
    return {
      title,
      message: lines.join('\n'),
      priority: 'high',
      tags: 'speech_balloon,fire',
      clickUrl: phoneClean ? `https://wa.me/${phoneClean}` : ADMIN_URL,
      actions: whatsappActions,
    };
  }

  // === STYLE-GUIDE / AI-READINESS-CHECK ===
  if (record.magnet === 'style-guide' || record.magnet === 'ai-readiness-check') {
    const magnetLabel = record.magnet === 'ai-readiness-check' ? 'AI-Check' : 'Style-Guide';
    const title = `🎁 ${magnetLabel} · ${record.company || record.name}`;
    const channelLabel = record.delivery === 'whatsapp' ? '📱 via WhatsApp' : '✉️ via E-Mail';
    const lines = [
      `👤 ${record.name}`,
      record.company ? `🏢 ${record.company}` : null,
      record.email ? `✉️ ${record.email}` : null,
      record.phone ? `📱 ${record.phone}` : null,
      record.website ? `🌐 ${record.website}` : null,
      channelLabel,
      record.consentReference ? '⭐ Referenz-OK erteilt' : null,
      `\n${sourceLine}`,
      time ? `🕐 ${time} Uhr` : null,
    ].filter(Boolean);
    return {
      title,
      message: lines.join('\n'),
      priority: 'default',
      tags: record.consentReference ? 'rocket,star' : 'rocket',
      clickUrl: ADMIN_URL,
      actions: actionsHeader,
    };
  }

  // === YOUTUBE CASE-BEWERBUNG ===
  if (record.magnet === 'youtube-case' || (record.campaigns && record.campaigns.indexOf('youtube-case') >= 0)) {
    const app = record.caseApplication || {};
    const title = `🎬 YouTube Case-Bewerbung · ${app.shop || record.brand || record.name || ''}`;
    const lines = [
      record.name ? `👤 ${record.name}` : null,
      record.email ? `✉️ ${record.email}` : null,
      app.phone ? `📱 ${app.phone}` : null,
      app.shop ? `🛒 ${app.shop}` : null,
      app.revenue ? `💰 ${app.revenue}` : null,
      app.pain ? `\n🎯 ${app.pain}` : null,
      time ? `\n🕐 ${time} Uhr` : null,
    ].filter(Boolean);
    return {
      title,
      message: lines.join('\n'),
      priority: 'high',
      tags: 'clapper,fire',
      clickUrl: ADMIN_URL,
      actions: actionsHeader,
    };
  }

  // === GRATIS PROFIT-RECHNER ===
  if (record.magnet === 'profit-rechner' || (record.campaigns && record.campaigns.indexOf('profit-rechner') >= 0)) {
    const pr = record.profitRechner || {};
    const leak = pr.leakMo != null ? pr.leakMo : record.leakMo;
    const SEG = { tier1: '⚪ <10k/Mo', red: '🔴 RED · Profit erodiert', yellow: '🟡 YELLOW · Wachstum stoppt', green: '🟢 GREEN · sauber' };
    const qualified = record.segment === 'red' || record.segment === 'yellow';
    const wantsEmail = record.deliveryPreference === 'email';
    const title = `${wantsEmail ? '✉️ E-MAIL-Wunsch · ' : (qualified ? '🔥 ' : '')}💸 Profit-Rechner · ${record.name || record.website || 'Lead'}`;
    const lines = [
      record.name ? `👤 ${record.name}` : null,
      record.phone ? `📱 ${record.phone}` : null,
      record.email ? `✉️ ${record.email}` : null,
      record.website ? `🛒 ${record.website}` : null,
      leak != null ? `💰 Profit-Leck: ${Number(leak).toLocaleString('de-DE')} €/Mo` : null,
      record.segment ? `📊 ${SEG[record.segment] || record.segment}` : null,
      pr.cr != null ? `📈 CR: ${pr.cr} %` : null,
      `\n${sourceLine}`,
      time ? `🕐 ${time} Uhr` : null,
    ].filter(Boolean);
    return {
      title,
      message: lines.join('\n'),
      priority: qualified ? 'high' : 'default',
      tags: qualified ? 'fire,moneybag' : 'moneybag',
      clickUrl: ADMIN_URL,
      actions: actionsHeader,
    };
  }

  // === GENERISCHER FALLBACK für zukünftige Magnet-Typen ===
  // Best-Effort: greift auf common fields zu, damit neue Magnets out-of-the-box
  // mindestens eine verständliche Push produzieren.
  const genericTitle = `Neue Anfrage · ${record.brand || record.company || record.name || 'Unbekannt'}`;
  const genericLines = [
    record.magnet ? `[${record.magnet}]` : null,
    record.name ? `👤 ${record.name}` : null,
    record.email ? `✉️ ${record.email}` : null,
    record.phone ? `📱 ${record.phone}` : null,
    record.website ? `🌐 ${record.website}` : null,
    `\n${sourceLine}`,
    time ? `🕐 ${time} Uhr` : null,
  ].filter(Boolean);
  return {
    title: genericTitle,
    message: genericLines.join('\n'),
    priority: 'default',
    tags: 'bell',
    clickUrl: ADMIN_URL,
    actions: actionsHeader,
  };
}

// HTTP-Header sind strikt Latin-1. Für Unicode (Emojis, Sonderzeichen)
// nutzen wir RFC 2047 encoded-words: =?UTF-8?B?<base64>?=
// ntfy.sh dekodiert das automatisch.
function encodeLatin1Header(s) {
  if (!s) return '';
  // Pure ASCII → 1:1 durchlassen (spart Platz, ntfy zeigt direkt)
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  // Non-ASCII → RFC 2047 Base64-encoded UTF-8
  const base64 = Buffer.from(s, 'utf-8').toString('base64');
  return `=?UTF-8?B?${base64}?=`;
}

// ----- raw body reader (fallback for when Vercel doesn't parse) -----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        // also accept x-www-form-urlencoded
        try {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          resolve(obj);
        } catch {
          reject(e);
        }
      }
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const b = await readBody(req);
  return b || {};
}
