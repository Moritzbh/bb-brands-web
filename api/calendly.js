// ============================================================
//  BB Brands — Calendly Webhook → CRM
//  Vercel Serverless Function (Node runtime)
//
//  Empfängt Calendly-v2-Webhooks (invitee.created / invitee.canceled)
//  und schreibt/aktualisiert einen Lead in Redis (bb:leads).
//
//  Logik:
//   - Booking via WEBSITE (alles ohne utm_medium=funnel-result):
//       i.d.R. noch NICHT im CRM → neuen Lead anlegen (Status call-booked).
//   - Booking via FUNNEL (utm_medium=funnel-result):
//       Lead existiert i.d.R. schon (Email-Opt-in) → bestehenden Lead
//       auf 'call-booked' updaten, NICHT duplizieren. Falls doch nicht
//       gefunden → anlegen, damit nichts verloren geht.
//
//  Endpoints:
//    POST /api/calendly  → Webhook-Receiver (Calendly ruft das auf)
//    GET  /api/calendly  → Health-Check (zeigt ob Signing-Key gesetzt ist)
//
//  Env vars:
//    KV_REST_API_URL / KV_REST_API_TOKEN   (oder UPSTASH_*) — Redis (shared mit leads.js)
//    CALENDLY_WEBHOOK_SIGNING_KEY           — empfohlen: HMAC-Signaturprüfung
//    NTFY_TOPIC / NTFY_SERVER               — optional: Push-Notification
// ============================================================

const crypto = require('crypto');

// Meta Conversions API (optional — läuft nur wenn META_PIXEL_ID + META_CAPI_TOKEN gesetzt)
const { sendCapiEvent, CAPI_ENABLED } = require('./_capi');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HASH_KEY = 'bb:leads';
const CALENDLY_SIGNING_KEY = process.env.CALENDLY_WEBHOOK_SIGNING_KEY || '';

const NTFY_TOPIC = (process.env.NTFY_TOPIC || '')
  .trim()
  .replace(/^https?:\/\/[^/]+\//, '')
  .replace(/^\/+/, '');
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');

// ----- Redis helper (single REST call, identisch zu leads.js) -----
async function redis(...command) {
  if (!KV_URL || !KV_TOKEN) throw new Error('Redis not configured (missing env vars)');
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Calendly signiert: Header "Calendly-Webhook-Signature: t=<ts>,v1=<hmac>"
// Signierter String = `${ts}.${rawBody}` → HMAC-SHA256 mit dem Signing-Key.
function verifySignature(rawBody, header) {
  if (!CALENDLY_SIGNING_KEY) return { ok: true, skipped: true };
  if (!header) return { ok: false, reason: 'missing signature header' };
  const parts = {};
  for (const kv of header.split(',')) {
    const idx = kv.indexOf('=');
    if (idx > -1) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: 'malformed header' };
  const expected = crypto
    .createHmac('sha256', CALENDLY_SIGNING_KEY)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) {
    return { ok: false, reason: 'timestamp too old (>5min)' };
  }
  return { ok: true };
}

// Lead per Email finden → { id, record } | null
async function findLeadByEmail(email) {
  const all = (await redis('HGETALL', HASH_KEY)) || [];
  // HGETALL returns [field, value, field, value, ...]
  for (let i = 0; i < all.length; i += 2) {
    try {
      const rec = JSON.parse(all[i + 1]);
      if (rec && String(rec.email || '').toLowerCase() === email) {
        return { id: all[i], record: rec };
      }
    } catch {
      /* skip kaputte Einträge */
    }
  }
  return null;
}

// ntfy-Header müssen Latin-1-safe sein (Umlaute → ASCII-Fallback)
function encodeLatin1(s) {
  return String(s)
    .replace(/[äÄöÖüÜß]/g, (c) => ({ ä: 'ae', Ä: 'Ae', ö: 'oe', Ö: 'Oe', ü: 'ue', Ü: 'Ue', ß: 'ss' }[c]))
    .replace(/[^\x00-\xFF]/g, '');
}

async function sendPush(title, message) {
  if (!NTFY_TOPIC) {
    console.log('[ntfy] skipped — NTFY_TOPIC not set');
    return;
  }
  try {
    const resp = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: encodeLatin1(title),
        Priority: 'high',
        Tags: 'calendar',
        Click: 'https://bb-brands.de/admin',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: message,
    });
    if (!resp.ok) throw new Error(`ntfy ${resp.status}: ${await resp.text()}`);
  } catch (err) {
    console.error('[ntfy] send failed:', err.message);
  }
}

// Feuert ein serverseitiges Meta-"Schedule"-Event für eine Calendly-Buchung.
// Das ist die wertvollste Conversion: echte E-Mail aus dem Booking + (falls
// der Lead über den Funnel kam) gespeichertes fbp/fbc → Match-Quality 8–9/10.
// event_id = invitee-UUID → dedupt mit einem optionalen Browser-Schedule auf /funnel/danke.
async function fireScheduleCapi({ email, name, rec, payload }) {
  try {
    // DSGVO: nur senden, wenn der zugehörige Lead Tracking-Consent gegeben hat.
    if (!(rec && rec.trackingConsent)) {
      console.log('[capi] Schedule skip — kein Tracking-Consent am Lead');
      return;
    }
    const inviteeUuid = String(payload.uri || '').split('/').filter(Boolean).pop() || '';
    await sendCapiEvent({
      eventName: 'Schedule',
      eventId: inviteeUuid ? `sch_${inviteeUuid}` : undefined,
      userData: {
        email,
        // fbp/fbc nur vorhanden, wenn der Lead über den Funnel kam und wir sie gespeichert haben
        fbp: rec && rec.fbp,
        fbc: rec && rec.fbc,
      },
      customData: {
        content_name: 'discovery-call',
        ...(rec && rec.segment ? { segment: rec.segment } : {}),
        ...(rec && rec.utmCampaign ? { utm_campaign: rec.utmCampaign } : {}),
      },
      eventSourceUrl: 'https://bb-brands.de/funnel/danke',
      actionSource: 'website',
    });
  } catch (err) {
    console.error('[calendly] CAPI Schedule failed:', err.message);
  }
}

