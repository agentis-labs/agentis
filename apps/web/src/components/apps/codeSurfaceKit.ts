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
 * APPEARANCE: the tokens below are var-driven with dark fallbacks. The parent
 * (ViewRenderer) reads the REAL resolved `--color-*` / `--s-*` values off the
 * nearest `.s-surface` ancestor and injects them as a `:root` override, so a
 * CodeSurface is automatically on-brand in light AND dark (and follows accent
 * re-brands + color islands) — no hardcoded palette. If injection is absent the
 * dark fallbacks keep it legible.
 *
 * Both values are plain strings inlined into the iframe `srcDoc`. No remote
 * URLs are ever referenced (CSP forbids egress).
 */

/** Design tokens + base + component classes the kit renders against. Var-driven
 *  (parent injects the real palette) with dark fallbacks. */
export const CODE_SURFACE_TOKENS = `
:root{
  --canvas:#0a0a0b;--surface:#151518;--surface-2:#1d1d21;--surface-3:#27272c;
  --line:rgba(255,255,255,.08);--line-strong:rgba(255,255,255,.16);
  --text:#f4f4f5;--text-2:#a6a6ad;--muted:#6e6e77;--on-accent:#0a0a0b;
  --accent:#fafafa;--success:#4ade80;--danger:#f26d6d;--warn:#e0b341;--info:#d4d4d8;
  --radius:14px;--pad:20px;
  /* data palette — color belongs to DATA, not chrome */
  --c1:var(--accent);--c2:#14b8a6;--c3:#a855f7;--c4:#f97316;--c5:#f43f5e;--c6:#84cc16;
  --card-shadow:0 1px 2px rgba(0,0,0,.3),0 18px 40px -22px rgba(0,0,0,.6);
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--canvas);color:var(--text);font:13.5px/1.6 Inter,system-ui,-apple-system,sans-serif;padding:var(--pad);-webkit-font-smoothing:antialiased}
h1,h2,h3{margin:0;letter-spacing:-.02em}
a{color:var(--text)}
.ag-stack{display:flex;flex-direction:column;gap:16px}
.ag-row{display:flex;flex-wrap:wrap;gap:16px}
.ag-row>*{flex:1;min-width:0}
.ag-grid{display:grid;gap:16px}
.ag-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--pad);box-shadow:var(--card-shadow)}
.ag-card-title{font-size:13px;font-weight:600;letter-spacing:-.01em;margin-bottom:12px;color:var(--text)}
.ag-eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.ag-heading{font-size:26px;font-weight:600;color:var(--text);line-height:1.1}
.ag-subtitle{font-size:14px;color:var(--text-2);margin-top:6px;line-height:1.5}
.ag-text{font-size:13px;color:var(--text-2);line-height:1.6}
/* hero — a gradient header band, no image needed */
.ag-hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);padding:26px;background:
  radial-gradient(120% 140% at 100% 0%, color-mix(in srgb,var(--accent) 10%, transparent), transparent 60%),
  linear-gradient(180deg, var(--surface-2), var(--surface))}
/* metric tile — inset well, loud numeral, subtle top accent hairline */
.ag-metric{position:relative;overflow:hidden;background:linear-gradient(180deg,var(--surface-2),var(--surface));border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;min-width:0}
.ag-metric::before{content:"";position:absolute;left:0;top:0;height:2px;width:100%;background:linear-gradient(90deg,var(--accent),transparent 70%);opacity:.7}
.ag-metric-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.ag-metric-value{font-size:32px;font-weight:600;letter-spacing:-.02em;line-height:1.05;margin-top:6px;color:var(--text);font-variant-numeric:tabular-nums}
.ag-metric-delta{font-size:12px;margin-top:4px;color:var(--text-2)}
.ag-metric-delta.up{color:var(--success)}.ag-metric-delta.down{color:var(--danger)}
.ag-badge,.ag-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.01em}
.ag-pill::before{content:"";width:6px;height:6px;border-radius:999px;background:currentColor}
.ag-neutral{background:var(--surface-3);color:var(--text-2)}
.ag-accent{background:color-mix(in srgb,var(--accent) 14%, transparent);color:var(--accent)}
.ag-success{background:color-mix(in srgb,var(--success) 14%, transparent);color:var(--success)}
.ag-danger{background:color-mix(in srgb,var(--danger) 14%, transparent);color:var(--danger)}
.ag-warning{background:color-mix(in srgb,var(--warn) 16%, transparent);color:var(--warn)}
.ag-info{background:color-mix(in srgb,var(--info) 16%, transparent);color:var(--info)}
.ag-btn{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:var(--on-accent);border:none;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:600;letter-spacing:-.01em;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.ag-btn.ghost{background:transparent;color:var(--text-2);border:1px solid var(--line-strong);box-shadow:none}
.ag-table-wrap{overflow:auto;border:1px solid var(--line);border-radius:var(--radius)}
.ag-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ag-table th{text-align:left;padding:10px 14px;color:var(--muted);background:var(--canvas);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0}
.ag-table td{padding:10px 14px;border-top:1px solid var(--line);color:var(--text-2)}
.ag-table tr:hover td{background:color-mix(in srgb,var(--text) 3%, transparent)}
.ag-chart-axis{font-size:10px;fill:var(--muted)}
`;

