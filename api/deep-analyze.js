// ============================================================
//  BB Brands — Profit-Analyse · Stufe 3: KI-Doktrin-Scan (KOSTET pro Scan)
//  Vercel Serverless (Node). Holt Homepage + 1 PDP server-seitig, gibt den
//  bereinigten Inhalt zusammen mit der Konversions-Doktrin an Claude und
//  bekommt strukturierte Findings zurück (pro Funnel-Step + Hebel).
//
//  GATED + INAKTIV bis ENV gesetzt:
//    ANTHROPIC_API_KEY   (Pflicht — ohne diesen Key meldet die Function {enabled:false})
//    PROFIT_SCAN_MODEL   (optional, Default 'claude-haiku-4-5' = günstig; auf
//                         'claude-sonnet-4-6' / 'claude-opus-4-6' hochstellbar)
//  Kosten-Schutz: nur POST, nur wenn vom Frontend nach E-Mail-Opt-in getriggert.
// ============================================================
const UA='Mozilla/5.0 (compatible; BBProfitCheck/1.0; +https://bb-brands.de)';
const MODEL=process.env.PROFIT_SCAN_MODEL||'claude-haiku-4-5';

function normUrl(raw){ var u=(raw||'').trim(); if(!u) return null; if(!/^https?:\/\//i.test(u)) u='https://'+u; try{ return new URL(u).href; }catch(e){ return null; } }

async function getText(url){
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},10000);
  try{
    var r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html'},signal:ctrl.signal,redirect:'follow'});
    clearTimeout(t); if(!r.ok) return '';
    var html=await r.text();
    // grob auf sichtbaren Text + Schlüssel-Marker reduzieren (Token sparen)
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
  '2 PDP: Trust-Stack unter Preis (+8–18% Baymard)? Reviews mit Fotos (3–4× CR)? Benefit-Bullets? Versand/Retoure sichtbar? Sticky-ATC mobil (+7–12%)? Genug Produktbilder?',
  '3 CART: Free-Shipping-Schwelle (+7–10% AOV)? Cross-Sell? Trust im Cart?',
  '4 CHECKOUT (höchster Hebel, behebbare Fehler ~+35% Baymard): Gast-Checkout? Express-Pay (+15–37%)? Wenige Felder? Kostentransparenz (39% Abbruch bei Überraschungskosten)?',
  '5 MOBILE: Mobile-first? Tap-Targets? Bottom-Nav?',
  '6 SPEED: LCP<2,5s, INP<200ms, CLS<0,1?',
  '7 TRUST/DACH: Social Proof? Garantie? Trusted Shops? Impressum/AGB?',
  'Hebel-IDs: A1 Editorial-Hero, B1 Trust-Stack, B4 Reviews+Fotos, B5 Sticky-ATC, C2 Free-Shipping, F4 Express-Pay, E1 Hero-Preload, D3 Trust-Bar.',
  'Severity: Critical (Kauf unmöglich/Checkout kaputt) · High (großer messbarer Verlust) · Medium · Low. Nenne dem Kunden nur Critical+High.'
].join('\n');

const SCHEMA_HINT = 'Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, kein Text drumherum): {"steps":[{"step":"PDP","status":"leck|schwach|solide|premium","evidenz":"was du konkret siehst","severity":"High","hebel":"B1","impact":"+8–18% PDP-Conv (Baymard)"}],"top_findings":["..."],"engpass":"PDP","fazit":"1 Satz, direkt, du-Form"}';

async function callClaude(content){
  var body={ model:MODEL, max_tokens:1800, system:DOCTRINE+'\n\n'+SCHEMA_HINT,
    messages:[{role:'user',content:'Hier ist der gefetchte Inhalt von Homepage + Produktseite des Shops. Bewerte ihn gegen die Doktrin und gib NUR das JSON zurück.\n\n'+content}] };
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},45000);
  var r=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST', signal:ctrl.signal,
    headers:{ 'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
    body:JSON.stringify(body)
  });
  clearTimeout(t);
  if(!r.ok){ var e=await r.text(); throw new Error('Anthropic '+r.status+': '+e.slice(0,200)); }
  var d=await r.json();
  var txt=(d.content&&d.content[0]&&d.content[0].text)||'';
  var m=txt.match(/\{[\s\S]*\}/);
  return m? JSON.parse(m[0]) : {raw:txt};
}

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  // Gate: ohne Key inaktiv (Frontend blendet den Button dann aus)
  if(!process.env.ANTHROPIC_API_KEY) return res.status(200).json({enabled:false});
  if(req.method!=='POST') return res.status(200).json({enabled:true, hint:'POST mit {url} senden'});

  var q=req.body||{}; var url=normUrl(q.url);
  if(!url) return res.status(400).json({error:'URL fehlt'});
  try{
    var home=await getText(url);
    if(!home) return res.status(200).json({enabled:true, reachable:false, note:'Shop-Inhalt nicht abrufbar (evtl. Bot-Schutz).'});
    var pdp='';
    try{ var rr=await fetch(url,{headers:{'User-Agent':UA}}); var html=await rr.text(); var pm=html.match(/href=["']([^"']*\/products\/[^"'?#]+)["']/i); if(pm){ var pu=pm[1].indexOf('http')===0?pm[1]:new URL(pm[1],url).href; pdp=await getText(pu);} }catch(e){}
    var content='[HOMEPAGE]\n'+home+(pdp?('\n\n[PRODUKTSEITE]\n'+pdp):'');
    var findings=await callClaude(content);
    return res.status(200).json({enabled:true, reachable:true, url:url, model:MODEL, findings:findings});
  }catch(e){
    return res.status(200).json({enabled:true, error:String(e&&e.message||e)});
  }
};
