/**
 * v20: the Ambient Jarvis Hub page. One self-contained HTML/CSS/JS bundle (no CDN, no build step), dark, phone and
 * desktop. Talks to the hub API with the session cookie plus an `x-rufus-hub` header (so another site cannot post).
 * Kept free of `${` and backticks so it can live in a plain string.
 */

export const HUB_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d12">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>Rufus</title>
<style>
:root{--bg:#0b0d12;--panel:#141821;--panel2:#1b2030;--line:#262c3d;--text:#e8ebf2;--dim:#8d96ab;--accent:#6ea8ff;--good:#3ecf8e;--bad:#ff6b6b;--warn:#ffb84d;--radius:16px}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
button,input,textarea{font:inherit;color:inherit}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;background:rgba(11,13,18,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
header h1{font-size:17px;margin:0;font-weight:650;letter-spacing:.2px}
#dot{width:9px;height:9px;border-radius:50%;background:var(--dim)}
#dot.on{background:var(--good);box-shadow:0 0 8px var(--good)}
#clock{margin-left:auto;color:var(--dim);font-variant-numeric:tabular-nums}
main{display:grid;gap:14px;padding:14px 16px calc(16px + env(safe-area-inset-bottom));max-width:1200px;margin:0 auto}
@media(min-width:900px){main{grid-template-columns:380px 1fr;align-items:start;height:calc(100vh - 56px)}#side{position:sticky;top:70px}#chatbox{height:calc(100vh - 86px)}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:0 0 10px;font-weight:600}
#side{display:grid;gap:14px}
#call{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
#callBtn{width:132px;height:132px;border-radius:50%;border:0;cursor:pointer;background:radial-gradient(circle at 35% 30%,#8cbcff,#3a6fd8);color:#fff;font-size:17px;font-weight:650;box-shadow:0 10px 30px rgba(58,111,216,.35);transition:transform .15s}
#callBtn:active{transform:scale(.96)}
#callBtn.live{background:radial-gradient(circle at 35% 30%,#ff9a9a,#d83a3a);box-shadow:0 10px 30px rgba(216,58,58,.35)}
#callBtn.listening{animation:pulse 1.6s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,107,107,.45)}70%{box-shadow:0 0 0 22px rgba(255,107,107,0)}100%{box-shadow:0 0 0 0 rgba(255,107,107,0)}}
#phase{color:var(--dim);min-height:1.4em}
#meter{width:160px;height:4px;border-radius:2px;background:var(--panel2);overflow:hidden}
#meter i{display:block;height:100%;width:0;background:var(--good);transition:width .08s}
#sendNow{display:none;border:1px solid var(--line);background:var(--panel2);border-radius:999px;padding:7px 16px;cursor:pointer}
#warn{display:none;color:var(--warn);font-size:13px}
.blk{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
.blk:last-child{border-bottom:0}
.blk .t{color:var(--dim);min-width:92px;font-variant-numeric:tabular-nums}
.blk.cur{color:var(--accent)}
.blk.done{opacity:.45}
.item{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:10px;white-space:pre-wrap;word-break:break-word}
.item .row{display:flex;gap:8px;margin-top:10px}
.item button{flex:1;border:0;border-radius:10px;padding:9px;cursor:pointer;font-weight:600}
.ok{background:var(--good);color:#07150e}.ok.arm{background:var(--warn);color:#1b1200}
.no{background:transparent;border:1px solid var(--line)!important;color:var(--text)}
.urgent{border-color:var(--warn)}
.muted{color:var(--dim);font-size:14px}
#chatbox{display:flex;flex-direction:column;min-height:60vh;padding:0;overflow:hidden}
#chatbox h2{padding:14px 14px 0}
#log{flex:1;overflow-y:auto;padding:8px 14px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:82%;padding:8px 12px;border-radius:16px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--accent);color:#06142e;border-bottom-right-radius:5px}
.msg.assistant{align-self:flex-start;background:var(--panel2);border-bottom-left-radius:5px}
.msg.pro{border:1px dashed var(--line)}
.msg time{display:block;font-size:11px;opacity:.6;margin-top:2px}
form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}
form textarea{flex:1;resize:none;height:44px;max-height:140px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:10px 12px;outline:none}
form button{border:0;border-radius:12px;background:var(--accent);color:#06142e;font-weight:650;padding:0 16px;cursor:pointer}
#locked{display:none;padding:40px 20px;text-align:center}
</style>
</head>
<body>
<header><span id="dot"></span><h1>Rufus</h1><span id="clock"></span></header>
<div id="locked" class="card">This Hub needs its key. Open it once with <b>?token=&lt;your hub token&gt;</b> at the end of the address.</div>
<main id="app">
  <div id="side">
    <section id="call" class="card">
      <h2>Live call</h2>
      <button id="callBtn" type="button" aria-label="Call Rufus">Call Rufus</button>
      <div id="meter"><i></i></div>
      <div id="phase">Tap to start a hands-free call.</div>
      <button id="sendNow" type="button">Done talking</button>
      <div id="warn">Voice needs HTTPS (for example <b>tailscale serve</b>). Chat works here.</div>
    </section>
    <section class="card"><h2>Now</h2><div id="now" class="muted">Loading…</div></section>
    <section class="card"><h2>Verify</h2><div id="verify" class="muted">Loading…</div></section>
  </div>
  <section id="chatbox" class="card">
    <h2>Chat</h2>
    <div id="log"></div>
    <form id="form"><textarea id="input" placeholder="Message Rufus…" rows="1"></textarea><button>Send</button></form>
  </section>
</main>
<script>
(function(){
'use strict';
var H={'x-rufus-hub':'1'};
var $=function(id){return document.getElementById(id)};
var busy=false, lastChat='';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function t12(hhmm){var p=String(hhmm||'').split(':');var h=+p[0],m=p[1]||'00';if(isNaN(h))return hhmm;var ap=h<12?'am':'pm';h=h%12||12;return h+(m==='00'?'':':'+m)+ap}
function api(path,opts){opts=opts||{};var headers=Object.assign({},H,opts.headers||{});
  return fetch(path,Object.assign({credentials:'same-origin'},opts,{headers:headers})).then(function(r){
    if(r.status===401){$('locked').style.display='block';$('app').style.display='none';throw new Error('locked')}
    return r.json().then(function(j){if(!r.ok&&!j.error)j.error='HTTP '+r.status;j.status=r.status;return j})})}
function tick(){var d=new Date();$('clock').textContent=d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}
setInterval(tick,10000);tick();

function renderChat(turns){
  var key=JSON.stringify(turns.map(function(t){return t.at+t.text.length}));
  if(key===lastChat)return;lastChat=key;
  var log=$('log');var stick=log.scrollTop+log.clientHeight>=log.scrollHeight-40;
  log.innerHTML=turns.map(function(t){var d=new Date(t.at);return '<div class="msg '+(t.role==='user'?'user':'assistant')+(t.proactive?' pro':'')+'">'+esc(t.text)+'<time>'+(isNaN(d)?'':d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}))+'</time></div>'}).join('')||'<div class="muted">Say hi.</div>';
  if(stick)log.scrollTop=log.scrollHeight}
function addLocal(role,text){var log=$('log');var div=document.createElement('div');div.className='msg '+role;div.textContent=text;log.appendChild(div);log.scrollTop=log.scrollHeight;lastChat=''}
function renderNow(s){
  var html='';
  if(s.current)html+='<div style="margin-bottom:8px">Now: <b>'+esc(s.current.title)+'</b> until '+t12(s.current.end)+'</div>';
  else if(s.next)html+='<div style="margin-bottom:8px">Free now. Next: <b>'+esc(s.next.title)+'</b> at '+t12(s.next.start)+'</div>';
  html+=(s.schedule||[]).map(function(b){var cur=s.current&&s.current.start===b.start&&s.current.title===b.title;return '<div class="blk'+(cur?' cur':'')+(b.status==='done'||b.status==='skipped'?' done':'')+'"><span class="t">'+t12(b.start)+'–'+t12(b.end)+'</span><span>'+esc(b.title)+'</span></div>'}).join('');
  $('now').innerHTML=html||'Nothing scheduled today.';
  var v=s.pending||[];
  $('verify').innerHTML=v.length?v.map(function(it){var todo=it.stage==='execute';return '<div class="item'+(it.urgent?' urgent':'')+'" data-id="'+esc(it.id)+'">'+esc(it.text)+'<div class="row"><button class="ok" data-act="approve">'+(todo?'Done':'Approve')+'</button><button class="no" data-act="reject">'+(todo?'Drop':'Reject')+'</button></div></div>'}).join(''):'<span class="muted">Nothing waiting on you.</span>';
  renderChat(s.chat||[])}
function refresh(){return api('/api/state').then(function(s){$('dot').className=s.ok?'on':'';renderNow(s)}).catch(function(){$('dot').className=''})}
setInterval(function(){if(!document.hidden&&!busy)refresh()},5000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()});
refresh();

// Verify: two deliberate taps to approve. Nothing is ever approved by chat or by voice.
$('verify').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;var item=b.closest('.item');var id=item.getAttribute('data-id');var act=b.getAttribute('data-act');
  if(act==='approve'&&!b.classList.contains('arm')){b.classList.add('arm');b.dataset.label=b.textContent;b.textContent='Tap again to confirm';setTimeout(function(){b.classList.remove('arm');b.textContent=b.dataset.label},4000);return}
  b.disabled=true;
  api('/api/verify/'+encodeURIComponent(id)+'/'+act,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:true})}).then(function(j){if(j.message)addLocal('assistant',j.message);refresh()}).catch(function(){b.disabled=false})});

