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

// --- Brand-Assets fürs Analyse-Cover (Logo, Markenfarbe, Name) ---
function metaContent(html, key){
  var k=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  var m=html.match(new RegExp('<meta[^>]+(?:name|property)=["\']'+k+'["\'][^>]*content=["\']([^"\']+)["\']','i'))
       || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:name|property)=["\']'+k+'["\']','i'));
  return m?m[1].trim():null;
}
function linkHref(html, rel){
  var m=html.match(new RegExp('<link[^>]+rel=["\'][^"\']*'+rel+'[^"\']*["\'][^>]*href=["\']([^"\']+)["\']','i'))
       || html.match(new RegExp('<link[^>]+href=["\']([^"\']+)["\'][^>]*rel=["\'][^"\']*'+rel+'[^"\']*["\']','i'));
  return m?m[1].trim():null;
}
function validColor(c){ if(!c) return null; c=c.trim(); return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : null; }
function hex6(c){ var h=c.replace('#','').toLowerCase(); if(h.length===3) h=h.replace(/./g,'$&$&'); return '#'+h; }
// "Brand-tauglich": nicht fast-weiß/-schwarz, nicht grau
function isBrandy(c){
  var h=hex6(c).slice(1); var r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);
  var max=Math.max(r,g,b),min=Math.min(r,g,b), lum=(0.299*r+0.587*g+0.114*b)/255, sat=max===0?0:(max-min)/max;
  return lum<0.93 && lum>0.06 && sat>=0.18;
}
// Echte CI-Farbe aus der Seite ziehen: theme-color -> AM HAEUFIGSTEN verwendete gesaettigte Farbe
// (meist die echte Akzent-/CTA-Farbe) -> Brand-CSS-Variable -> Fallback
function pickBrandColor(html){
  var tc=validColor(metaContent(html,'theme-color'))||validColor(metaContent(html,'msapplication-TileColor'));
  if(tc && isBrandy(tc)) return hex6(tc);
  var styleBlob=((html.match(/<style[\s\S]*?<\/style>/gi)||[]).join(' '))+' '+((html.match(/style=["'][^"']*["']/gi)||[]).join(' '));
  // 1) Haeufigste gesaettigte Farbe der Seite (= meist die echte Marken-/CTA-Farbe)
  var hexes=styleBlob.match(/#[0-9a-fA-F]{6}\b/g)||[], freq={};
  hexes.forEach(function(x){ x=x.toLowerCase(); if(isBrandy(x)) freq[x]=(freq[x]||0)+1; });
  var best=null,n=0; Object.keys(freq).forEach(function(x){ if(freq[x]>n){n=freq[x];best=x;} });
  if(best && n>=3) return best;
  // 2) Brand-/Accent-/Button-CSS-Variable
  var varRe=/--[a-z0-9-]*(?:primary|accent|brand|button|cta|main|theme|color-base|highlight)[a-z0-9-]*\s*:\s*(#[0-9a-fA-F]{3,6})/gi, vm, varHit=null;
  while((vm=varRe.exec(styleBlob))){ if(isBrandy(vm[1])){ varHit=hex6(vm[1]); break; } }
  if(varHit) return varHit;
  // 3) seltene Treffer / Fallback
  if(best) return best;
  return tc?hex6(tc):null;
}
// Feste Overrides fuer Ziel-Brands (Domain ohne www) — schlagen die Auto-Erkennung.
// Farbe ggf. per Screenshot der Homepage bestimmt; nur setzen was wirklich stimmt.
var BRAND_OVERRIDES = {
  'haferloewe.de': { color:'#efa727', name:'Haferlöwe' }
};
function brandAssets(html, baseUrl){
  var host=''; try{ host=new URL(baseUrl).hostname.replace(/^www\./,''); }catch(e){}
  var ov=BRAND_OVERRIDES[host]||{};
  var color=ov.color||pickBrandColor(html);
  var logo=ov.logo||linkHref(html,'apple-touch-icon')||linkHref(html,'icon');
  try{ if(logo) logo=new URL(logo, baseUrl).href; }catch(e){ logo=null; }
  if(!logo && host) logo='https://www.google.com/s2/favicons?domain='+host+'&sz=128';
  var name=ov.name||metaContent(html,'og:site_name');
  if(!name){ var t=(html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]; if(t) name=t.split(/[|–—·:\-]/)[0].trim(); }
  if(!name && host) name=host.split('.')[0];
  return {color:color, logo:logo, name:name||null};
}

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  var q = req.method==='POST' ? (req.body||{}) : (req.query||{});
  var quick = q.quick==='1' || q.quick===1 || q.quick===true;  // schneller Gate-Scan (videos.bb-brands.de/case): ohne PageSpeed, ~3s statt ~20s
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
  var cwv = quick ? null : await pagespeed(url);

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
    brand: brandAssets(home.html, url),
    shop:{ isShopify:sig.isShopify, theme:sig.theme },
    cwv:cwv,
    leaks:leaks,
    notCheckable:['Sticky-ATC','Checkout-Felder & Gast-Checkout','Trust-Platzierung','Cart-Drawer & Cross-Sell','visuelle Value-Prop']
  });
};
