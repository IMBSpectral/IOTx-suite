/**
 * Keeps what people type when the page reloads unexpectedly (a deploy, a dropped
 * connection, a crash). Runs in every page of the suite (and, as a copy, in the
 * Workspace app: apps/workspace/src/lib/draft-keeper.ts; keep the two in step).
 *
 * - Text typed in an input or textarea is saved in this browser (localStorage) a
 *   moment after each keystroke and when the page is hidden or unloaded.
 * - After a reload, an EMPTY field that had a draft gets it back, and a small notice
 *   says so, with Discard.
 * - A draft is removed when its field is emptied (sent, cleared), after 7 days, and
 *   for everyone when the sign-in page opens (signing out lands there).
 * - Never saved: passwords, hidden fields, one-time codes, card fields, search boxes,
 *   the address bar, read-only or disabled fields, anything inside [data-no-draft].
 *
 * Plain script, no React: it must run in every app and before anything else can fail.
 */
export const DRAFT_SCRIPT = `(function(){try{
var P="iotx-draft:",TTL=7*864e5,MAX=200000;
var ls=window.localStorage;if(!ls)return;
function keys(){var o=[];for(var i=0;i<ls.length;i++){var k=ls.key(i);if(k&&k.indexOf(P)===0)o.push(k);}return o;}
if(/^\\/login(\\/|$)/.test(location.pathname)){keys().forEach(function(k){ls.removeItem(k);});return;}
var now=Date.now();keys().forEach(function(k){try{var d=JSON.parse(ls.getItem(k));if(!d||now-d.t>TTL)ls.removeItem(k);}catch(e){ls.removeItem(k);}});
function skip(el){
  if(!el||el.disabled||el.readOnly)return true;
  if(el.closest&&el.closest("[data-no-draft]"))return true;
  var ac=(el.getAttribute("autocomplete")||"").toLowerCase();
  if(/one-time-code|cc-|password/.test(ac))return true;
  if(el.tagName==="TEXTAREA")return false;
  if(el.tagName!=="INPUT")return true;
  var t=(el.getAttribute("type")||"text").toLowerCase();
  if(!/^(text|email|url|tel)$/.test(t))return true;
  var role=el.getAttribute("role");if(role==="combobox"||role==="searchbox")return true;
  /* Search boxes are throwaway; bringing one back would quietly filter the page. */
  if(/^search/i.test(el.getAttribute("aria-label")||el.getAttribute("placeholder")||""))return true;
  return false;}
function label(el){
  var id=el.id&&!/^[:\\u00ab]|^radix-|^headlessui|[0-9]{4,}/.test(el.id)?el.id:"";
  return el.tagName+"|"+(el.getAttribute("name")||"")+"|"+(el.getAttribute("aria-label")||"")+"|"+(el.getAttribute("placeholder")||"")+"|"+id;}
function keyOf(el){
  var l=label(el),n=0,all=document.querySelectorAll("input,textarea");
  for(var i=0;i<all.length;i++){if(all[i]===el)break;if(!skip(all[i])&&label(all[i])===l)n++;}
  return P+location.pathname+location.search+"|"+l+"|"+n;}
function setVal(el,v){
  var proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  var d=Object.getOwnPropertyDescriptor(proto,"value");
  if(d&&d.set)d.set.call(el,v);else el.value=v;
  el.dispatchEvent(new Event("input",{bubbles:true}));}
var touched=[],timers=new Map();
function track(el,k){for(var i=0;i<touched.length;i++)if(touched[i].el===el)return touched[i];var e={el:el,k:k,last:el.value};touched.push(e);return e;}
function save(el){
  if(!el.isConnected||skip(el))return;
  var e=track(el,el.__dk||keyOf(el));el.__dk=e.k;
  var v=el.value;e.last=v;
  try{if(!v.trim())ls.removeItem(e.k);else if(v.length<=MAX)ls.setItem(e.k,JSON.stringify({v:v,t:Date.now()}));}catch(x){}}
document.addEventListener("input",function(ev){
  var el=ev.target;if(!el||skip(el)||el.__dkRestoring)return;
  clearTimeout(timers.get(el));timers.set(el,setTimeout(function(){save(el);},300));},true);
function flush(){timers.forEach(function(t,el){clearTimeout(t);save(el);});timers.clear();}
window.addEventListener("pagehide",flush);window.addEventListener("beforeunload",flush);
document.addEventListener("visibilitychange",function(){if(document.hidden)flush();});
/* A field the page emptied itself (message sent, form reset) drops its draft. */
function sweep(){for(var i=touched.length-1;i>=0;i--){var e=touched[i];
  if(!e.el.isConnected){touched.splice(i,1);continue;}
  if(e.el.value!==e.last){e.last=e.el.value;if(!e.el.value.trim()){try{ls.removeItem(e.k);}catch(x){}}}}}
setInterval(sweep,1000);
/* Sending is usually Enter or a click: check right after, so a reload a moment later can't bring it back. */
document.addEventListener("keydown",function(ev){if(ev.key==="Enter")setTimeout(sweep,150);},true);
document.addEventListener("click",function(){setTimeout(sweep,150);},true);
var restored=[],toast=null;
function notice(){
  if(toast&&toast.isConnected)return;
  toast=document.createElement("div");toast.setAttribute("role","status");toast.setAttribute("data-no-draft","");
  toast.style.cssText="position:fixed;left:50%;transform:translateX(-50%);bottom:16px;max-width:calc(100% - 32px);z-index:2147483000;display:flex;gap:12px;align-items:center;padding:9px 12px;border-radius:10px;font:13px/1.4 var(--font-sans,system-ui,sans-serif);background:var(--panel,#fff);color:var(--text,#17171c);border:1px solid var(--border,#e6e6e9);box-shadow:0 8px 24px -10px rgba(0,0,0,.35)";
  var s=document.createElement("span");s.textContent="Restored what you were typing before the page reloaded.";
  var b=document.createElement("button");b.type="button";b.textContent="Discard";
  b.style.cssText="font:inherit;font-weight:500;border:1px solid var(--border,#e6e6e9);background:transparent;color:inherit;border-radius:7px;padding:3px 9px;cursor:pointer";
  b.onclick=function(){restored.forEach(function(r){try{ls.removeItem(r.k);}catch(x){}if(r.el.isConnected&&r.el.value===r.v)setVal(r.el,"");});restored=[];hide();};
  toast.appendChild(s);toast.appendChild(b);
  /* Outside <body>: the page framework owns body and may drop nodes it did not render. */
  document.documentElement.appendChild(toast);
  setTimeout(hide,8000);}
function hide(){if(toast){toast.remove();toast=null;}}
function tryRestore(el){
  if(el.__dkSeen||skip(el))return;el.__dkSeen=1;
  if(el.value!=="")return;
  var k=keyOf(el),d=null;
  try{d=JSON.parse(ls.getItem(k)||"null");}catch(x){}
  if(!d||typeof d.v!=="string"||!d.v.trim())return;
  el.__dk=k;el.__dkRestoring=1;setVal(el,d.v);el.__dkRestoring=0;
  var e=track(el,k);e.last=el.value;
  restored.push({el:el,k:k,v:d.v});notice();
  /* The page may still be starting and reset the box; put it back once more. */
  setTimeout(function(){if(el.isConnected&&el.value===""&&ls.getItem(k)){el.__dkRestoring=1;setVal(el,d.v);el.__dkRestoring=0;e.last=el.value;}},900);}
function scan(){var all=document.querySelectorAll("input,textarea");for(var i=0;i<all.length;i++)tryRestore(all[i]);}
var pend=0;
function start(){scan();new MutationObserver(function(){clearTimeout(pend);pend=setTimeout(scan,400);}).observe(document.body,{childList:true,subtree:true});}
/* Wait for the page's own scripts to take over the fields first. */
if(document.readyState==="complete")setTimeout(start,700);else window.addEventListener("load",function(){setTimeout(start,700);});
}catch(e){}})();`;