// Chat
var input=$('input');
input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('form').requestSubmit()}});
$('form').addEventListener('submit',function(e){e.preventDefault();var text=input.value.trim();if(!text)return;input.value='';addLocal('user',text);busy=true;
  api('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:text})}).then(function(j){if(j.error)addLocal('assistant','('+j.error+')')}).catch(function(){}).then(function(){busy=false;refresh()})});

// Live call: record, detect the end of speech, send, play the reply, listen again until hang-up.
if(!window.isSecureContext||!navigator.mediaDevices||!window.MediaRecorder){$('warn').style.display='block'}
var call=null;
function phase(t,cls){$('phase').textContent=t;$('callBtn').classList.toggle('listening',cls==='listening')}
function pickMime(){var c=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];for(var i=0;i<c.length;i++){if(MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(c[i]))return c[i]}return ''}
function rms(){var a=call.buf;call.analyser.getFloatTimeDomainData(a);var s=0;for(var i=0;i<a.length;i++)s+=a[i]*a[i];return Math.sqrt(s/a.length)}
function startCall(){
  if(!navigator.mediaDevices||!window.MediaRecorder){phase('This browser cannot record here (needs HTTPS).');return}
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}}).then(function(stream){
    var AC=window.AudioContext||window.webkitAudioContext;var ctx=new AC();var src=ctx.createMediaStreamSource(stream);var an=ctx.createAnalyser();an.fftSize=1024;src.connect(an);
    call={stream:stream,ctx:ctx,analyser:an,buf:new Float32Array(an.fftSize),floor:0.01};
    if(ctx.resume)ctx.resume();
    $('callBtn').classList.add('live');$('callBtn').textContent='Hang up';$('sendNow').style.display='inline-block';
    try{speechSynthesis&&speechSynthesis.speak(new SpeechSynthesisUtterance(''))}catch(e){}
    listen()}).catch(function(err){phase('Microphone blocked: '+err.message)})}