module.exports = async function handler(req, res) {
  // Health-Check
  if (req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(
      JSON.stringify({
        ok: true,
        service: 'calendly-webhook',
        signatureCheck: CALENDLY_SIGNING_KEY ? 'on' : 'off',
        capi: CAPI_ENABLED ? 'on' : 'off',
      })
    );
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const raw = await readRawBody(req);
  const verify = verifySignature(raw, req.headers['calendly-webhook-signature'] || '');
  if (!verify.ok) {
    console.warn('[calendly] signature rejected:', verify.reason);
    res.statusCode = 401;
    return res.end('invalid signature');
  }
  if (verify.skipped) {
    console.warn('[calendly] ⚠ Signaturprüfung AUS — CALENDLY_WEBHOOK_SIGNING_KEY setzen!');
  }

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    return res.end('bad json');
  }

  const kind = evt.event; // "invitee.created" | "invitee.canceled"
  const p = evt.payload || {};
  if (kind !== 'invitee.created' && kind !== 'invitee.canceled') {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ignored: kind }));
  }

  const email = String(p.email || '').toLowerCase().trim();
  const name = String(p.name || '').trim();
  const sched = p.scheduled_event || {};
  const eventName = sched.name || '';
  const startTime = sched.start_time || '';
  const tracking = p.tracking || {};
  const qa = Array.isArray(p.questions_and_answers)
    ? p.questions_and_answers.map((x) => ({
        q: String(x.question || '').slice(0, 200),
        a: String(x.answer || '').slice(0, 500),
      }))
    : [];
  // Funnel-Buchungen tragen utm_medium=funnel-result (aus unseren Embed-URLs)
  const isFunnel = (tracking.utm_medium || '') === 'funnel-result' || /audit.?termin/i.test(eventName);

  if (!email) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, note: 'no email in payload' }));
  }

  try {
    const found = await findLeadByEmail(email);
    const now = new Date().toISOString();
    const startNice = startTime
      ? new Date(startTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
      : '';

    if (kind === 'invitee.created') {
      if (found) {
        // existiert schon (z.B. Funnel-Opt-in) → updaten, NICHT duplizieren
        const rec = found.record;
        rec.status = 'call-booked';
        rec.callBookedAt = now;
        rec.callStartTime = startTime || null;
        rec.calendlyEvent = eventName;
        rec.calendlyCancelUrl = p.cancel_url || null;
        rec.calendlyRescheduleUrl = p.reschedule_url || null;
        if (qa.length) rec.callAnswers = qa;
        if (name && !rec.name) rec.name = name;
        await redis('HSET', HASH_KEY, found.id, JSON.stringify(rec));
        await sendPush(
          '📅 Call gebucht (bestehender Lead)',
          `${name || email}\n${startNice}\nSegment: ${rec.segment || '–'} · Quelle: ${isFunnel ? 'Funnel' : 'Website'}`
        );
        await fireScheduleCapi({ email, name, rec, payload: p });
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, action: 'updated', id: found.id }));
      }
      // neu (z.B. Website-Buchung) → Lead anlegen
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const rec = {
        id,
        magnet: isFunnel ? 'funnel-call' : 'website-call',
        email,
        name,
        status: 'call-booked',
        createdAt: now,
        callBookedAt: now,
        callStartTime: startTime || null,
        calendlyEvent: eventName,
        calendlyCancelUrl: p.cancel_url || null,
        calendlyRescheduleUrl: p.reschedule_url || null,
        callAnswers: qa,
        utmSource: tracking.utm_source || '',
        utmMedium: tracking.utm_medium || '',
        utmCampaign: tracking.utm_campaign || '',
        consentNewsletter: false,
        consentNewsletterAt: null,
      };
      await redis('HSET', HASH_KEY, id, JSON.stringify(rec));
      await sendPush(
        '📅 Neuer Call gebucht',
        `${name || email}\n${startNice}\nQuelle: ${isFunnel ? 'Funnel' : 'Website'}`
      );
      await fireScheduleCapi({ email, name, rec, payload: p });
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, action: 'created', id }));
    }

    // invitee.canceled
    if (found) {
      const rec = found.record;
      rec.callCanceledAt = now;
      if (rec.status === 'call-booked') rec.status = 'contacted';
      await redis('HSET', HASH_KEY, found.id, JSON.stringify(rec));
      await sendPush('❌ Call abgesagt', `${name || email}\n${startNice}`);
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, action: 'canceled', found: !!found }));
  } catch (err) {
    console.error('[calendly] handler error:', err.message);
    // 500 → Calendly retried bei transienten Fehlern (z.B. Redis kurz weg) automatisch
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: err.message }));
  }
};
