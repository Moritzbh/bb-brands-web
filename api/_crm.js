// ============================================================
//  BB Brands CRM — Daten-Layer (Supabase Postgres via PostgREST)
//  ------------------------------------------------------------
//  Sauberes Entitäten-Modell: contacts / submissions / deals / activities.
//  Zugriff server-seitig über den Service-Role-Key (bypasst RLS).
//  Zero-dependency: PostgREST über fetch, identischer Stil wie der
//  Upstash-REST-Zugriff in leads.js/events.js.
//
//  Env: SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
//  No-Op (sbConfigured()===false) wenn Env fehlt → nichts bricht vor dem Setup.
// ============================================================
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function sbConfigured() { return !!(SB_URL && SB_KEY); }

// ----- PostgREST-Call -----
async function sb(path, { method = 'GET', body, prefer } = {}) {
  if (!sbConfigured()) throw new Error('Supabase not configured');
  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leer/non-json */ }
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

const enc = encodeURIComponent;
function clean(v) { return v != null && v !== '' && v !== 'test' ? v : null; }

// ----- contacts: upsert per E-Mail (füllt fehlende Felder, überschreibt keine guten) -----
async function upsertContact(c) {
  const email = String(c.email || '').toLowerCase().trim();
  if (!email) return null;
  const found = await sb(`contacts?email=eq.${enc(email)}&select=*&limit=1`);
  if (found && found[0]) {
    const cur = found[0];
    const patch = {};
    // clean() filtert leer/'test' → eine echte Angabe gewinnt über leer ODER Platzhalter,
    // überschreibt aber nie eine bereits echte Angabe (kein Clobber guter Daten).
    if (!clean(cur.name) && clean(c.name)) patch.name = c.name;
    if (!clean(cur.phone) && clean(c.phone)) patch.phone = c.phone;
    if (!clean(cur.company) && clean(c.company)) patch.company = c.company;
    if (!clean(cur.website) && clean(c.website)) patch.website = c.website;
    if (c.consent) patch.consent = Object.assign({}, cur.consent || {}, c.consent);
    if (Array.isArray(c.tags) && c.tags.length) {
      patch.tags = Array.from(new Set([...(cur.tags || []), ...c.tags]));
    }
    if (Object.keys(patch).length) {
      const upd = await sb(`contacts?id=eq.${cur.id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      return (upd && upd[0]) || cur;
    }
    return cur;
  }
  const ins = await sb('contacts', {
    method: 'POST',
    body: [{
      email,
      name: c.name || null,
      phone: clean(c.phone),
      company: clean(c.company),
      website: clean(c.website),
      first_touch: c.firstTouch || {},
      consent: c.consent || {},
      tags: Array.isArray(c.tags) ? c.tags : [],
    }],
    prefer: 'return=representation',
  });
  return ins && ins[0];
}

// ----- submissions: append-only (nie überschreiben) -----
async function insertSubmission(s) {
  const ins = await sb('submissions', {
    method: 'POST',
    body: [{
      contact_id: s.contactId,
      funnel: s.funnel,
      payload: s.payload || {},
      attribution: s.attribution || {},
      ip: s.ip || null,
      user_agent: s.userAgent || null,
    }],
    prefer: 'return=representation',
  });
  return ins && ins[0];
}

// ----- deals: max. 1 aktiver Deal pro Contact (sonst neuen 'new' anlegen) -----
async function ensureOpenDeal(contactId) {
  const open = await sb(`deals?contact_id=eq.${contactId}&stage=not.in.(won,lost)&select=*&limit=1`);
  if (open && open[0]) return open[0];
  const ins = await sb('deals', { method: 'POST', body: [{ contact_id: contactId, stage: 'new' }], prefer: 'return=representation' });
  return ins && ins[0];
}

// ----- activities -----
async function addActivity(a) {
  return sb('activities', {
    method: 'POST',
    body: [{ contact_id: a.contactId, deal_id: a.dealId || null, type: a.type || 'note', text: a.text || '', meta: a.meta || {} }],
    prefer: 'return=representation',
  });
}

// ----- events: append-only Verhaltens-Event (Segment-Muster, bb-os) -----
async function insertEvent(ev) {
  try {
    return await sb('events', {
      method: 'POST',
      body: [{
        contact_id: ev.contactId,
        name: ev.name,
        source: ev.source || 'web',
        funnel: ev.funnel || null,
        value_eur: ev.valueEur != null ? ev.valueEur : null,
        props: ev.props || {},
      }],
      prefer: 'return=representation',
    });
  } catch (err) {
    console.error('[crm] insertEvent failed:', err.message);
    return null;
  }
}

// ----- Mapping: ein leads.js-`record` → Entitäten -----
const FUNNEL_OF = {
  'profit-rechner': 'profit-rechner',
  'quiz-diagnose': 'quiz-diagnose',
  'youtube-case': 'youtube-case',
  'whatsapp-chat': 'whatsapp-chat',
  'erstgespraech': 'erstgespraech',
  'style-guide': 'style-guide',
  'ai-readiness-check': 'ai-readiness-check',
  'contact': 'contact-import',
};
function recordToEntities(r) {
  const funnel = FUNNEL_OF[r.magnet] || r.magnet || 'lead';
  const website = (r.profitRechner && r.profitRechner.website) || r.website || null;
  const contact = {
    email: r.email,
    name: r.name || null,
    phone: r.phone || null,
    company: r.brand || r.company || null,
    website,
    consent: {
      contact: !!(r.consentContact || r.consentChat || r.consentGuide),
      newsletter: !!r.consentNewsletter,
      tracking: !!r.trackingConsent,
      ts: r.createdAt || null,
    },
    tags: Array.isArray(r.campaigns) ? r.campaigns.slice() : [],
    firstTouch: {
      utm_source: r.utmSource || '', utm_medium: r.utmMedium || '',
      utm_campaign: r.utmCampaign || '', referrer_domain: r.referrerDomain || '',
      landing_path: r.landingPath || '',
    },
  };
  let payload = {};
  if (funnel === 'profit-rechner') {
    payload = Object.assign({}, r.profitRechner || {}, {
      leakMo: r.leakMo, leakYr: r.leakYr, segment: r.segment, tier: r.tier,
      qualification: r.qualification, deliveryPreference: r.deliveryPreference || null,
    });
  } else if (funnel === 'quiz-diagnose') {
    payload = { answers: r.answers || [], profitScore: r.profitScore, growthScore: r.growthScore, bias: r.bias, segment: r.segment, tier: r.tier, qualification: r.qualification };
  } else if (funnel === 'youtube-case') {
    payload = r.caseApplication || { shop: r.website, revenue: r.revenue, pain: r.pain };
  } else if (funnel === 'whatsapp-chat') {
    payload = { pain: r.pain, context: r.context };
  } else if (funnel === 'erstgespraech') {
    payload = { brand: r.brand, website: r.website, wasVerkauft: r.wasVerkauft, umsatz: r.umsatz, baustelle: r.baustelle, timeline: r.timeline, budget: r.budget };
  } else if (funnel === 'style-guide' || funnel === 'ai-readiness-check') {
    payload = { company: r.company, website: r.website, delivery: r.delivery, consentReference: !!r.consentReference };
  } else if (funnel === 'contact-import') {
    payload = { source: r.source || '', importSources: r.importSources || [] };
  }
  const attribution = {
    utm_source: r.utmSource || '', utm_medium: r.utmMedium || '', utm_campaign: r.utmCampaign || '',
    utm_content: r.utmContent || '', utm_term: r.utmTerm || '',
    referrer: r.referrer || '', referrer_domain: r.referrerDomain || '',
    landing_path: r.landingPath || '', submit_path: r.submitPath || '',
    fbp: r.fbp || '', fbc: r.fbc || '', sid: r.sid || '',
  };
  return { funnel, contact, payload, attribution, hasDeal: funnel !== 'contact-import' };
}

// ----- Haupt-Einstieg: schreibt einen leads.js-`record` ins neue Modell.
//  Best-effort: No-Op ohne Env, wirft NIE (blockiert den Lead-Save nicht). -----
async function writeToCrm(record) {
  if (!sbConfigured() || !record || !record.email) return null;
  try {
    const e = recordToEntities(record);
    const contact = await upsertContact(e.contact);
    if (!contact) return null;
    const sub = await insertSubmission({
      contactId: contact.id, funnel: e.funnel, payload: e.payload,
      attribution: e.attribution, ip: record.ip, userAgent: record.userAgent,
    });
    let deal = null;
    if (e.hasDeal) deal = await ensureOpenDeal(contact.id);
    await insertEvent({ contactId: contact.id, name: 'funnel_submit', source: 'web', funnel: e.funnel, props: e.attribution });
    return { contactId: contact.id, submissionId: sub && sub.id, dealId: deal && deal.id };
  } catch (err) {
    console.error('[crm] writeToCrm failed:', err.message);
    return null;
  }
}

module.exports = {
  sb, sbConfigured, enc, clean,
  upsertContact, insertSubmission, ensureOpenDeal, addActivity, insertEvent,
  recordToEntities, writeToCrm,
};
