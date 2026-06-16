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

function normUrl(raw){ var u=(raw||'').trim(); if(!u) return null; if(!/^https?:\/\//i.test(u)) u='https://'+u; try{ return new URL(u).href; }catch(e){ return null; } }

async function getText(url){
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},10000);
  try{
    var r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html'},signal:ctrl.signal,redirect:'follow'});
    clearTimeout(t); if(!r.ok) return '';
    var html=await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi,' ')
      .replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<[^>]+>/g,' ')
      .replace(/\s+/g,' ')
      .trim().slice(0,7000);
  }catch(e){ clearTimeout(t); return ''; }
}

// Kompakte Doktrin-Rubrik (aus kb/growth/conversion-doctrine.md verdichtet)
const DOCTRINE = [
  'Du bist Senior-CRO-Auditor für DTC-/Shopify-Shops. Bewerte den Shop NUR anhand des gelieferten Inhalts, mit Evidenz. Keine erfundenen Zahlen.',
  'Funnel-Steps & Kern-Kriterien:',
  '1 LANDING/HERO: Value-Prop in 5 Sek klar? Trust above-fold? EIN klarer CTA?',
  '2 PDP: Trust-Stack unter Preis (+8-18% Baymard)? Reviews mit Fotos (3-4x CR)? Benefit-Bullets? Versand/Retoure sichtbar? Sticky-ATC mobil (+7-12%)? Genug Produktbilder?',
  '3 CART: Free-Shipping-Schwelle (+7-10% AOV)? Cross-Sell? Trust im Cart?',
  '4 CHECKOUT (höchster Hebel, behebbare Fehler ~+35% Baymard): Gast-Checkout? Express-Pay (+15-37%)? Wenige Felder? Kostentransparenz (39% Abbruch bei Überraschungskosten)?',
  '5 MOBILE: Mobile-first? Tap-Targets? Bottom-Nav?',
  '6 SPEED: LCP<2,5s, INP<200ms, CLS<0,1?',
  '7 TRUST/DACH: Social Proof? Garantie? Trusted Shops? Impressum/AGB?',
  'Hebel-IDs: A1 Editorial-Hero, B1 Trust-Stack, B4 Reviews+Fotos, B5 Sticky-ATC, C2 Free-Shipping, F4 Express-Pay, E1 Hero-Preload, D3 Trust-Bar.',
  'Severity: Critical (Kauf unmöglich/Checkout kaputt) - High (großer messbarer Verlust) - Medium - Low. Nenne dem Kunden nur Critical+High. Voice: direkt, du-Form, keine Buzzwords.'
].join('\n');

const SCHEMA_HINT = 'Gib NUR valides JSON dieser Form zurück: {"steps":[{"step":"PDP","status":"leck|schwach|solide|premium","evidenz":"was du konkret siehst","severity":"High","hebel":"B1","impact":"+8-18% PDP-Conv (Baymard)"}],"top_findings":["..."],"engpass":"PDP","fazit":"1 Satz, direkt, du-Form"}';

async function callGemini(content){
  var url='https://generativelanguage.googleapis.com/v1beta/models/'+MODEL+':generateContent?key='+encodeURIComponent(process.env.GEMINI_API_KEY);
  var body={
    system_instruction:{parts:[{text:DOCTRINE+'\n\n'+SCHEMA_HINT}]},
    contents:[{role:'user',parts:[{text:'Hier ist der gefetchte Inhalt von Homepage + Produktseite des Shops. Bewerte ihn gegen die Doktrin und gib NUR das JSON zurück.\n\n'+content}]}],
    generationConfig:{maxOutputTokens:1800,temperature:0.3,responseMimeType:'application/json'}
  };
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},45000);
  var r=await fetch(url,{method:'POST',signal:ctrl.signal,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  clearTimeout(t);
  if(!r.ok){ var e=await r.text(); throw new Error('Gemini '+r.status+': '+e.slice(0,200)); }
  var d=await r.json();
  var txt='';
  try{ txt=d.candidates[0].content.parts.map(function(p){return p.text||'';}).join(''); }catch(_){ txt=''; }
  var m=txt.match(/\{[\s\S]*\}/);
  return m? JSON.parse(m[0]) : {raw:txt};
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
    var home=await getText(url);
    if(!home) return res.status(200).json({enabled:true, reachable:false, note:'Shop-Inhalt nicht abrufbar (evtl. Bot-Schutz).'});
    var pdp='';
    try{ var rr=await fetch(url,{headers:{'User-Agent':UA}}); var html=await rr.text(); var pm=html.match(/href=["']([^"']*\/products\/[^"'?#]+)["']/i); if(pm){ var pu=pm[1].indexOf('http')===0?pm[1]:new URL(pm[1],url).href; pdp=await getText(pu);} }catch(e){}
    var content='[HOMEPAGE]\n'+home+(pdp?('\n\n[PRODUKTSEITE]\n'+pdp):'');
    var findings=await callGemini(content);
    return res.status(200).json({enabled:true, reachable:true, url:url, model:MODEL, findings:findings});
  }catch(e){
    return res.status(200).json({enabled:true, error:String(e&&e.message||e)});
  }
};
