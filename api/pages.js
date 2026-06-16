// ============================================================
//  BB Brands — First-Party Page-Analytics · Aggregat (/api/pages)
//  GET /api/pages?token=ADMIN_TOKEN[&days=30] → pro Seite:
//    Aufrufe · eindeutige Besucher · Quellen · Top-Klicks
//  Liest bb:track (geschrieben von /api/track). Admin-gated.
//  Env: KV_REST_API_* / UPSTASH_REDIS_REST_* · ADMIN_TOKEN
// ============================================================
const KV_URL=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'';
const KV_TOKEN=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'';
const ADMIN_TOKEN=process.env.ADMIN_TOKEN||'';
const KEY='bb:track';

async function redis(){ if(!KV_URL||!KV_TOKEN) return null; var r=await fetch(KV_URL,{method:'POST',headers:{Authorization:'Bearer '+KV_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(Array.prototype.slice.call(arguments))}); if(!r.ok) return null; var d=await r.json(); return d.result; }

function source(ev){
  var u=ev.utm||{};
  if(u.utm_source) return String(u.utm_source);
  var r=ev.ref||'';
  if(!r) return 'Direct';
  try{
    var h=new URL(r).hostname.replace(/^www\./,'').toLowerCase();
    if(/instagram/.test(r)||/instagram/.test(h)) return 'Instagram';
    if(/facebook|fb\.com|fb\.me/.test(h)) return 'Facebook';
    if(/google\./.test(h)) return 'Google';
    if(/t\.co|twitter|x\.com/.test(h)) return 'X/Twitter';
    if(/linkedin|lnkd/.test(h)) return 'LinkedIn';
    if(/youtube|youtu\.be/.test(h)) return 'YouTube';
    if(/tiktok/.test(h)) return 'TikTok';
    if(/bb-brands\.de/.test(h)) return 'Intern';
    return h;
  }catch(e){ return 'Referral'; }
}
function topN(obj,n){ return Object.keys(obj).map(function(k){return {name:k,count:obj[k]};}).sort(function(a,b){return b.count-a.count;}).slice(0,n||25); }

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  var q=req.query||{};
  // Öffentlich lesbar — reine, anonyme Traffic-Aggregate (kein PII, keine Lead-Daten).
  if(!KV_URL||!KV_TOKEN) return res.status(200).json({pages:[],note:'Redis nicht konfiguriert'});

  try{
    var raw=await redis('LRANGE',KEY,'0','-1')||[];
    var days=+q.days||30, cutoff=Date.now()-days*864e5;
    var pages={};
    raw.forEach(function(s){
      var ev; try{ ev=JSON.parse(s); }catch(_){ return; }
      if(!ev||(ev.ts||0)<cutoff) return;
      var p=ev.p||'/';
      var pg=pages[p]||(pages[p]={path:p,views:0,uniq:{},sources:{},clicks:{}});
      if(ev.t==='click'){ var l=ev.l||'(unbenannt)'; pg.clicks[l]=(pg.clicks[l]||0)+1; }
      else { pg.views++; if(ev.sid)pg.uniq[ev.sid]=1; var sc=source(ev); pg.sources[sc]=(pg.sources[sc]||0)+1; }
    });
    var out=Object.keys(pages).map(function(p){ var pg=pages[p]; return {
      path:pg.path, views:pg.views, uniques:Object.keys(pg.uniq).length,
      sources:topN(pg.sources,30), clicks:topN(pg.clicks,30)
    };}).sort(function(a,b){return b.views-a.views;});
    return res.status(200).json({days:days, pages:out, total:out.reduce(function(s,p){return s+p.views;},0)});
  }catch(e){
    return res.status(200).json({pages:[], error:String(e&&e.message||e)});
  }
};
