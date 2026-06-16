/* BB Brands — First-Party Page-Analytics (anonym).
   Feuert pro Seitenaufruf einen Pageview + erfasst Klicks auf Links/Buttons.
   Kein PII, anonyme Session-ID. Sendet an /api/track. */
(function(){
  try{
    var sid;
    try{ sid=localStorage.getItem('bb_sid'); }catch(_){}
    if(!sid && window.BBFunnel && BBFunnel.sid) sid=BBFunnel.sid;
    if(!sid){ sid='s'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
    try{ localStorage.setItem('bb_sid',sid); }catch(_){}

    function utm(){
      var attr=(window.bbAttribution&&window.bbAttribution.getAll)?window.bbAttribution.getAll():null;
      if(attr && attr.utm_source) return {utm_source:attr.utm_source,utm_medium:attr.utm_medium,utm_campaign:attr.utm_campaign,utm_content:attr.utm_content};
      var o={}, p=new URLSearchParams(location.search);
      ['utm_source','utm_medium','utm_campaign','utm_content'].forEach(function(k){var v=p.get(k);if(v)o[k]=v;});
      return Object.keys(o).length?o:null;
    }
    var base={ p:(location.pathname.replace(/\/+$/,'')||'/'), sid:sid, ref:document.referrer||'', utm:utm() };

    function send(ev){
      try{
        var body=JSON.stringify(Object.assign({},base,ev,{ts:Date.now()}));
        if(navigator.sendBeacon){ navigator.sendBeacon('/api/track', new Blob([body],{type:'application/json'})); }
        else{ fetch('/api/track',{method:'POST',headers:{'content-type':'application/json'},body:body,keepalive:true}).catch(function(){}); }
      }catch(_){}
    }

    send({t:'pv'});

    document.addEventListener('click', function(e){
      try{
        var el=e.target && e.target.closest ? e.target.closest('a,button,[role="button"]') : null;
        if(!el) return;
        var label=(el.getAttribute('aria-label')||el.getAttribute('data-t')||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,60);
        if(!label){ label=(el.tagName||'el').toLowerCase(); }
        send({t:'click', l:label});
      }catch(_){}
    }, true);
  }catch(_){}
})();
