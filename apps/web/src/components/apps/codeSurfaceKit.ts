/**
 * codeSurfaceKit — the on-brand runtime injected into a CodeSurface sandbox.
 *
 * A CodeSurface runs agent-authored JS in the SAME hardened, null-origin,
 * zero-egress iframe as CustomView. To make that power produce great UI, we
 * inject (1) the Agentis design tokens + base component CSS and (2) a small
 * vanilla-JS component/chart kit on `window.ui`. The agent's code then has
 * `ui` (build UI) + `agentis` (the data/action bridge) + `root` (mount point)
 * — no network, no parent DOM, no build step.
 *
 * Both values are plain strings inlined into the iframe `srcDoc`. No remote
 * URLs are ever referenced (CSP forbids egress).
 */

/** Design tokens (dark) + base + component classes the kit renders against. */
export const CODE_SURFACE_TOKENS = `
:root{
  --canvas:#08090b;--surface:#0f1014;--surface-2:#15171c;--line:#1b1d22;--line-strong:#252830;
  --text:#e8eaee;--text-2:#a1a8b3;--muted:#6b7280;
  --accent:#4ade80;--success:#4ade80;--danger:#ef4444;--warn:#f59e0b;--info:#60a5fa;
}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--text);font:14px/1.5 Inter,system-ui,-apple-system,sans-serif;padding:16px}
h1,h2,h3{margin:0}
.ag-stack{display:flex;flex-direction:column;gap:12px}
.ag-row{display:flex;flex-wrap:wrap;gap:12px}
.ag-grid{display:grid;gap:12px}
.ag-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.ag-card-title{font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text)}
.ag-heading{font-size:18px;font-weight:600;color:var(--text)}
.ag-text{font-size:13px;color:var(--text-2);line-height:1.6}
.ag-metric{background:var(--canvas);border:1px solid var(--line);border-radius:10px;padding:12px;flex:1;min-width:120px}
.ag-metric-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.ag-metric-value{font-size:22px;font-weight:600;margin-top:2px;color:var(--text)}
.ag-metric-delta{font-size:11px;color:var(--text-2);margin-top:2px}
.ag-badge{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px}
.ag-neutral{background:var(--surface-2);color:var(--text-2)}
.ag-accent{background:rgba(74,222,128,.12);color:var(--accent)}
.ag-success{background:rgba(74,222,128,.12);color:var(--success)}
.ag-danger{background:rgba(239,68,68,.12);color:var(--danger)}
.ag-warning{background:rgba(245,158,11,.12);color:var(--warn)}
.ag-info{background:rgba(96,165,250,.12);color:var(--info)}
.ag-btn{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#06240f;border:none;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer}
.ag-table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}
.ag-table{width:100%;border-collapse:collapse;font-size:12px}
.ag-table th{text-align:left;padding:8px 12px;color:var(--muted);background:var(--canvas);font-weight:500}
.ag-table td{padding:8px 12px;border-top:1px solid var(--line);color:var(--text-2)}
`;

