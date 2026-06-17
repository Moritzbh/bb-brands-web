// ============================================================
//  BB Brands — Öffentliche Report-Daten (/api/report?id={scanId})
//  Gibt EINE gespeicherte Profit-Analyse zurück (für die dynamische
//  Report-Seite auf videos.bb-brands.de/analyse/?id=). Kein Token:
//  der Prospect öffnet seinen eigenen Report über eine opake ID.
//  Nur Analyse-Felder, keine internen/sensiblen Daten.
//  Env: KV_REST_API_* / UPSTASH_REDIS_REST_*
// ============================================================
const KV_URL=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'';
const KV_TOKEN=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'';
const SCANS_KEY='bb:scans';

async function redis(){ if(!KV_URL||!KV_TOKEN) return null; var r=await fetch(KV_URL,{method:'POST',headers:{Authorization:'Bearer '+KV_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(Array.prototype.slice.call(arguments))}); if(!r.ok) return null; var d=await r.json(); return d.result; }

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  var id=((req.query||{}).id||'').trim();
  if(!id) return res.status(400).json({error:'id fehlt'});
  if(!KV_URL||!KV_TOKEN) return res.status(200).json({error:'Redis nicht konfiguriert'});
  try{
    var raw=await redis('HGET',SCANS_KEY,id);
    if(!raw) return res.status(404).json({error:'not found'});
    var s=JSON.parse(raw);
    return res.status(200).json({ok:true, scan:{
      domain:s.domain||null, url:s.url||null, ts:s.ts||null,
      inputs:s.inputs||{}, leak_eur_month:s.leak_eur_month||null, segment:s.segment||null,
      brand:s.brand||null, findings:s.findings||{}
    }});
  }catch(e){ return res.status(200).json({error:String(e&&e.message||e)}); }
};
