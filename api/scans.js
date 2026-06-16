// ============================================================
//  BB Brands — Profit-Analyse Store (/api/scans)
//  Liest die in deep-analyze.js gespeicherten Analysen (bb:scans).
//  GET /api/scans?token=ADMIN_TOKEN[&domain=foo&days=90]  → Liste (admin)
//  Schreiben passiert in api/deep-analyze.js (HSET bb:scans).
//  Env: KV_REST_API_* / UPSTASH_REDIS_REST_* · ADMIN_TOKEN
// ============================================================
const KV_URL=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'';
const KV_TOKEN=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'';
const ADMIN_TOKEN=process.env.ADMIN_TOKEN||'';
const SCANS_KEY='bb:scans';

async function redis(){ if(!KV_URL||!KV_TOKEN) return null; var r=await fetch(KV_URL,{method:'POST',headers:{Authorization:'Bearer '+KV_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(Array.prototype.slice.call(arguments))}); if(!r.ok) return null; var d=await r.json(); return d.result; }

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  var q=req.query||{};
  var token=q.token||(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!ADMIN_TOKEN || token!==ADMIN_TOKEN) return res.status(401).json({error:'unauthorized'});
  if(!KV_URL||!KV_TOKEN) return res.status(200).json({scans:[],note:'Redis nicht konfiguriert'});

  try{
    var flat=await redis('HGETALL',SCANS_KEY); // [field,value,field,value,...]
    var out=[];
    if(Array.isArray(flat)){
      for(var i=0;i<flat.length;i+=2){ try{ out.push(JSON.parse(flat[i+1])); }catch(e){} }
    }
    var domain=(q.domain||'').toLowerCase().trim();
    if(domain) out=out.filter(function(s){ return (s.domain||'').toLowerCase().indexOf(domain)>=0 || (s.url||'').toLowerCase().indexOf(domain)>=0; });
    var days=+q.days||90; var cutoff=Date.now()-days*864e5;
    out=out.filter(function(s){ return (s.ts||0)>=cutoff; });
    out.sort(function(a,b){ return (b.ts||0)-(a.ts||0); });
    return res.status(200).json({count:out.length, scans:out.slice(0,500)});
  }catch(e){
    return res.status(200).json({scans:[], error:String(e&&e.message||e)});
  }
};
