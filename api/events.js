// ============================================================
//  BB Brands — Funnel Event Store  (/api/events)
//  ------------------------------------------------------------
//  First-Party Analytics-Schicht für den Profit-Quiz-Funnel.
//  Erfasst JEDEN Schritt (LP-View → QuizStart → pro Frage
//  erreicht/beantwortet → Gate → Lead → Ergebnis) anonym über
//  eine Session-ID (bb_sid), damit wir
//    (a) die Absprungrate nach JEDER einzelnen Frage sehen,
//    (b) die komplette Reise EINES Leads nachvollziehen,
//    (c) unabhängig von GA4/Consent ein eigenes Bild haben.
//
//  Meta-Pixel-Events (Retargeting) laufen NICHT hier, sondern
//  consent-gated über bb-tracking.js. Dieser Store ist rein
//  first-party (kein Dritt-Land, keine PII außer optional der
//  E-Mail die der Lead selbst einträgt) → DSGVO: berechtigtes
//  Interesse / eigene Reichweitenmessung.
//
//  Storage: Upstash Redis (REST) — identisch zu leads.js.
//    - bb:events            Liste aller Events (capped, für Aggregate)
//    - bb:j:{sid}           Liste pro Session (TTL 60d, für Journey)
//
//  Routes:
//    POST /api/events       → ein Event anhängen (public, anonym)
//    GET  /api/events       → Aggregate (admin)
//    GET  /api/events?sid=X → Journey einer Session (admin)
//    GET  /api/events?days=7→ Zeitfenster (default 90)
//
//  Env (gleich wie leads.js):
//    KV_REST_API_URL  / UPSTASH_REDIS_REST_URL
//    KV_REST_API_TOKEN/ UPSTASH_REDIS_REST_TOKEN
//    ADMIN_TOKEN
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

const EVENTS_KEY = 'bb:events';
const EVENTS_CAP = 50000;            // Ringpuffer: älteste fallen raus
const SESSION_TTL = 60 * 60 * 24 * 60; // 60 Tage

// Die 8 Quiz-Fragen — Reihenfolge + Kurzlabel EXAKT wie im Quiz
// (funnel/diagnose/index.html · QUESTIONS[]). step = index+1.
const QUIZ_QUESTIONS = [
  { step: 1, qid: 'tier',      label: 'Monatsumsatz' },
  { step: 2, qid: 'marge',     label: 'Marge nach allem' },
  { step: 3, qid: 'cac',       label: 'CAC-Entwicklung' },
  { step: 4, qid: 'retention', label: 'Retention / E-Mail' },
  { step: 5, qid: 'trend',     label: 'Umsatz-Trend 3 Mon.' },
  { step: 6, qid: 'scale',     label: 'Skaliert bei 2× Budget?' },
  { step: 7, qid: 'bremse',    label: 'Größte Bremse' },
  { step: 8, qid: 'invest',    label: 'Investitionsbereitschaft' },
];

// ----- Redis helper (single REST call) — identisch zu leads.js -----
async function redis(...command) {
  if (!KV_URL || !KV_TOKEN) throw new Error('Redis not configured (missing env vars)');
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.result;
}

