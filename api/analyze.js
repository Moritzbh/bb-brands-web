// ============================================================
//  BB Brands — Profit-Analyse · Stufe 2: Heuristik-Shop-Scan (GRATIS)
//  Vercel Serverless (Node). Holt Homepage + 1 PDP server-seitig (kein CORS),
//  erkennt Shopify/Reviews/Express-Pay/Free-Ship/SEO + misst Core Web Vitals
//  via Google PageSpeed. Liefert erkannte Leak-Marker zurück.
//  Kein Key nötig (PageSpeed läuft auch ohne, dann rate-limitiert; optional
//  PAGESPEED_API_KEY für stabilere Werte). Fail-safe: Frontend rechnet ohne.
// ============================================================
const UA = 'Mozilla/5.0 (compatible; BBProfitCheck/1.0; +https://bb-brands.de)';

function normUrl(raw){ var u=(raw||'').trim(); if(!u) return null; if(!/^https?:\/\//i.test(u)) u='https://'+u; try{ return new URL(u).href; }catch(e){ return null; } }

async function getHtml(url){
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},10000);
  try{
    var r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html'},signal:ctrl.signal,redirect:'follow'});
    clearTimeout(t); if(!r.ok) return {ok:false,status:r.status};
    return {ok:true,html:await r.text()};
  }catch(e){ clearTimeout(t); return {ok:false,error:String(e&&e.message||e)}; }
}

async function pagespeed(url){
  var key=process.env.PAGESPEED_API_KEY?('&key='+process.env.PAGESPEED_API_KEY):'';
  var api='https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url='+encodeURIComponent(url)+'&strategy=mobile&category=performance'+key;
  var ctrl=new AbortController(), t=setTimeout(function(){ctrl.abort();},22000);
  try{
    var r=await fetch(api,{signal:ctrl.signal}); clearTimeout(t); if(!r.ok) return null;
    var d=await r.json(); var f=(d.loadingExperience&&d.loadingExperience.metrics)||{}; var lab=(d.lighthouseResult&&d.lighthouseResult.audits)||{};
    var num=function(id){ return lab[id]&&lab[id].numericValue; };
    return {
      lcp: (f.LARGEST_CONTENTFUL_PAINT_MS&&f.LARGEST_CONTENTFUL_PAINT_MS.percentile) || num('largest-contentful-paint'),
      cls: (f.CUMULATIVE_LAYOUT_SHIFT_SCORE&&f.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile!=null)? f.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile/100 : num('cumulative-layout-shift'),
      inp: (f.INTERACTION_TO_NEXT_PAINT&&f.INTERACTION_TO_NEXT_PAINT.percentile) || (f.EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT&&f.EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT.percentile)
    };
  }catch(e){ clearTimeout(t); return null; }
}

var REVIEW_APPS=['loox.io','judge.me','yotpo','okendo','stamped.io','reviews.io','fera.ai','opinew','junip','trustpilot','kiyoh'];
var FREESHIP=['hextom','freeshipping','free-shipping-bar','shippingbar','essential-free-shipping'];

function detect(html){
  var h=(html||'').toLowerCase();
  var jsonLd=((html||'').match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)||[]).join(' ');
  var has=function(re){ return re.test(html||''); };
  return {
    isShopify: /cdn\.shopify\.com|shopify\.theme|\/cdn\/shop\//i.test(html||''),
    theme: ((html||'').match(/Shopify\.theme\s*=\s*\{[^}]*"name":"([^"]+)"/i)||[])[1]||null,
    reviewApp: REVIEW_APPS.some(function(d){ return h.indexOf(d)>=0; }),
    aggregateRating: /aggregaterating|ratingvalue/i.test(jsonLd),
    expressPay: /shopify-payment-button|dynamic-checkout|apple[- ]?pay|google[- ]?pay|payment-button__button/i.test(html||''),
    freeShip: FREESHIP.some(function(d){ return h.indexOf(d)>=0; }) || /noch\s+\d+\s*€.*(gratis|kostenlos|free)/i.test(html||''),
    metaDesc: has(/<meta[^>]+name=["']description["']/i),
    h1Count: ((html||'').match(/<h1\b/gi)||[]).length,
    imgCount: ((html||'').match(/<img\b/gi)||[]).length
  };
}

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  var q = req.method==='POST' ? (req.body||{}) : (req.query||{});
  var url = normUrl(q.url);
  if(!url) return res.status(400).json({error:'URL fehlt'});

  var home = await getHtml(url);
  if(!home.ok) return res.status(200).json({reachable:false, note:'Shop nicht erreichbar ('+(home.status||home.error)+')'});

  var sig = detect(home.html);
  // PDP suchen + scannen
  var pdpM = home.html.match(/href=["']([^"']*\/products\/[^"'?#]+)["']/i);
  if(pdpM){
    try{ var pdpUrl=pdpM[1].indexOf('http')===0?pdpM[1]:new URL(pdpM[1],url).href; var pdp=await getHtml(pdpUrl);
      if(pdp.ok){ var ps=detect(pdp.html); sig.aggregateRating=sig.aggregateRating||ps.aggregateRating; sig.reviewApp=sig.reviewApp||ps.reviewApp; sig.expressPay=sig.expressPay||ps.expressPay; sig.pdpImgCount=ps.imgCount; } }catch(e){}
  }
  var cwv = await pagespeed(url);

  // Leak-Marker (nur was server-seitig sicher erkennbar ist)
  var leaks=[];
  if(!(sig.reviewApp||sig.aggregateRating)) leaks.push({k:'reviews',t:'Keine Produkt-Reviews/Bewertung erkennbar',impact:'Reviews ~3–4× CR (Baymard)'});
  if(!sig.expressPay) leaks.push({k:'expresspay',t:'Kein Express-Checkout (Apple/Google Pay) erkannt',impact:'+15–37% Checkout (Shopify/Stripe)'});
  if(!sig.freeShip) leaks.push({k:'freeship',t:'Keine Free-Shipping-Schwelle erkannt',impact:'+7–10% AOV'});
  if(!sig.metaDesc) leaks.push({k:'meta',t:'Meta-Description fehlt',impact:'SEO/Klarheit'});
  if(sig.h1Count!==1) leaks.push({k:'h1',t:'H1-Struktur unsauber ('+sig.h1Count+'× H1)',impact:'Klarheit/SEO'});
  if(cwv){
    if(cwv.lcp!=null && cwv.lcp>2500) leaks.push({k:'lcp',t:'Ladezeit (LCP) '+(cwv.lcp/1000).toFixed(1)+'s > 2,5s',impact:'+32% Bounce/Sek (Google)'});
    if(cwv.cls!=null && cwv.cls>0.1) leaks.push({k:'cls',t:'Layout springt (CLS '+cwv.cls.toFixed(2)+')',impact:'bis +25% CR (web.dev)'});
    if(cwv.inp!=null && cwv.inp>200) leaks.push({k:'inp',t:'Träge Reaktion (INP '+cwv.inp+'ms)',impact:'2026 häufigster Fail'});
  }

  return res.status(200).json({
    reachable:true, url:url,
    shop:{ isShopify:sig.isShopify, theme:sig.theme },
    cwv:cwv,
    leaks:leaks,
    notCheckable:['Sticky-ATC','Checkout-Felder & Gast-Checkout','Trust-Platzierung','Cart-Drawer & Cross-Sell','visuelle Value-Prop']
  });
};
