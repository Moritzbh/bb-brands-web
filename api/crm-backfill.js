// ============================================================
//  Einmaliger Backfill: Upstash bb:leads → Supabase (bb-os CRM)
//  ------------------------------------------------------------
//  Liest ALLE Legacy-Leads aus Upstash und schreibt sie über das
//  bestehende writeToCrm() ins neue Supabase-Modell. Idempotent
//  (Dedup per Email), mehrfach gefahrlos ausführbar.
//
//  Schutz: token-gated. Setze CRM_BACKFILL_TOKEN (oder nutze
//  BB_ADMIN_TOKEN) und rufe auf mit ?token=…  Ohne gesetzten Token
//  antwortet der Endpoint 403 (nie offen).
//
//  Aufruf:
//    GET /api/crm-backfill?token=XXX&dry=1   → nur zählen (read-only)
//    GET /api/crm-backfill?token=XXX         → echter Backfill
//
//  Nach erfolgreichem Cutover diese Datei löschen.
// ============================================================
const { writeToCrm, sbConfigured } = require('./_crm');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HASH_KEY = 'bb:leads';

async function redis(...command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).result;
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const need = process.env.CRM_BACKFILL_TOKEN || process.env.BB_ADMIN_TOKEN || '';
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || req.headers['x-token'] || '';
  if (!need || token !== need) return json(res, 403, { ok: false, error: 'forbidden' });
  if (!KV_URL || !KV_TOKEN) return json(res, 500, { ok: false, error: 'upstash nicht konfiguriert' });
  if (!sbConfigured()) return json(res, 500, { ok: false, error: 'supabase nicht konfiguriert' });

  const dry = url.searchParams.get('dry') === '1';

  // HGETALL → [field, value, field, value, ...], value = JSON-String
  const all = (await redis('HGETALL', HASH_KEY)) || [];
  const records = [];
  for (let i = 0; i < all.length; i += 2) {
    try {
      const rec = JSON.parse(all[i + 1]);
      if (rec && rec.email) records.push(rec);
    } catch { /* kaputten Eintrag überspringen */ }
  }

  const byFunnel = {};
  records.forEach((r) => { const f = r.magnet || 'lead'; byFunnel[f] = (byFunnel[f] || 0) + 1; });

  if (dry) {
    return json(res, 200, { ok: true, dry: true, leads_in_upstash: records.length, byFunnel });
  }

  let ok = 0, fail = 0;
  for (const rec of records) {
    try {
      const r = await writeToCrm(rec);
      if (r && r.contactId) ok++; else fail++;
    } catch { fail++; }
  }

  return json(res, 200, { ok: true, dry: false, leads_in_upstash: records.length, migrated: ok, failed: fail, byFunnel });
};