function str(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
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
async function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Whitelist der Event-Namen die der Store akzeptiert (keine Müll-Events).
const ALLOWED = new Set([
  'DiagnoseView', 'QuizStart', 'QuizStep', 'QuizAnswer',
  'QuizComplete', 'Lead', 'QualifiedLead', 'QuizResult', 'PageView',
  // Outbound Video-Pitch (videos.bb-brands.de/{prospect})
  'PitchGenerated', 'PitchView', 'PitchVideoPlay', 'PitchVideoProgress',
  'PitchVideoComplete', 'PitchCTAClick',
]);

// Attribution kompakt + sicher übernehmen (src/cmp/cnt/med/trm).
function cleanAttr(a) {
  if (!a || typeof a !== 'object') return {};
  const out = {};
  ['src', 'cmp', 'cnt', 'med', 'trm'].forEach((k) => {
    if (a[k]) out[k] = str(String(a[k]), 80);
  });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  try {
    // ============ POST: ein Event anhängen (public) ============
    if (req.method === 'POST') {
      const body = req.body || (await readJsonBody(req));
      const name = str(body.name, 40);
      const sid = str(body.sid, 60);
      if (!name || !ALLOWED.has(name) || !sid) {
        return jsonResponse(res, 400, { ok: false, error: 'invalid event' });
      }
      // Params kompakt + sicher (max 12 Felder, kurze Strings/Zahlen)
      const params = {};
      if (body.params && typeof body.params === 'object') {
        let n = 0;
        for (const k of Object.keys(body.params)) {
          if (n++ >= 12) break;
          const v = body.params[k];
          if (typeof v === 'number') params[k.slice(0, 30)] = v;
          else params[k.slice(0, 30)] = str(String(v), 80);
        }
      }
      const evt = {
        sid,
        name,
        params,
        path: str(body.path, 120),
        ref: str(body.ref, 120),       // referrer-domain (optional, vom Client)
        attr: cleanAttr(body.attr),    // First-Touch UTMs (src/cmp/cnt/med/trm)
        ts: Date.now(),
      };
      const payload = JSON.stringify(evt);

      // Best-effort, niemals die Response blockieren / Fehler werfen
      try {
        await Promise.allSettled([
          redis('RPUSH', EVENTS_KEY, payload),
          redis('RPUSH', `bb:j:${sid}`, payload),
          redis('EXPIRE', `bb:j:${sid}`, String(SESSION_TTL)),
        ]);
        // Ringpuffer beschneiden (gelegentlich reicht, aber günstig genug)
        redis('LTRIM', EVENTS_KEY, String(-EVENTS_CAP), '-1').catch(() => {});
      } catch (_) { /* ignore */ }

      return jsonResponse(res, 200, { ok: true });
    }

    // ============ GET: Aggregate / Journey (admin) ============
    if (req.method === 'GET') {
      if (!checkAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });

      const url = new URL(req.url, 'http://x');
      const sid = str(url.searchParams.get('sid') || '', 60);

      // --- Journey einer Session ---
      if (sid) {
        const raw = (await redis('LRANGE', `bb:j:${sid}`, '0', '-1')) || [];
        const journey = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } })
          .filter(Boolean).sort((a, b) => a.ts - b.ts);
        return jsonResponse(res, 200, { ok: true, sid, journey });
      }

      // --- Pitch / Outbound-Engagement (videos.bb-brands.de/{prospect}) ---
      if (url.searchParams.get('view') === 'pitch') {
        const raw2 = (await redis('LRANGE', EVENTS_KEY, '0', '-1')) || [];
        const P = {};
        const rec = (slug) => P[slug] || (P[slug] = {
          prospect: slug, company: '', generated: false, generatedAt: 0,
          views: 0, visitors: new Set(), firstView: 0, lastView: 0, play: 0, videoPct: 0, cta: 0,
        });
        for (const r of raw2) {
          let e; try { e = JSON.parse(r); } catch { continue; }
          if (!e || !e.name || e.name.indexOf('Pitch') !== 0) continue;
          const slug = (e.params && e.params.prospect) || (e.path || '').split('/').filter(Boolean)[0] || '?';
          if (slug.indexOf('__') === 0) continue;   // Test-/Platzhalter-Slugs ausblenden
          const p = rec(slug);
          if (e.name === 'PitchGenerated') {
            p.generated = true;
            if (!p.generatedAt || e.ts < p.generatedAt) p.generatedAt = e.ts;
            if (e.params && e.params.company) p.company = e.params.company;
          } else if (e.name === 'PitchView') {
            p.views++; if (e.sid) p.visitors.add(e.sid);
            if (!p.firstView || e.ts < p.firstView) p.firstView = e.ts;
            if (e.ts > p.lastView) p.lastView = e.ts;
          } else if (e.name === 'PitchVideoPlay') { p.play++; }
          else if (e.name === 'PitchVideoProgress') { const pct = Number(e.params && e.params.pct) || 0; if (pct > p.videoPct) p.videoPct = pct; }
          else if (e.name === 'PitchVideoComplete') { p.videoPct = 100; }
          else if (e.name === 'PitchCTAClick') { p.cta++; }
        }
        const prospects = Object.values(P).map((p) => ({
          prospect: p.prospect, company: p.company, generated: p.generated, generatedAt: p.generatedAt,
          opened: p.views > 0, views: p.views, visitors: p.visitors.size,
          firstView: p.firstView, lastView: p.lastView, videoPlay: p.play > 0, videoPct: p.videoPct, cta: p.cta,
        })).sort((a, b) => (Number(b.opened) - Number(a.opened)) || (b.lastView - a.lastView) || (b.generatedAt - a.generatedAt));
        return jsonResponse(res, 200, { ok: true, prospects });
      }

      // --- Aggregate über Zeitfenster (+ optionale Kampagnen-Filter) ---
      const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '90', 10) || 90));
      const since = Date.now() - days * 86400000;
      const fSrc = str(url.searchParams.get('source') || '', 80);
      const fCmp = str(url.searchParams.get('campaign') || '', 80);
      const fCnt = str(url.searchParams.get('content') || '', 80);
      const raw = (await redis('LRANGE', EVENTS_KEY, '0', '-1')) || [];

      const funnel = { DiagnoseView: 0, QuizStart: 0, QuizComplete: 0, Lead: 0, QualifiedLead: 0, QuizResult: 0 };
      const reached = {};   // step → distinct sessions die Frage gesehen haben
      const answered = {};  // step → distinct sessions die Frage beantwortet haben
      for (let i = 1; i <= 8; i++) { reached[i] = new Set(); answered[i] = new Set(); }
      const setOf = { DiagnoseView: new Set(), QuizStart: new Set(), QuizComplete: new Set(), Lead: new Set(), QualifiedLead: new Set(), QuizResult: new Set() };
      const pages = {};
      const segments = {};
      const byDay = {};     // 'YYYY-MM-DD' → {start, lead}
      // Kampagnen-Breakdown (immer über ALLE Events, damit Filter-Dropdown vollständig)
      const campMap = {};   // 'src|cmp|cnt' → {src,cmp,cnt,start,lead}
      let total = 0;

      for (const r of raw) {
        let e; try { e = JSON.parse(r); } catch { continue; }
        if (!e || e.ts < since) continue;
        const a = e.attr || {};

        // Kampagnen-Liste (ungefiltert) — nur aus Start/Lead, sonst zu viel Rauschen
        if (e.name === 'QuizStart' || e.name === 'Lead') {
          const key = (a.src || '') + '|' + (a.cmp || '') + '|' + (a.cnt || '');
          campMap[key] = campMap[key] || { src: a.src || '', cmp: a.cmp || '', cnt: a.cnt || '', start: 0, lead: 0 };
          if (e.name === 'QuizStart') campMap[key].start++;
          if (e.name === 'Lead') campMap[key].lead++;
        }

        // Filter anwenden (leerer Filter = alles)
        if (fSrc && (a.src || '') !== fSrc) continue;
        if (fCmp && (a.cmp || '') !== fCmp) continue;
        if (fCnt && (a.cnt || '') !== fCnt) continue;

        total++;
        const sd = e.sid || '?';
        if (e.name === 'PageView') { pages[e.path] = (pages[e.path] || 0) + 1; continue; }
        if (e.name === 'QuizStep') {
          const s = Number(e.params && e.params.step) || 0;
          if (reached[s]) reached[s].add(sd);
        } else if (e.name === 'QuizAnswer') {
          const s = Number(e.params && e.params.step) || 0;
          if (answered[s]) answered[s].add(sd);
        } else if (setOf[e.name]) {
          setOf[e.name].add(sd);
          if (e.name === 'QuizResult') {
            const seg = (e.params && e.params.segment) || 'unknown';
            segments[seg] = (segments[seg] || 0) + 1;
          }
        }
        // Tages-Trend (Start vs. Lead)
        const day = new Date(e.ts).toISOString().slice(0, 10);
        byDay[day] = byDay[day] || { start: 0, lead: 0 };
        if (e.name === 'QuizStart') byDay[day].start++;
        if (e.name === 'Lead') byDay[day].lead++;
      }

      funnel.DiagnoseView = setOf.DiagnoseView.size;
      funnel.QuizStart = setOf.QuizStart.size;
      funnel.QuizComplete = setOf.QuizComplete.size;
      funnel.Lead = setOf.Lead.size;
      funnel.QualifiedLead = setOf.QualifiedLead.size;
      funnel.QuizResult = setOf.QuizResult.size;

      // Kampagnen sortiert (meiste Starts zuerst), Top 40
      const campaigns = Object.values(campMap)
        .sort((x, y) => y.start - x.start).slice(0, 40);

      // Pro-Frage-Auswertung mit Absprung
      const questions = QUIZ_QUESTIONS.map((q) => {
        const r = reached[q.step].size;
        const a = answered[q.step].size;
        const nextReached = q.step < 8 ? reached[q.step + 1].size : funnel.QuizComplete;
        const dropAfter = r > 0 ? Math.round((1 - nextReached / r) * 100) : 0;
        return { ...q, reached: r, answered: a, nextReached, dropAfter };
      });

      return jsonResponse(res, 200, {
        ok: true,
        windowDays: days,
        totalEvents: total,
        filter: { source: fSrc, campaign: fCmp, content: fCnt },
        funnel,
        questions,
        pages,
        segments,
        campaigns,
        byDay,
      });
    }

    res.statusCode = 405;
    return res.end('Method Not Allowed');
  } catch (err) {
    console.error('[/api/events]', err && err.message);
    return jsonResponse(res, 500, { ok: false, error: 'server error' });
  }
};
