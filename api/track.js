// ============================================================
//  BB Brands — First-Party Page-Analytics · Ingest (/api/track)
//  Nimmt anonyme Pageview-/Klick-Events von bb-pageview.js entgegen.
//  Storage: Redis-Liste bb:track (capped 20k). Aggregation: /api/pages.
//  Kein PII (nur Pfad, Quelle, anonyme Session-ID). DSGVO: berechtigtes
//  Interesse / eigene Reichweitenmessung (wie events.js).
//  Env: KV_REST_API_* / UPSTASH_REDIS_REST_*
// ============================================================
const KV_URL=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'';
const KV_TOKEN=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'';
const KEY='bb:track';

async function redis(){ if(!KV_URL||!KV_TOKEN) return null; var r=await fetch(KV_URL,{method:'POST',headers:{Authorization:'Bearer '+KV_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(Array.prototype.slice.call(arguments))}); if(!r.ok) return null; var d=await r.json(); return d.result; }

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(200).json({ok:true});
  try{
    var b=req.body;
    if(typeof b==='string'){ try{ b=JSON.parse(b); }catch(_){ b={}; } }
    b=b||{};
    var t=(b.t==='click')?'click':'pv';
    var rec={
      p:String(b.p||'/').slice(0,140),
      t:t,
      l:t==='click'?String(b.l||'').slice(0,80):undefined,
      ref:String(b.ref||'').slice(0,220),
      utm:(b.utm&&typeof b.utm==='object')?b.utm:null,
      sid:String(b.sid||'').slice(0,48),
      ts:+b.ts||Date.now()
    };
    if(KV_URL&&KV_TOKEN){ await redis('LPUSH',KEY,JSON.stringify(rec)); await redis('LTRIM',KEY,'0','19999'); }
    return res.status(200).json({ok:true});
  }catch(e){ return res.status(200).json({ok:false}); }
};