/** Vanilla-JS component + chart kit. Attaches to window.ui inside the frame. */
export const CODE_SURFACE_KIT = `
(function(){
  var NS='http://www.w3.org/2000/svg';
  var CVARS=['var(--c1)','var(--c2)','var(--c3)','var(--c4)','var(--c5)','var(--c6)'];
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
  ui.render=function(node){var r=root();r.innerHTML='';append(r,node);return r;};
  ui.clear=function(){root().innerHTML='';};
  ui.heading=function(t,sub){return h('div',null,h('div',{class:'ag-heading'},t),sub?h('div',{class:'ag-subtitle'},sub):null);};
  ui.eyebrow=function(t){return h('div',{class:'ag-eyebrow'},t);};
  ui.text=function(t){return h('div',{class:'ag-text'},t);};
  ui.hero=function(opts){opts=opts||{};var c=h('div',{class:'ag-hero'});if(opts.eyebrow)c.appendChild(h('div',{class:'ag-eyebrow',style:{marginBottom:'8px'}},opts.eyebrow));if(opts.title)c.appendChild(h('div',{class:'ag-heading'},opts.title));if(opts.subtitle)c.appendChild(h('div',{class:'ag-subtitle'},opts.subtitle));return c;};
  ui.card=function(title){var c=h('div',{class:'ag-card'});if(title)c.appendChild(h('div',{class:'ag-card-title'},title));for(var i=1;i<arguments.length;i++)append(c,arguments[i]);return c;};
  ui.stack=function(){var e=h('div',{class:'ag-stack'});for(var i=0;i<arguments.length;i++)append(e,arguments[i]);return e;};
  ui.row=function(){var e=h('div',{class:'ag-row'});for(var i=0;i<arguments.length;i++)append(e,arguments[i]);return e;};
  ui.grid=function(cols){var e=h('div',{class:'ag-grid',style:{gridTemplateColumns:'repeat('+(cols||3)+',minmax(0,1fr))'}});for(var i=1;i<arguments.length;i++)append(e,arguments[i]);return e;};
  ui.metric=function(label,value,delta){var d=null;if(delta!=null){var s=String(delta);var cls='ag-metric-delta'+(/^\\+|▲|↑/.test(s)?' up':/^-|▼|↓/.test(s)?' down':'');d=h('div',{class:cls},s);}return h('div',{class:'ag-metric'},h('div',{class:'ag-metric-label'},label),h('div',{class:'ag-metric-value'},value),d);};
  ui.kpi=function(items){var g=h('div',{class:'ag-grid',style:{gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))'}});(items||[]).forEach(function(it){g.appendChild(ui.metric(it.label,it.value,it.delta));});return g;};
  ui.badge=function(text,tone){return h('span',{class:'ag-badge ag-'+(tone||'neutral')},text);};
  ui.pill=function(text,tone){return h('span',{class:'ag-pill ag-'+(tone||'neutral')},text);};
  ui.button=function(label,onClick,variant){return h('button',{class:'ag-btn'+(variant==='ghost'?' ghost':''),onclick:onClick||function(){}},label);};
  ui.table=function(rows,cols){
    var columns=(cols||[]).map(function(c){return typeof c==='string'?{key:c,label:c}:c;});
    var thead=h('tr');columns.forEach(function(c){thead.appendChild(h('th',null,c.label||c.key));});
    var body=(rows||[]).map(function(r){var tr=h('tr');columns.forEach(function(c){var val=r[c.key];tr.appendChild(h('td',null,val==null?'':(c.render?c.render(val,r):String(val))));});return tr;});
    return h('div',{class:'ag-table-wrap'},h('table',{class:'ag-table'},h('thead',null,thead),h('tbody',null,body)));
  };
  // ── charts (SVG; colors are data-palette CSS vars → auto light/dark) ──
  function svg(w,hh){var s=document.createElementNS(NS,'svg');s.setAttribute('viewBox','0 0 '+w+' '+hh);s.setAttribute('width','100%');s.setAttribute('height',hh);s.style.display='block';return s;}
  function el(p,tag,a){var e=document.createElementNS(NS,tag);for(var k in a)e.setAttribute(k,a[k]);p.appendChild(e);return e;}
  function maxOf(rows,y){return Math.max.apply(null,[1].concat(rows.map(function(r){return num(r[y]);})));}
  ui.chart={};
  ui.chart.bar=function(rows,x,y){var W=560,H=220,L=40,B=26,T=10,R=10,s=svg(W,H);var n=rows.length||1;var mx=maxOf(rows,y);var bw=(W-L-R)/n;rows.forEach(function(r,i){var v=num(r[y]);var bh=(H-T-B)*(v/mx);el(s,'rect',{x:L+bw*i+bw*0.15,y:H-B-bh,width:bw*0.7,height:bh,fill:'var(--c1)',rx:3});var t=el(s,'text',{x:L+bw*i+bw*0.5,y:H-9,'text-anchor':'middle','class':'ag-chart-axis'});t.textContent=String(r[x]).slice(0,8);});return s;};
  ui.chart.line=function(rows,x,y){return lineArea(rows,x,y,false);};
  ui.chart.area=function(rows,x,y){return lineArea(rows,x,y,true);};
  function lineArea(rows,x,y,fill){var W=560,H=220,L=40,B=26,T=12,R=12,s=svg(W,H);var n=rows.length;if(n<2)return s;var mx=maxOf(rows,y);var mn=Math.min.apply(null,[0].concat(rows.map(function(r){return num(r[y]);})));function sx(i){return L+(W-L-R)*(i/(n-1));}function sy(v){return T+(H-T-B)*(1-(v-mn)/((mx-mn)||1));}var pts=rows.map(function(r,i){return sx(i).toFixed(1)+' '+sy(num(r[y])).toFixed(1);});if(fill){var id='ag-g'+Math.floor(sx(1));var defs=el(s,'defs',{});var lg=el(defs,'linearGradient',{id:id,x1:'0',y1:'0',x2:'0',y2:'1'});el(lg,'stop',{offset:'0%','stop-color':'var(--c1)','stop-opacity':'.35'});el(lg,'stop',{offset:'100%','stop-color':'var(--c1)','stop-opacity':'0'});el(s,'path',{d:'M '+pts.join(' L ')+' L '+sx(n-1).toFixed(1)+' '+(H-B)+' L '+sx(0).toFixed(1)+' '+(H-B)+' Z',fill:'url(#'+id+')'});}el(s,'path',{d:'M '+pts.join(' L '),fill:'none',stroke:'var(--c1)','stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'});rows.forEach(function(r,i){el(s,'circle',{cx:sx(i),cy:sy(num(r[y])),r:2.5,fill:'var(--c1)'});});return s;};
  ui.chart.donut=function(rows,label,value){var H=200,R=80,cx=100,cy=100,inner=48,s=svg(220,H);var total=rows.reduce(function(a,r){return a+num(r[value]);},0)||1;var ang=-Math.PI/2;rows.forEach(function(r,i){var frac=num(r[value])/total;var end=ang+frac*Math.PI*2;var large=end-ang>Math.PI?1:0;function p(rad,a){return (cx+rad*Math.cos(a)).toFixed(1)+' '+(cy+rad*Math.sin(a)).toFixed(1);}var d='M '+p(inner,ang)+' L '+p(R,ang)+' A '+R+' '+R+' 0 '+large+' 1 '+p(R,end)+' L '+p(inner,end)+' A '+inner+' '+inner+' 0 '+large+' 0 '+p(inner,ang)+' Z';el(s,'path',{d:d,fill:CVARS[i%CVARS.length]});ang=end;});return s;};
  window.ui=ui;
})();
`;