function hangup(){if(!call)return;var c=call;call=null;clearInterval(c.timer);try{c.rec&&c.rec.state!=='inactive'&&c.rec.stop()}catch(e){}c.stream.getTracks().forEach(function(t){t.stop()});try{c.ctx.close()}catch(e){}if(c.audio){c.audio.pause()}try{speechSynthesis.cancel()}catch(e){}
  $('callBtn').classList.remove('live','listening');$('callBtn').textContent='Call Rufus';$('sendNow').style.display='none';$('meter').firstChild.style.width='0';phase('Call ended.')}
function listen(){
  if(!call)return;var mime=pickMime();var rec;try{rec=new MediaRecorder(call.stream,mime?{mimeType:mime}:undefined)}catch(e){rec=new MediaRecorder(call.stream)}
  var chunks=[];var heard=false;var quietSince=0;var started=Date.now();call.rec=rec;call.heard=false;
  rec.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data)};
  rec.onstop=function(){clearInterval(call&&call.timer);if(!call)return;if(call.heard&&chunks.length)send(new Blob(chunks,{type:rec.mimeType||mime||'audio/webm'}));else listen()};
  rec.start(250);phase('Listening…','listening');
  call.timer=setInterval(function(){if(!call)return;var v=rms();var now=Date.now();
    if(now-started<400){call.floor=Math.max(0.004,call.floor*0.7+v*0.3);return}
    var th=Math.max(0.012,call.floor*2.5);$('meter').firstChild.style.width=Math.min(100,v/th*40)+'%';
    if(v>th){heard=true;call.heard=true;quietSince=0}else if(heard){quietSince=quietSince||now;if(now-quietSince>1300)stop()}
    else{call.floor=call.floor*0.95+v*0.05}
    if(!heard&&now-started>20000)stop();if(now-started>60000)stop()},100);
  function stop(){clearInterval(call.timer);if(rec.state!=='inactive')rec.stop()}}
