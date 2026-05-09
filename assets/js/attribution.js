/* ============================================================
 *  BB Brands — Lead Attribution Tracker
 *  Erfasst bei jedem Page-Load:
 *    - UTMs aus URL-Query (utm_source, utm_medium, utm_campaign, ...)
 *    - document.referrer (woher kam der User?)
 *    - Landing-Page (erste Seite auf bb-brands.de in dieser Session)
 *    - Current-Page (Seite von der der Form-Submit kommt)
 *
 *  Persist: sessionStorage → reicht für eine Browser-Session,
 *           wird beim Tab-Close gelöscht (DSGVO-freundlich).
 *
 *  Usage im Form:
 *    const attr = window.bbAttribution.getAll();
 *    fetch('/api/leads', { body: JSON.stringify({...data, ...attr}) });
 * ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'bb_attr_v1';
  var UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  function readStored() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStored(obj) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      /* Storage disabled / Private Mode — still fine, runtime values below work */
    }
  }

  function parseQuery() {
    var params = new URLSearchParams(window.location.search);
    var utms = {};
    UTM_FIELDS.forEach(function (k) {
      var v = params.get(k);
      if (v) utms[k] = v.trim().slice(0, 120);
    });
    return utms;
  }

  function getReferrerDomain() {
    var r = document.referrer || '';
    if (!r) return '';
    try {
      var u = new URL(r);
      // Wenn der Referrer die gleiche Domain ist, ignorieren (interne Navigation)
      if (u.hostname === window.location.hostname) return '';
      return u.hostname;
    } catch (e) {
      return '';
    }
  }

  // First-Touch: wird nur beim ersten Page-Load dieser Session gesetzt
  var stored = readStored();
  var current = {
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_content: '',
    utm_term: '',
    referrer: '',
    referrerDomain: '',
    landingPath: '',
    landingTs: 0,
  };

  if (!stored) {
    // Erster Load → alles neu erfassen
    var utms = parseQuery();
    current.utm_source = utms.utm_source || '';
    current.utm_medium = utms.utm_medium || '';
    current.utm_campaign = utms.utm_campaign || '';
    current.utm_content = utms.utm_content || '';
    current.utm_term = utms.utm_term || '';
    current.referrer = document.referrer ? document.referrer.slice(0, 300) : '';
    current.referrerDomain = getReferrerDomain();
    current.landingPath = window.location.pathname + window.location.search.slice(0, 200);
    current.landingTs = Date.now();
    writeStored(current);
  } else {
    current = stored;
    // UTMs aus aktueller URL könnten neu sein (z.B. User klickt zweiten Ad-Link mit anderen UTMs) —
    // hier bewusst First-Touch-Attribution: wir überschreiben NICHT. Erste Quelle zählt.
  }

  // Public API
  window.bbAttribution = {
    getAll: function () {
      return {
        utm_source: current.utm_source,
        utm_medium: current.utm_medium,
        utm_campaign: current.utm_campaign,
        utm_content: current.utm_content,
        utm_term: current.utm_term,
        referrer: current.referrer,
        referrer_domain: current.referrerDomain,
        landing_path: current.landingPath,
        landing_ts: current.landingTs,
        submit_path: window.location.pathname,
      };
    },
    // Debug-Hilfe: console.log(window.bbAttribution.debug())
    debug: function () {
      return current;
    },
  };
})();