/** Vanilla-JS component + chart kit. Attaches to window.ui inside the frame. */
export const CODE_SURFACE_KIT = `
(function(){
  var NS='http://www.w3.org/2000/svg';
  var PALETTE=['#3b82f6','#14b8a6','#a855f7','#f97316','#f43f5e','#84cc16'];
  function num(v){var n=Number(v);return isFinite(n)?n:0;}
  function h(tag,props){
    var e=document.createElement(tag);
    if(props)for(var k in props){
      var v=props[k];
      if(v==null)continue;
      if(k==='style'&&typeof v==='object')Object.assign(e.style,v);
      else if(k==='class')e.className=v;
      else if(k.indexOf('on')===0&&typeof v==='function')e.addEventListener(k.slice(2).toLowerCase(),v);
      else e.setAttribute(k,v);
    }
    for(var i=2;i<arguments.length;i++)append(e,arguments[i]);
    return e;
  }
  function append(e,kid){
    if(kid==null)return;
    if(Array.isArray(kid)){kid.forEach(function(k){append(e,k);});return;}
    e.appendChild(typeof kid==='object'?kid:document.createTextNode(String(kid)));
  }
  function root(){return document.getElementById('agentis-root');}
  var ui={h:h};
  ui.mount=function(node){root().appendChild(node);return node;};
  ui.clear=function(){root().innerHTML='';};
  ui.heading=function(t){return h('div',{class:'ag-heading'},t);};
  ui.text=function(t){return h('div',{class:'ag-text'},t);};
  ui.card=function(title){var c=h('div',{class:'ag-card'});if(title)c.appendChild(h('div',{class:'ag-card-title'},title));for(var i=1;i<arguments.length;i++)append(c,arguments[i]);return c;};
  ui.stack=function(){var e=h('div',{class:'ag-stack'});for(var i=0;i<arguments.length;i++)append(e,arguments[i]);return e;};
  ui.row=function(){var e=h('div',{class:'ag-row'});for(var i=0;i<arguments.length;i++)append(e,arguments[i]);return e;};
  ui.grid=function(cols){var e=h('div',{class:'ag-grid',style:{gridTemplateColumns:'repeat('+(cols||3)+',minmax(0,1fr))'}});for(var i=1;i<arguments.length;i++)append(e,arguments[i]);return e;};
  ui.metric=function(label,value,delta){return h('div',{class:'ag-metric'},h('div',{class:'ag-metric-label'},label),h('div',{class:'ag-metric-value'},value),delta!=null?h('div',{class:'ag-metric-delta'},delta):null);};
  ui.badge=function(text,tone){return h('span',{class:'ag-badge ag-'+(tone||'neutral')},text);};
  ui.button=function(label,onClick){return h('button',{class:'ag-btn',onclick:onClick||function(){}},label);};
  ui.table=function(rows,cols){
    var thead=h('tr');cols.forEach(function(c){thead.appendChild(h('th',null,c));});
    var body=(rows||[]).map(function(r){var tr=h('tr');cols.forEach(function(c){tr.appendChild(h('td',null,r[c]==null?'':String(r[c])));});return tr;});
    return h('div',{class:'ag-table-wrap'},h('table',{class:'ag-table'},h('thead',null,thead),h('tbody',null,body)));
  };
  // ── charts (SVG) ──
  function svg(w,hh){var s=document.createElementNS(NS,'svg');s.setAttribute('viewBox','0 0 '+w+' '+hh);s.setAttribute('width','100%');s.setAttribute('height',hh);s.style.display='block';return s;}
  function el(p,tag,a){var e=document.createElementNS(NS,tag);for(var k in a)e.setAttribute(k,a[k]);p.appendChild(e);return e;}
  ui.chart={};
  ui.chart.bar=function(rows,x,y){var W=560,H=220,L=40,B=24,T=10,R=10,s=svg(W,H);var n=rows.length||1;var mx=Math.max.apply(null,[1].concat(rows.map(function(r){return num(r[y]);})));var bw=(W-L-R)/n;rows.forEach(function(r,i){var v=num(r[y]);var bh=(H-T-B)*(v/mx);el(s,'rect',{x:L+bw*i+bw*0.15,y:H-B-bh,width:bw*0.7,height:bh,fill:'#3b82f6',rx:2});var t=el(s,'text',{x:L+bw*i+bw*0.5,y:H-8,'text-anchor':'middle','font-size':10,fill:'#6b7280'});t.textContent=String(r[x]).slice(0,8);});return s;};
  ui.chart.line=function(rows,x,y){var W=560,H=220,L=40,B=24,T=10,R=10,s=svg(W,H);var n=rows.length;if(n<2)return s;var mx=Math.max.apply(null,[1].concat(rows.map(function(r){return num(r[y]);})));var mn=Math.min.apply(null,[0].concat(rows.map(function(r){return num(r[y]);})));function sx(i){return L+(W-L-R)*(i/(n-1));}function sy(v){return T+(H-T-B)*(1-(v-mn)/((mx-mn)||1));}var d=rows.map(function(r,i){return (i?'L':'M')+sx(i).toFixed(1)+' '+sy(num(r[y])).toFixed(1);}).join(' ');el(s,'path',{d:d,fill:'none',stroke:'#3b82f6','stroke-width':2,'stroke-linejoin':'round'});rows.forEach(function(r,i){el(s,'circle',{cx:sx(i),cy:sy(num(r[y])),r:2.5,fill:'#3b82f6'});});return s;};
  ui.chart.donut=function(rows,label,value){var H=200,R=80,cx=100,cy=100,inner=46,s=svg(220,H);var total=rows.reduce(function(a,r){return a+num(r[value]);},0)||1;var ang=-Math.PI/2;rows.forEach(function(r,i){var frac=num(r[value])/total;var end=ang+frac*Math.PI*2;var large=end-ang>Math.PI?1:0;function p(rad,a){return (cx+rad*Math.cos(a)).toFixed(1)+' '+(cy+rad*Math.sin(a)).toFixed(1);}var d='M '+p(inner,ang)+' L '+p(R,ang)+' A '+R+' '+R+' 0 '+large+' 1 '+p(R,end)+' L '+p(inner,end)+' A '+inner+' '+inner+' 0 '+large+' 0 '+p(inner,ang)+' Z';el(s,'path',{d:d,fill:PALETTE[i%PALETTE.length]});ang=end;});return s;};
  window.ui=ui;
})();
`;
