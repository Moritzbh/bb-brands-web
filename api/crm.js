// ============================================================
//  BB Brands CRM — Read-/Admin-API (neues Entitäten-Modell, Supabase)
//  ------------------------------------------------------------
//  Alle Routen admin-gated (ADMIN_TOKEN, wie scans.js/events.js).
//  Ein File, Dispatch über ?r= + HTTP-Methode (Vercel mappt /api/crm).
//
//  GET  /api/crm?r=contacts          → Liste (Contact + offener Deal + Score + letzte Submission)
//  GET  /api/crm?r=contact&id=…      → Contact + Submissions(Timeline) + Deal + Activities
//  PATCH/api/crm  {dealId, …}        → Deal aktualisieren (+ Auto-Activity)
//  POST /api/crm?r=activity {contactId,…} → Notiz/Call loggen
//
//  No-Op-Empty wenn SUPABASE_* fehlt → UI bleibt leer statt Fehler.
// ============================================================
const { sb, sbConfigured, enc } = require('./_crm');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function checkAdmin(req) {
  const q = req.query || {};
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = q.token || auth.replace(/^Bearer\s+/i, '');
  return ADMIN_TOKEN && token && token === ADMIN_TOKEN;
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const ACTIVE = ['new', 'qualified', 'call-booked', 'call-done', 'proposal', 'negotiation'];
function daysSince(s) { if (!s) return 999; return Math.floor((Date.now() - new Date(s).getTime()) / 86400000); }

// ----- Lead-Score: ICP-Fit + Pain + Wert + Bereitschaft + Aktualität → 0-100 / A·B·C.
// Aus der RELEVANTESTEN Submission (jüngste profit-rechner, sonst jüngste).
function relevantSub(subs) {
  if (!Array.isArray(subs) || !subs.length) return null;
  const sorted = subs.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return sorted.find((s) => s.funnel === 'profit-rechner') || sorted[0];
}
function scoreOf(subs) {
  const s = relevantSub(subs);
  if (!s) return { n: 0, grade: 'C' };
  const p = s.payload || {};
  const tier = Number(p.tier) || 0;
  const seg = p.segment || '';
  const leak = Number(p.leakMo) || 0;
  const qual = p.qualification || '';
  let n = 0;
  n += tier >= 3 ? 40 : tier === 2 ? 30 : (seg && seg !== 'tier1') ? 18 : 10;
  n += seg === 'red' ? 20 : seg === 'yellow' ? 14 : seg === 'green' ? 6 : 4;
  n += leak >= 20000 ? 20 : leak >= 10000 ? 15 : leak >= 5000 ? 10 : leak > 0 ? 5 : 0;
  n += qual === 'hot' ? 10 : qual === 'warm' ? 7 : qual === 'diy' ? 3 : 0;
  const d = daysSince(s.created_at);
  n += d <= 1 ? 10 : d <= 3 ? 7 : d <= 7 ? 4 : 0;
  if (n > 100) n = 100;
  return { n: Math.round(n), grade: n >= 70 ? 'A' : n >= 40 ? 'B' : 'C' };
}
function openDealOf(deals) {
  if (!Array.isArray(deals) || !deals.length) return null;
  return deals.find((d) => ACTIVE.indexOf(d.stage) >= 0)
    || deals.find((d) => d.stage === 'nurture')
    || deals.slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!checkAdmin(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!sbConfigured()) return json(res, 200, { ok: true, contacts: [], note: 'Supabase nicht konfiguriert' });

  const q = req.query || {};
  const r = q.r || q.resource || '';

  try {
    // ---------- GET contacts (Liste) ----------
    if (req.method === 'GET' && (r === 'contacts' || r === '')) {
      const rows = await sb('contacts?select=' + enc(
        'id,email,name,phone,company,website,tags,created_at,updated_at,' +
        'deals(id,stage,value_eur,next_action,next_follow_up,disposition,updated_at,created_at),' +
        'submissions(funnel,payload,created_at)'
      ) + '&order=updated_at.desc&limit=2000') || [];
      const contacts = rows.map((c) => {
        const deal = openDealOf(c.deals);
        const sub = relevantSub(c.submissions);
        return {
          id: c.id, email: c.email, name: c.name, phone: c.phone,
          company: c.company, website: c.website, tags: c.tags || [],
          createdAt: c.created_at, updatedAt: c.updated_at,
          subCount: (c.submissions || []).length,
          latestFunnel: sub ? sub.funnel : null,
          latestSubAt: sub ? sub.created_at : null,
          segment: sub && sub.payload ? sub.payload.segment || null : null,
          leakMo: sub && sub.payload ? sub.payload.leakMo || null : null,
          score: scoreOf(c.submissions),
          deal: deal ? {
            id: deal.id, stage: deal.stage, value_eur: deal.value_eur,
            next_action: deal.next_action, next_follow_up: deal.next_follow_up,
            disposition: deal.disposition,
          } : null,
        };
      });
      return json(res, 200, { ok: true, contacts, count: contacts.length });
    }

    // ---------- GET contact (Detail) ----------
    if (req.method === 'GET' && r === 'contact') {
      const id = String(q.id || '');
      if (!id) return json(res, 400, { ok: false, error: 'id fehlt' });
      const rows = await sb('contacts?id=eq.' + enc(id) + '&select=' + enc(
        '*,deals(*),submissions(*),activities(*)'
      ) + '&limit=1');
      const c = rows && rows[0];
      if (!c) return json(res, 404, { ok: false, error: 'not found' });
      (c.submissions || []).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      (c.activities || []).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return json(res, 200, { ok: true, contact: c, deal: openDealOf(c.deals), score: scoreOf(c.submissions) });
    }

    // ---------- PATCH deal ----------
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const dealId = String(body.dealId || '');
      if (!dealId) return json(res, 400, { ok: false, error: 'dealId fehlt' });
      const cur = (await sb('deals?id=eq.' + enc(dealId) + '&select=*&limit=1'))[0];
      if (!cur) return json(res, 404, { ok: false, error: 'deal not found' });

      const STAGES = ['new', 'qualified', 'call-booked', 'call-done', 'proposal', 'negotiation', 'won', 'lost', 'nurture'];
      const DISPOS = ['', 'connected', 'no-answer', 'showed', 'no-show', 'rescheduled', 'interested', 'not-interested', 'proposal-sent', 'closed'];
      const patch = {};
      const acts = [];
      if (typeof body.stage === 'string' && STAGES.includes(body.stage) && body.stage !== cur.stage) {
        patch.stage = body.stage;
        acts.push({ type: 'stage_change', text: `Stufe: ${cur.stage} → ${body.stage}`, meta: { from: cur.stage, to: body.stage } });
      }
      if (body.value_eur !== undefined) { const v = Number(body.value_eur); patch.value_eur = Number.isFinite(v) && v >= 0 ? Math.round(v) : null; }
      if (body.next_action !== undefined) patch.next_action = String(body.next_action || '').slice(0, 300);
      if (body.next_follow_up !== undefined) patch.next_follow_up = body.next_follow_up || null;
      if (body.disposition !== undefined && DISPOS.includes(body.disposition)) {
        patch.disposition = body.disposition;
        if (body.disposition) { patch.last_contact = new Date().toISOString(); acts.push({ type: 'disposition', text: `Disposition: ${body.disposition}` }); }
      }
      if (body.lost_reason !== undefined) patch.lost_reason = String(body.lost_reason || '').slice(0, 120);
      if (!Object.keys(patch).length && !body.addNote) return json(res, 400, { ok: false, error: 'nichts zu aktualisieren' });

      let deal = cur;
      if (Object.keys(patch).length) {
        deal = (await sb('deals?id=eq.' + enc(dealId), { method: 'PATCH', body: patch, prefer: 'return=representation' }))[0];
      }
      if (body.addNote) { patch.last_contact = new Date().toISOString(); acts.push({ type: 'note', text: String(body.addNote).slice(0, 2000) }); }
      for (const a of acts) {
        await sb('activities', { method: 'POST', body: [{ contact_id: cur.contact_id, deal_id: dealId, type: a.type, text: a.text, meta: a.meta || {} }] });
      }
      return json(res, 200, { ok: true, deal });
    }

    // ---------- POST activity ----------
    if (req.method === 'POST' && r === 'activity') {
      const body = await readBody(req);
      const contactId = String(body.contactId || '');
      const text = String(body.text || '').slice(0, 2000);
      if (!contactId || !text) return json(res, 400, { ok: false, error: 'contactId + text nötig' });
      const type = ['note', 'call'].includes(body.type) ? body.type : 'note';
      const ins = await sb('activities', { method: 'POST', body: [{ contact_id: contactId, deal_id: body.dealId || null, type, text }], prefer: 'return=representation' });
      // last_contact am aktiven Deal nachziehen
      if (body.dealId) await sb('deals?id=eq.' + enc(String(body.dealId)), { method: 'PATCH', body: { last_contact: new Date().toISOString() } }).catch(() => {});
      return json(res, 200, { ok: true, activity: ins && ins[0] });
    }

    return json(res, 405, { ok: false, error: 'method/route not allowed' });
  } catch (err) {
    console.error('[/api/crm] error:', err.message);
    return json(res, 500, { ok: false, error: 'server error' });
  }
};
