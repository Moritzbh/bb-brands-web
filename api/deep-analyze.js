// ============================================================
//  BB Brands — Profit-Analyse · Stufe 3: KI-Doktrin-Scan (Google Gemini)
//  Vercel Serverless (Node). Holt Homepage + 1 PDP server-seitig, gibt den
//  bereinigten Inhalt zusammen mit der Konversions-Doktrin an Gemini und
//  bekommt strukturierte Findings zurück (pro Funnel-Step + Hebel).
//
//  GATED + INAKTIV bis ENV gesetzt:
//    GEMINI_API_KEY      (Pflicht — Key von https://aistudio.google.com/api-keys.
//                         Ohne Key meldet die Function {enabled:false} → Sektion
//                         bleibt unsichtbar, kein Fehler, keine Kosten.)
//    PROFIT_SCAN_MODEL   (optional, Default 'gemini-2.0-flash' = Gratis-Tier;
//                         z.B. 'gemini-2.5-flash' / 'gemini-2.5-pro' möglich)
//  Feuert nur per POST + nur nachdem das Frontend ein E-Mail-Opt-in hatte.
// ============================================================
const UA='Mozilla/5.0 (compatible; BBProfitCheck/1.0; +https://bb-brands.de)';
const MODEL=process.env.PROFIT_SCAN_MODEL||'gemini-2.5-flash';

