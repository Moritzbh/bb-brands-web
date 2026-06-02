/* ============================================================
   BB Brands — Frontend Tracking Layer
   ------------------------------------------------------------
   - Lädt Meta-Pixel + GA4 ERST NACH Consent (DSGVO/TTDSG)
   - CMP-agnostisch: Cookiebot / Usercentrics / Eigen-Gate rufen
     einfach window.BBTracking.grantConsent() bzw. revokeConsent()
   - Erfasst fbclid → _fbc, liest _fbp → für CAPI-Match
   - window.BBTracking.track(name, params)  → fbq + gibt event_id zurück
   - window.BBTracking.attachToLead(payload) → hängt fbp/fbc/event_id
     + UTMs an einen Lead-POST-Body (→ Server dedupt via CAPI)

   Einbinden (im <head> jeder Seite, NACH der Config):
     <script src="/assets/js/bb-tracking-config.js"></script>
     <script src="/assets/js/bb-tracking.js" defer></script>

   No-Op solange pixelId/ga4Id leer sind.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.BB_TRACKING || {};
  var PIXEL_ID = (CFG.pixelId || '').trim();
  var GA4_ID = (CFG.ga4Id || '').trim();
  var DEBUG = !!CFG.debug;
  // consentMode: 'cmp'  = alles wartet auf CMP-Opt-in (DSGVO-Endzustand)
  //              'auto' = Interim: GA4 lädt sofort (IP-anonymisiert), Pixel bleibt gated
  var MODE = (CFG.consentMode || 'cmp');

  function log() {
    if (DEBUG && window.console) console.log.apply(console, ['[bb-tracking]'].concat([].slice.call(arguments)));
  }

  // ---------- Cookie-Helfer ----------
  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    document.cookie = name + '=' + value + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }
  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ---------- event_id (Dedup-Schlüssel Browser ↔ Server) ----------
  function newEventId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---------- fbclid → _fbc (Meta-Format: fb.1.<ts>.<fbclid>) ----------
  function captureFbc() {
    try {
      var params = new URLSearchParams(window.location.search);
      var fbclid = params.get('fbclid');
      if (fbclid && !getCookie('_fbc')) {
        setCookie('_fbc', 'fb.1.' + Date.now() + '.' + fbclid, 90);
        log('captured _fbc from fbclid');
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- UTMs: First-Touch in localStorage ----------
  function captureUtms() {
    try {
      var p = new URLSearchParams(window.location.search);
      var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
      var has = keys.some(function (k) { return p.get(k); });
      if (has && !localStorage.getItem('bb_utms')) {
        var obj = {};
        keys.forEach(function (k) { if (p.get(k)) obj[k] = p.get(k); });
        obj._referrer = document.referrer || '';
        obj._landing = window.location.pathname || '';
        localStorage.setItem('bb_utms', JSON.stringify(obj));
        log('captured first-touch UTMs', obj);
      }
    } catch (e) { /* ignore */ }
  }
  function getUtms() {
    try { return JSON.parse(localStorage.getItem('bb_utms') || '{}'); } catch (e) { return {}; }
  }

  // UTMs sind first-party + harmlos → schon vor Consent erfassen.
  // _fbc-Cookie erst nach Consent setzen (siehe loadPixel).
  captureUtms();

  var consentGranted = false;
  var pixelLoaded = false;
  var ga4Loaded = false;

  // ---------- Meta-Pixel laden ----------
  function loadPixel() {
    if (pixelLoaded || !PIXEL_ID) return;
    pixelLoaded = true;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
    (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    captureFbc();
    window.fbq('init', PIXEL_ID);
    window.fbq('track', 'PageView');
    log('Meta Pixel geladen + PageView', PIXEL_ID);
  }

  // ---------- GA4 laden ----------
  function loadGA4() {
    if (ga4Loaded || !GA4_ID) return;
    ga4Loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID, { anonymize_ip: true });
    log('GA4 geladen', GA4_ID);
  }

  // ---------- Consent-Steuerung (von der CMP gerufen) ----------
  // grantConsent({ga4, pixel}) — granular. Ohne Argument: beides (Abwärtskompat).
  function grantConsent(opts) {
    if (opts === undefined) opts = { ga4: true, pixel: true };
    if (opts.ga4 && !ga4Loaded) { loadGA4(); log('Consent: GA4 geladen'); }
    if (opts.pixel && !consentGranted) {
      consentGranted = true;
      loadPixel();
      log('Consent: Meta-Pixel geladen');
      // Gepufferte Events: NUR den Pixel nachfeuern (GA4 wurde ggf. schon
      // beim Original-Aufruf gefeuert → kein Doppelzählen).
      (pendingEvents || []).forEach(function (e) {
        if (window.fbq) { try { window.fbq('track', e.name, e.params || {}, { eventID: e.opts.eventId }); } catch (_) {} }
      });
      pendingEvents = [];
    }
  }
  function revokeConsent() {
    // Bereits geladene Tags lassen sich im laufenden Page-View nicht entladen;
    // wir stoppen best-effort weiteres Feuern. Beim nächsten Seitenaufruf greift
    // die gespeicherte Ablehnung → gar kein Laden.
    consentGranted = false;
    log('Consent widerrufen (kein weiteres Pixel-Feuern)');
  }

  // ---------- Event-Tracking ----------
  var pendingEvents = [];
  // track('Lead', {...}) → gibt event_id zurück (für Dedup mit Server-CAPI).
  // Vor Consent werden Events gepuffert und nach grantConsent() gefeuert.
  function track(name, params, opts) {
    opts = opts || {};
    var eventId = opts.eventId || newEventId();
    // GA4 feuert unabhängig, sobald geladen (auch im 'auto'-Interim-Modus)
    if (ga4Loaded && window.gtag) {
      try { window.gtag('event', name, params || {}); } catch (e) { /* ignore */ }
    }
    // Meta-Pixel nur mit echtem Consent; sonst puffern und nach grantConsent nachfeuern
    if (consentGranted && window.fbq) {
      try { window.fbq('track', name, params || {}, { eventID: eventId }); log('Event gefeuert:', name, eventId); } catch (e) { /* ignore */ }
    } else {
      pendingEvents.push({ name: name, params: params, opts: { eventId: eventId } });
      log('Pixel-Event gepuffert (kein Consent):', name);
    }
    return eventId;
  }
  function trackCustom(name, params, opts) {
    opts = opts || {};
    var eventId = opts.eventId || newEventId();
    if (consentGranted && window.fbq) {
      try { window.fbq('trackCustom', name, params || {}, { eventID: eventId }); } catch (e) {}
    }
    return eventId;
  }

  // ---------- Lead-Payload anreichern ----------
  // Hängt Match-Keys + Attribution an einen /api/leads-POST-Body.
  // event_id sollte dieselbe ID sein, die track() für das Browser-Event
  // erzeugt hat → übergib sie via opts.eventId.
  function attachToLead(payload, opts) {
    opts = opts || {};
    payload = payload || {};
    var utms = getUtms();
    if (utms.utm_source && !payload.utm_source) payload.utm_source = utms.utm_source;
    if (utms.utm_medium && !payload.utm_medium) payload.utm_medium = utms.utm_medium;
    if (utms.utm_campaign && !payload.utm_campaign) payload.utm_campaign = utms.utm_campaign;
    if (utms.utm_content && !payload.utm_content) payload.utm_content = utms.utm_content;
    if (utms.utm_term && !payload.utm_term) payload.utm_term = utms.utm_term;
    if (utms._referrer && !payload.referrer) payload.referrer = utms._referrer;
    if (utms._landing && !payload.landing_path) payload.landing_path = utms._landing;
    if (!payload.submit_path) payload.submit_path = window.location.pathname;
    // Meta-Match-Keys (nur vorhanden, wenn Consent erteilt → Cookies existieren)
    var fbp = getCookie('_fbp');
    var fbc = getCookie('_fbc');
    if (fbp) payload.fbp = fbp;
    if (fbc) payload.fbc = fbc;
    payload.event_id = opts.eventId || payload.event_id || newEventId();
    return payload;
  }

  // ---------- Public API ----------
  window.BBTracking = {
    grantConsent: grantConsent,
    revokeConsent: revokeConsent,
    track: track,
    trackCustom: trackCustom,
    attachToLead: attachToLead,
    newEventId: newEventId,
    isReady: function () { return consentGranted && pixelLoaded; },
  };

  // ---------- CMP-Auto-Hook ----------
  // (A) Usercentrics CMP V3 (web.cmp.usercentrics.eu/ui/loader.js)
  // Liest pro Dienst den Consent-Status und schaltet GA4 / Meta-Pixel granular frei.
  function ucApplyConsent() {
    try {
      var svc = (window.UC_UI && typeof UC_UI.getServicesBaseInfo === 'function')
        ? UC_UI.getServicesBaseInfo() : null;
      if (!svc || !svc.length) return;
      var ga = false, px = false, any = false;
      svc.forEach(function (s) {
        var n = (s && s.name ? s.name : '').toLowerCase();
        var ok = s && s.consent && s.consent.status === true;
        if (!ok) return;
        any = true;
        if (/google analytics|google tag|gtag|ga4|\banalytics\b|statistik/.test(n)) ga = true;
        if (/facebook|meta|pixel/.test(n)) px = true;
      });
      // Falls Dienste nicht eindeutig benannt sind, aber Zustimmung existiert:
      // konservativ nur das freischalten, was klar erkannt wurde.
      if (ga || px) grantConsent({ ga4: ga, pixel: px });
      else if (!any) { /* alles abgelehnt */ revokeConsent(); }
      log('UC consent angewandt', { ga4: ga, pixel: px });
    } catch (e) { /* ignore */ }
  }
  // Beim Init (deckt wiederkehrende Besucher mit gespeicherter Zustimmung ab)
  window.addEventListener('UC_UI_INITIALIZED', ucApplyConsent);
  // Bei Nutzer-Aktion (Annehmen/Ablehnen/Speichern)
  window.addEventListener('UC_UI_CMP_EVENT', function (e) {
    var t = e && e.detail && e.detail.type;
    if (t === 'ACCEPT_ALL') {
      // „Alle akzeptieren" → sicher beides freischalten, auch falls die
      // Dienst-Erkennung mal nicht greift.
      grantConsent({ ga4: true, pixel: true });
    } else if (t === 'DENY_ALL') {
      revokeConsent();
    } else if (t === 'SAVE' || t === 'ACCEPT_ONE' || t === 'DENY_ONE') {
      // Teilauswahl → granular nach Dienst-Status
      ucApplyConsent();
    }
  });

  // (B) Klassisch Cookiebot (falls je gewechselt wird) — Marketing-Consent
  window.addEventListener('CookiebotOnAccept', function () {
    if (window.Cookiebot && window.Cookiebot.consent && window.Cookiebot.consent.marketing) grantConsent();
  });
  window.addEventListener('CookiebotOnDecline', function () { revokeConsent(); });
  // (C) Eigen-Gate / manueller Trigger
  window.addEventListener('bb:consent-granted', function () { grantConsent(); });
  window.addEventListener('bb:consent-revoked', revokeConsent);

  // Interim-Modus ('auto'): GA4 sofort laden (Traffic-Übersicht), Meta-Pixel
  // bleibt bis zum echten Opt-in (CMP) aus. Sobald CMP steht → consentMode:'cmp'.
  if (MODE === 'auto') { loadGA4(); }

  log('bb-tracking initialisiert', { mode: MODE, pixel: !!PIXEL_ID, ga4: !!GA4_ID });
})();
