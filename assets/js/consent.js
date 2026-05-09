/* ============================================
   BB Brands · Consent-Manager v1
   - 4 Kategorien: necessary / functional / statistics / marketing
   - Pre-Block: Calendly + Unsplash + GA4 + Meta-Pixel laden NUR nach Consent
   - Banner beim ersten Besuch, Settings wieder öffenbar via window.bbConsent.show()
   - Ohne Drittanbieter, lokal, ohne Cookies (nur localStorage)
   ============================================ */
(function(){
  'use strict';

  var STORAGE_KEY = 'bb_consent_v1';
  var VERSION = 1;

  /* ===== TRACKING-IDs hier einsetzen, sobald vorhanden ===== */
  var GA4_ID        = '';   // z.B. 'G-XXXXXXXXXX'
  var META_PIXEL_ID = '';   // z.B. '1234567890'
  var GADS_ID       = '';   // z.B. 'AW-XXXXXXXXX'
  /* ======================================================== */

  function load(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return null;
      var data = JSON.parse(raw);
      if(data.v !== VERSION) return null;
      return data.choices;
    }catch(e){ return null; }
  }

  function save(choices){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: VERSION,
        ts: Date.now(),
        choices: choices
      }));
    }catch(e){}
    apply(choices);
  }

  function apply(choices){
    var html = document.documentElement;
    html.dataset.consentNecessary  = choices.necessary  ? 'true' : 'false';
    html.dataset.consentFunctional = choices.functional ? 'true' : 'false';
    html.dataset.consentStatistics = choices.statistics ? 'true' : 'false';
    html.dataset.consentMarketing  = choices.marketing  ? 'true' : 'false';

    if(choices.statistics) loadGA4();
    if(choices.marketing)  loadMetaPixel();
    if(choices.marketing)  loadGoogleAds();
    if(choices.functional) hydrateEmbeds();

    try{
      window.dispatchEvent(new CustomEvent('bb-consent-change', {detail: choices}));
    }catch(e){}
  }

  /* ===== Tracker-Loader (idempotent) ===== */
  function loadGA4(){
    if(!GA4_ID || window.__bb_ga4_loaded) return;
    window.__bb_ga4_loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function(){ window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID, {anonymize_ip: true});
  }

  function loadMetaPixel(){
    if(!META_PIXEL_ID || window.__bb_meta_loaded) return;
    window.__bb_meta_loaded = true;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  function loadGoogleAds(){
    if(!GADS_ID || window.__bb_gads_loaded) return;
    window.__bb_gads_loaded = true;
    if(!window.gtag){
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GADS_ID;
      document.head.appendChild(s);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function(){ window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
    }
    window.gtag('config', GADS_ID);
  }

  /* ===== Embeds (Calendly etc.) — Pre-Block-fähig ===== */
  function hydrateEmbeds(){
    var gates = document.querySelectorAll('.bb-consent-embed[data-embed]:not([data-loaded])');
    gates.forEach(function(g){
      g.dataset.loaded = 'true';
      if(g.dataset.embed === 'calendly'){
        var url = g.dataset.url;
        g.innerHTML = '<div class="calendly-inline-widget" data-url="' + url + '" style="min-width:320px;height:720px"></div>';
        if(!window.__bb_calendly_loaded){
          window.__bb_calendly_loaded = true;
          var s = document.createElement('script');
          s.src = 'https://assets.calendly.com/assets/external/widget.js';
          s.async = true;
          document.head.appendChild(s);
        }
      }
    });
  }

  /* ===== Banner-UI ===== */
  function renderBanner(){
    if(document.getElementById('bb-consent-banner')) return;
    var stored = load() || {};
    var html = ''
      + '<div class="bb-cb-shell" role="dialog" aria-labelledby="bb-cb-title" aria-modal="false">'
      +   '<div class="bb-cb-text">'
      +     '<h3 id="bb-cb-title">Cookies &amp; Datenschutz</h3>'
      +     '<p>Wir nutzen technisch notwendige Speichervorgänge für die Funktion der Seite. Mit deiner Zustimmung laden wir zusätzlich funktionale Inhalte (Calendly für Termine, Unsplash-Bilder), Statistik (Google Analytics) und Marketing (Meta Pixel, Google Ads). Du kannst deine Auswahl jederzeit über den Footer-Link „Cookie-Einstellungen" ändern. Details: <a href="/datenschutz/">Datenschutz</a>.</p>'
      +     '<div class="bb-cb-toggles">'
      +       '<label><input type="checkbox" checked disabled> <span>Notwendig</span></label>'
      +       '<label><input type="checkbox" data-cat="functional" ' + (stored.functional ? 'checked' : '') + '> <span>Funktional</span></label>'
      +       '<label><input type="checkbox" data-cat="statistics" ' + (stored.statistics ? 'checked' : '') + '> <span>Statistik</span></label>'
      +       '<label><input type="checkbox" data-cat="marketing" '  + (stored.marketing  ? 'checked' : '') + '> <span>Marketing</span></label>'
      +     '</div>'
      +   '</div>'
      +   '<div class="bb-cb-actions">'
      +     '<button type="button" class="bb-cb-btn bb-cb-btn-ghost" data-action="reject">Nur notwendig</button>'
      +     '<button type="button" class="bb-cb-btn bb-cb-btn-ghost" data-action="save">Auswahl speichern</button>'
      +     '<button type="button" class="bb-cb-btn bb-cb-btn-primary" data-action="accept">Alles akzeptieren</button>'
      +   '</div>'
      + '</div>';

    var el = document.createElement('div');
    el.id = 'bb-consent-banner';
    el.innerHTML = html;
    document.body.appendChild(el);

    el.addEventListener('click', function(e){
      var btn = e.target.closest('[data-action]');
      if(!btn) return;
      var action = btn.dataset.action;
      var choices;
      if(action === 'accept'){
        choices = {necessary:true, functional:true, statistics:true, marketing:true};
      } else if(action === 'reject'){
        choices = {necessary:true, functional:false, statistics:false, marketing:false};
      } else if(action === 'save'){
        choices = {necessary:true, functional:false, statistics:false, marketing:false};
        el.querySelectorAll('input[data-cat]').forEach(function(i){
          choices[i.dataset.cat] = i.checked;
        });
      } else {
        return;
      }
      save(choices);
      el.remove();
    });
  }

  /* ===== Public API ===== */
  window.bbConsent = {
    has: function(category){
      var c = load();
      return c ? !!c[category] : false;
    },
    get: function(){ return load(); },
    show: function(){ renderBanner(); },
    reset: function(){
      try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
      try{ window.location.reload(); }catch(e){}
    }
  };

  /* ===== Init ===== */
  function init(){
    var stored = load();
    if(stored){
      apply(stored);
    } else {
      /* Default: alles AUSSER necessary auf false, Banner zeigen */
      var defaults = {necessary:true, functional:false, statistics:false, marketing:false};
      apply(defaults);
      renderBanner();
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
