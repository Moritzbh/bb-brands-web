/* ============================================================
   BB Brands — Funnel Event Layer  (bb-funnel-tracking.js)
   ------------------------------------------------------------
   Dünne Schicht ÜBER bb-tracking.js. Pro Funnel-Schritt:
     1) BBTracking.track(name, params)  → GA4 + Meta-Pixel
        (consent-gated + gepuffert; Pixel-Events = Retargeting-
         Audiences "LP besucht / Frage 3 erreicht / Quiz fertig")
     2) POST /api/events                → eigener First-Party-Store
        (anonyme bb_sid · Absprung pro Frage · Journey pro Lead)

   Einbinden NACH bb-tracking.js:
     <script src="/assets/js/bb-tracking-config.js"></script>
     <script src="/assets/js/bb-tracking.js" defer></script>
     <script src="/assets/js/bb-funnel-tracking.js" defer></script>

   Public API:
     BBFunnel.sid                      anonyme Session-ID
     BBFunnel.fire(name, params)       Event feuern (Pixel/GA4 + Store)
     BBFunnel.step(n, qid)             Frage n erreicht
     BBFunnel.answer(n, qid, i, label) Frage n beantwortet
     BBFunnel.complete()               Gate erreicht (alle Fragen)
     BBFunnel.lead(segment, tier)      Lead (nur Store; Pixel-Lead
                                       feuert das Quiz selbst via track)
   ============================================================ */
(function () {
  'use strict';

  // ---------- anonyme, first-party Session-ID ----------
  var SID_KEY = 'bb_sid';
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  var sid = '';
  try {
    sid = localStorage.getItem(SID_KEY) || '';
    if (!sid) { sid = uuid(); localStorage.setItem(SID_KEY, sid); }
  } catch (e) { sid = uuid(); }

  function refDomain() {
    try {
      var r = document.referrer; if (!r) return '';
      var u = new URL(r);
      return u.hostname === location.hostname ? '' : u.hostname;
    } catch (e) { return ''; }
  }

  // ---------- Attribution (First-Touch UTMs) ----------
  // bb-tracking.js speichert First-Touch-UTMs in localStorage 'bb_utms'.
  // Wir hängen sie KOMPAKT an jedes Event → Funnel pro Kampagne/Creative
  // filterbar. Für Ad-Granularität in Meta die Ad-URLs mit Makros bauen:
  //   utm_source=meta&utm_campaign={{campaign.name}}
  //   &utm_content={{ad.name}}&utm_term={{adset.name}}
  function attr() {
    try {
      var u = JSON.parse(localStorage.getItem('bb_utms') || '{}');
      var a = {};
      if (u.utm_source)   a.src = String(u.utm_source).slice(0, 80);
      if (u.utm_campaign) a.cmp = String(u.utm_campaign).slice(0, 80);
      if (u.utm_content)  a.cnt = String(u.utm_content).slice(0, 80);
      if (u.utm_medium)   a.med = String(u.utm_medium).slice(0, 40);
      if (u.utm_term)     a.trm = String(u.utm_term).slice(0, 80);
      return a;
    } catch (e) { return {}; }
  }

  // ---------- First-Party-Store (best effort, blockiert nie) ----------
  function store(name, params) {
    try {
      var data = JSON.stringify({
        sid: sid, name: name, params: params || {},
        path: location.pathname, ref: refDomain(), attr: attr(),
      });
      // keepalive → geht auch beim Seitenwechsel (z.B. Redirect aufs Ergebnis) durch
      fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data, keepalive: true,
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  // ---------- Haupt-Feuer: Pixel/GA4 (consent-gated) + Store ----------
  function fire(name, params) {
    params = params || {};
    try { if (window.BBTracking && BBTracking.track) BBTracking.track(name, params); } catch (e) {}
    store(name, params);
  }

  // ---------- Public API ----------
  window.BBFunnel = {
    sid: sid,
    fire: fire,
    step: function (n, qid) { fire('QuizStep', { step: n, question_id: qid || '' }); },
    answer: function (n, qid, idx, label) {
      // Antwort-Wert NICHT an den Pixel (unnötig) → nur First-Party-Store
      store('QuizAnswer', { step: n, question_id: qid || '', answer_index: idx, answer: label || '' });
    },
    complete: function () { fire('QuizComplete', {}); },
    lead: function (segment, tier) {
      // Pixel-"Lead" feuert das Quiz bereits via BBTracking.track('Lead',…)
      // → hier nur in den First-Party-Store (Journey-Abschluss).
      store('Lead', { segment: segment || '', tier: tier || 0 });
    },
    // Qualified Lead (ICP-Segment + Budget). Store-only — das Meta-Event
    // feuert server-seitig per CAPI (leads.js), um Doppelzählung zu vermeiden.
    qualified: function (segment, tier) {
      store('QualifiedLead', { segment: segment || '', tier: tier || 0 });
    },
  };

  // ---------- Auto-Fire je Seite ----------
  var p = location.pathname;
  // Generischer Seitenaufruf (nur First-Party-Store → füllt das „Seitenaufrufe"-
  // Panel + Basis für Bounce; NICHT an den Pixel, der hat seinen eigenen PageView).
  store('PageView', {});
  if (/\/funnel\/diagnose\/?$/.test(p)) {
    // Landing der Profit-Analyse betreten → Retargeting-Audience "LP besucht"
    fire('DiagnoseView', {});
  } else if (/\/funnel\/ergebnis-[a-z]+\/?$/.test(p)) {
    // Ergebnis-Seite → Segment aus dem Quiz-Result (sessionStorage)
    var seg = '';
    try { seg = (JSON.parse(sessionStorage.getItem('bb_quiz_result') || '{}').segment) || ''; } catch (e) {}
    if (!seg) {
      var m = p.match(/ergebnis-([a-z]+)/);
      seg = m ? m[1] : '';
    }
    fire('QuizResult', { segment: seg, path: p });
  }
})();