$('sendNow').addEventListener('click',function(){if(call&&call.rec&&call.rec.state!=='inactive'){call.heard=true;clearInterval(call.timer);call.rec.stop()}});
function send(blob){
  phase('Thinking…');$('meter').firstChild.style.width='0';busy=true;
  fetch('/api/voice',{method:'POST',credentials:'same-origin',headers:Object.assign({'content-type':blob.type||'audio/webm'},H),body:blob}).then(function(r){return r.json().then(function(j){j.status=r.status;return j})}).then(function(j){
    busy=false;if(!call)return;
    if(!j.ok){if(j.error)phase(j.error);return setTimeout(listen,j.status===422?0:1200)}
    addLocal('user',j.transcript);if(j.reply)addLocal('assistant',j.reply);
    speak(j,function(){if(call)listen()})}).catch(function(e){busy=false;phase('Connection problem, retrying…');setTimeout(listen,1500)})}
function speak(j,next){
  if(!j.reply)return next();phase('Speaking…');var done=false;function fin(){if(done)return;done=true;next()}
  function browserVoice(){try{if(!window.speechSynthesis)return fin();var u=new SpeechSynthesisUtterance(j.reply);u.onend=fin;u.onerror=fin;speechSynthesis.cancel();speechSynthesis.speak(u)}catch(e){fin()}}
  if(j.audioBase64){var a=new Audio('data:'+(j.mimeType||'audio/ogg')+';base64,'+j.audioBase64);call.audio=a;a.onended=fin;a.onerror=browserVoice;var p=a.play();if(p&&p.catch)p.catch(browserVoice)}else browserVoice()}
$('callBtn').addEventListener('click',function(){call?hangup():startCall()});

if('serviceWorker' in navigator&&window.isSecureContext){navigator.serviceWorker.register('/sw.js').catch(function(){})}
})();
</script>
</body>
</html>`;

export const HUB_MANIFEST = JSON.stringify({
  name: 'Rufus',
  short_name: 'Rufus',
  description: 'Your chief of staff: chat, live voice call, Now and Verify.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b0d12',
  theme_color: '#0b0d12',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
});

export const HUB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0b0d12"/><circle cx="256" cy="256" r="150" fill="none" stroke="#6ea8ff" stroke-width="28"/><circle cx="256" cy="256" r="62" fill="#6ea8ff"/></svg>`;

/** Offline shell: the page itself is cached (network first); the API is never cached. */
export const HUB_SW = String.raw`var CACHE='rufus-hub-v20';
self.addEventListener('install',function(e){self.skipWaiting();e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(['/','/manifest.webmanifest','/icon.svg'])}).catch(function(){}))});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener('fetch',function(e){var u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.indexOf('/api/')===0||u.pathname==='/signal')return;
  e.respondWith(fetch(e.request).then(function(r){if(r.ok){var copy=r.clone();caches.open(CACHE).then(function(c){c.put(u.pathname==='/'?'/':e.request,copy)})}return r}).catch(function(){return caches.match(u.pathname==='/'?'/':e.request)}))});
`;