// Redis (Upstash, gleich wie leads.js/events.js) — speichert jede Analyse für den Admin
const KV_URL=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'';
const KV_TOKEN=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'';
const SCANS_KEY='bb:scans';
async function redis(){ if(!KV_URL||!KV_TOKEN) return null; try{ var r=await fetch(KV_URL,{method:'POST',headers:{Authorization:'Bearer '+KV_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(Array.prototype.slice.call(arguments))}); if(!r.ok) return null; var d=await r.json(); return d.result; }catch(e){ return null; } }
function dom(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch(e){ return ''; } }
async function storeScan(rec){ try{ var id=String(Date.now())+'-'+Math.random().toString(36).slice(2,8); await redis('HSET',SCANS_KEY,id,JSON.stringify(Object.assign({id:id},rec))); return id; }catch(e){ return null; } }

function normUrl(raw){ var u=(raw||'').trim(); if(!u) return null; if(!/^https?:\/\//i.test(u)) u='https://'+u; try{ return new URL(u).href; }catch(e){ return null; } }

async function fetchRaw(url){
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},10000);
  try{
    var r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html'},signal:ctrl.signal,redirect:'follow'});
    clearTimeout(t); if(!r.ok) return '';
    return await r.text();
  }catch(e){ clearTimeout(t); return ''; }
}
function clean(html){
  return (html||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim().slice(0,9000);
}

// Verifizierte Signale aus dem ROHEN HTML (inkl. Scripts) — zuverlässig, auch wenn
// der sichtbare Text das Feature nicht zeigt (JS-nachgeladene Widgets etc.).
var REVIEW_APPS=['loox','judge.me','judgeme','yotpo','okendo','stamped','reviews.io','reviewsio','fera.ai','opinew','junip','trustpilot','kiyoh','trustedshops','trusted-shops','trusted_shops','shopvote','provenexpert','ausgezeichnet.org','shopify-product-reviews','rivyo','ryviu','growave'];
function detectSignals(html){
  var h=(html||'').toLowerCase();
  var ld=((html||'').match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)||[]).join(' ').toLowerCase();
  return {
    reviewApp: REVIEW_APPS.some(function(d){return h.indexOf(d)>=0;}) || /bewertung|rezension|kundenstimmen|\bsterne\b/.test(h),
    aggregateRating: /aggregaterating|ratingvalue|reviewcount/.test(ld) || /aggregaterating|ratingvalue/.test(h),
    expressPay: /shopify-payment-button|dynamic-checkout|apple[- ]?pay|google[- ]?pay|paypal|klarna|amazon[- ]?pay/.test(h),
    freeShip: /gratis versand|kostenloser versand|versandkostenfrei|free shipping/.test(h),
    trustBadge: /trusted ?shops|trustpilot|ausgezeichnet\.org|käuferschutz|geld[- ]?zurück/.test(h)
  };
}
function signalText(s){
  var yes='JA (vorhanden)', no='nicht im Code gefunden — kann per JS nachgeladen sein, NICHT als fehlend werten';
  function yn(v){return v?yes:no;}
  return '[VERIFIZIERTE SIGNALE AUS DEM CODE — zuverlässig, höher gewichten als der sichtbare Text]\n'+
    '- Review-/Bewertungs-App oder Sterne-Widget: '+yn(s.reviewApp)+'\n'+
    '- Aggregate-Rating (Sterne-Schema): '+yn(s.aggregateRating)+'\n'+
    '- Express-Pay (Apple/Google Pay, PayPal, Klarna): '+yn(s.expressPay)+'\n'+
    '- Free-Shipping-Hinweis: '+yn(s.freeShip)+'\n'+
    '- Trust-Badge (Trusted Shops/Trustpilot/Käuferschutz): '+yn(s.trustBadge);
}

// Kompakte Doktrin-Rubrik (aus kb/growth/conversion-doctrine.md verdichtet)
const DOCTRINE = [
  'Du bist Senior-CRO-Auditor für DTC-/Shopify-Shops. Bewerte den Shop NUR anhand des gelieferten Inhalts, mit Evidenz. Keine erfundenen Zahlen.',
  'WICHTIG — du siehst NUR server-seitig gerendertes HTML OHNE JavaScript. Reviews, Foto-Reviews, Sterne-/Bewertungs-Widgets (Loox, Judge.me, Okendo, Yotpo, Trustpilot, Trusted Shops), Bild-Galerien, Cross-Sell und teils Produktbilder werden fast immer per JS nachgeladen und sind hier oft NICHT im Text sichtbar.',
  'DESHALB: Behaupte NIEMALS, dass ein Element FEHLT (z.B. „keine Reviews", „keine Foto-Reviews", „kein Sticky-ATC", „zu wenige/keine Lifestyle-Bilder"), nur weil du es im Text nicht findest. Richte dich nach den [VERIFIZIERTEN SIGNALEN]: steht dort Review-App=JA oder Aggregate-Rating=JA, dann SIND Reviews vorhanden — melde das NICHT als Leck. Gleiches für Express-Pay/Free-Shipping/Trust-Badge.',
  'GRUNDREGEL gegen Falschmeldungen: Lieber ein Leck AUSLASSEN als ein falsches behaupten. Jede „evidenz" muss auf etwas beruhen, das du im Inhalt WIRKLICH siehst oder das ein verifiziertes Signal belegt. Wenn du unsicher bist, ob etwas fehlt, melde es NICHT.',
  'Funnel-Steps & Kern-Kriterien:',
  '1 LANDING/HERO: Value-Prop in 5 Sek klar? Trust above-fold? EIN klarer CTA?',
  '2 PDP: Trust-Stack unter Preis (+8-18% Baymard)? Reviews mit Fotos (3-4x CR)? Benefit-Bullets? Versand/Retoure sichtbar? Sticky-ATC mobil (+7-12%)? Genug Produktbilder?',
  '3 CART: Free-Shipping-Schwelle (+7-10% AOV)? Cross-Sell? Trust im Cart?',
  '4 CHECKOUT (höchster Hebel, behebbare Fehler ~+35% Baymard): Gast-Checkout? Express-Pay (+15-37%)? Wenige Felder? Kostentransparenz (39% Abbruch bei Überraschungskosten)?',
  '5 MOBILE: Mobile-first? Tap-Targets? Bottom-Nav?',
  '6 SPEED: LCP<2,5s, INP<200ms, CLS<0,1?',
  '7 TRUST/DACH: Social Proof? Garantie? Trusted Shops? Impressum/AGB?',
  '8 OFFER & POSITIONIERUNG (Schwartz): Klares Mechanism-Pair — echte Ursache des Problems (UMP) + proprietäre Lösung (UMS)? Oder austauschbar (tödlich in gesättigten Märkten)? Big Idea (neuer Frame statt Feature-Liste)? Holt die Seite den Bewusstseinsgrad des Käufers ab? Belief Chain bedient (Problem real -> andere scheitern -> diese Lösung -> diese Marke -> Social Proof -> Risk=0)? No-Brainer-Offer (Garantie/Risk-Reversal/Value-Stack/Grund-jetzt)?',
  '9 PROFIT/UNIT-ECONOMICS: AOV/Pricing tragfähig? Erkennbarer AOV-Hebel (Bundle/Cross-Sell/Free-Shipping-Schwelle)? Hinweis: unter ~45% Bruttomarge nach allen Kosten kein Ad-Spielraum (Strukturproblem).',
  'COPY/VoC: Trifft Headline/PDP-Copy einen konkreten, wiedererkennbaren Pain in Kundensprache — oder generischer Marketing-Lärm (Leck)?',
  'Hebel-IDs: A1 Editorial-Hero, B1 Trust-Stack, B4 Reviews+Fotos, B5 Sticky-ATC, C2 Free-Shipping, F4 Express-Pay, E1 Hero-Preload, D3 Trust-Bar, O1 Mechanism-Pair, O5 No-Brainer-Offer.',
  'Severity: Critical (Kauf unmöglich/Checkout kaputt) - High (großer messbarer Verlust) - Medium - Low. Nenne dem Kunden nur Critical+High. Voice: direkt, du-Form, keine Buzzwords.'
].join('\n');

const SCHEMA_HINT = 'Gib NUR valides JSON dieser Form zurück: {"steps":[{"step":"PDP","status":"leck|schwach|solide|premium","evidenz":"was du konkret siehst","severity":"High","hebel":"B1","impact":"+8-18% PDP-Conv (Baymard)","fix":"konkrete, sofort umsetzbare Maßnahme in 1 Satz, du-Form, spezifisch für DIESEN Shop"}],"top_findings":["..."],"engpass":"PDP","fazit":"1 Satz, direkt, du-Form"}';

async function callGemini(content){
  var url='https://generativelanguage.googleapis.com/v1beta/models/'+MODEL+':generateContent?key='+encodeURIComponent(process.env.GEMINI_API_KEY);
  var body={
    system_instruction:{parts:[{text:DOCTRINE+'\n\n'+SCHEMA_HINT}]},
    contents:[{role:'user',parts:[{text:'Unten zuerst VERIFIZIERTE SIGNALE aus dem Code (zuverlässig), danach der gefetchte Textinhalt von Homepage + Produktseite (ohne JS). Bewerte gegen die Doktrin, beachte die Anti-Falschmeldungs-Regel und gib NUR das JSON zurück.\n\n'+content}]}],
    generationConfig:{maxOutputTokens:4096,temperature:0.3,responseMimeType:'application/json',thinkingConfig:{thinkingBudget:0}}
  };
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},45000);
  var r=await fetch(url,{method:'POST',signal:ctrl.signal,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  clearTimeout(t);
  if(!r.ok){ var e=await r.text(); throw new Error('Gemini '+r.status+': '+e.slice(0,200)); }
  var d=await r.json();
  var txt='';
  try{ txt=d.candidates[0].content.parts.map(function(p){return p.text||'';}).join(''); }catch(_){ txt=''; }
  var obj=null;
  try{ obj=JSON.parse(txt); }catch(_){ var m=txt.match(/\{[\s\S]*\}/); if(m){ try{ obj=JSON.parse(m[0]); }catch(e){} } }
  return obj||{raw:txt};
}

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(!process.env.GEMINI_API_KEY) return res.status(200).json({enabled:false});
  if(req.method!=='POST') return res.status(200).json({enabled:true, hint:'POST mit {url} senden'});

  var q=req.body||{}; var url=normUrl(q.url);
  if(!url) return res.status(400).json({error:'URL fehlt'});
  try{
    var homeHtml=await fetchRaw(url);
    if(!homeHtml) return res.status(200).json({enabled:true, reachable:false, note:'Shop-Inhalt nicht abrufbar (evtl. Bot-Schutz).'});
    var pdpHtml='';
    try{ var pm=homeHtml.match(/href=["']([^"']*\/products\/[^"'?#]+)["']/i); if(pm){ var pu=pm[1].indexOf('http')===0?pm[1]:new URL(pm[1],url).href; pdpHtml=await fetchRaw(pu); } }catch(e){}
    var sigH=detectSignals(homeHtml), sigP=detectSignals(pdpHtml);
    var signals={ reviewApp:sigH.reviewApp||sigP.reviewApp, aggregateRating:sigH.aggregateRating||sigP.aggregateRating, expressPay:sigH.expressPay||sigP.expressPay, freeShip:sigH.freeShip||sigP.freeShip, trustBadge:sigH.trustBadge||sigP.trustBadge };
    var content=signalText(signals)+'\n\n[HOMEPAGE]\n'+clean(homeHtml)+(pdpHtml?('\n\n[PRODUKTSEITE]\n'+clean(pdpHtml)):'');
    var findings=await callGemini(content);
    // Komplette Analyse für den Admin speichern (Domain-Suche → senden)
    var scanId=await storeScan({
      ts:Date.now(), domain:dom(url), url:url, model:MODEL,
      inputs:{ visitors:+q.visitors||null, aov:+q.aov||null, cr:+q.cr||null, margin:+q.margin||null },
      leak_eur_month:+q.leakMo||null, segment:q.segment||null,
      source:q.source||null,
      signals:signals,
      findings:findings
    });
    return res.status(200).json({enabled:true, reachable:true, url:url, model:MODEL, scanId:scanId, findings:findings});
  }catch(e){
    return res.status(200).json({enabled:true, error:String(e&&e.message||e)});
  }
};
