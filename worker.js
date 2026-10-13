// hfpc-feedback — 全艦隊共用「👍 按讚 + 留言(先待審才顯示)」Worker。like-comment-kit skill 的活實作(2026-10-12)。
//
// 原則(使用者 1012 拍板):
//   ① 按讚零個資:只記 g → 次數;每台裝置每個作品一次(前端 localStorage),伺服器端同 IP 雜湊 10 分鐘去重(不存 IP)。
//   ② 留言一律先進「待審」,後台放行(approve)才會出現在網站上;沒放行的誰也看不到。
//   ③ 兒童站 mode=kids 只能選預設短語,不開自由輸入、不收暱稱。自由輸入 mode=free 要過 Turnstile,
//      而且擋得到的個資(電話、Email、LINE id、網址)伺服器端一律退回。
//   ④ 後台 /admin 沒設 ADMIN_KEY 一律拒(fail closed),照 play-stats 的 /ips 作法。
//
// 端點:
//   GET  /widget.js                      — 可嵌入前端。一行:<script src=".../widget.js" data-g="<id>" data-mode="free|kids" data-title="<名>" defer></script>
//   GET  /api/feedback?g=<id>            — {likes, liked:false, comments:[{id,name,text,preset,at}]}(只回已放行)
//   GET  /api/feedback?all=1             — {likes:{g:n}}(首頁卡片用)
//   POST /api/like?g=<id>                — 按讚 +1(body 可帶 {title})
//   POST /api/comment                    — {g,title,name,text,preset,cf,hp} → 預設短語直接 approved(1013 使用者拍板:不能打字就不用審);自己打的字存 pending
//   GET  /admin?key=<ADMIN_KEY>          — 待審清單 + 放行/刪除 + 各作品讚數排行
//   POST /admin/act?key=&id=&a=approve|reject|delete
//
// 部署:npx wrangler deploy · 建表:npx wrangler d1 execute hfpc-feedback --remote --file schema.sql

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
}
const JSONH = { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
const ADMIN_HEAD = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Type': 'text/html; charset=utf-8' }
const G_RE = /^[a-z0-9][a-z0-9-]{0,59}$/
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|pingdom|uptime|monitor|scan|preview|fetch|python|curl|wget|axios|libwww|okhttp|go-http|java\//i

// 兒童站可選的短語(widget 也用這份;改這裡就全艦隊一起改)
const PRESETS = ['👍 好聽', '🙏 感動', '🕊️ 平安', '😊 太好玩了', '💪 想再玩一次', '❤️ 我喜歡']
const PRESET_SET = new Set(PRESETS)

// 個資守門:電話(8 碼以上連續數字,允許 - 或空白)、Email、LINE id、網址
const PII_RE = /(\d[\d\-\s]{7,}\d)|([\w.+-]+@[\w-]+\.[\w.]+)|(line\s*id|賴|ig|fb)\s*[:：]?\s*[a-z0-9_.]{3,}|(https?:\/\/|www\.)/i

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const p = url.pathname
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    try {
      if (p === '/widget.js') return widgetJs(env)
      if (p === '/api/feedback') return getFeedback(url, env)
      if (p === '/api/like' && request.method === 'POST') return postLike(request, url, env)
      if (p === '/api/comment' && request.method === 'POST') return postComment(request, env)
      if (p === '/admin') return admin(request, url, env)
      if (p === '/admin/act' && request.method === 'POST') return adminAct(request, url, env)
      if (p === '/') return new Response('hfpc-feedback ok — /widget.js · /api/feedback?g=<id> · /admin', { headers: CORS })
      return new Response('not found', { status: 404, headers: CORS })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 500, headers: JSONH })
    }
  },
}

// ── 小工具 ──
async function ipHash(request) {
  const ip = request.headers.get('CF-Connecting-IP') || ''
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hfpc-feedback|' + ip))
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}
// 回 true = 可以過;false = 太頻繁。key 只有雜湊,過期就清。
async function rateOk(env, key, seconds) {
  const now = Math.floor(Date.now() / 1000)
  const row = await env.DB.prepare('SELECT exp FROM rate WHERE k=?').bind(key).first()
  if (row && row.exp > now) return false
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO rate(k,exp) VALUES(?,?)').bind(key, now + seconds),
    env.DB.prepare('DELETE FROM rate WHERE exp < ?').bind(now - 3600),
  ])
  return true
}
const clean = (s, max) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const TPE = (iso) => iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—'
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: JSONH })

async function readBody(request) {
  try { return await request.json() } catch { return {} }
}

// ── 讀 ──
async function getFeedback(url, env) {
  if (url.searchParams.get('all') === '1') {
    const rows = (await env.DB.prepare('SELECT g, n FROM likes WHERE n > 0').all()).results || []
    const likes = {}
    for (const r of rows) likes[r.g] = r.n
    return new Response(JSON.stringify({ likes }), { headers: { ...JSONH, 'Cache-Control': 'public, max-age=120' } })
  }
  const g = url.searchParams.get('g') || ''
  if (!G_RE.test(g)) return json({ ok: false, error: 'bad id' }, 400)
  const like = await env.DB.prepare('SELECT n FROM likes WHERE g=?').bind(g).first()
  const rows = (await env.DB.prepare("SELECT id, name, text, preset, created_at FROM comments WHERE g=? AND status='approved' AND preset=0 ORDER BY id DESC LIMIT 50").bind(g).all()).results || []
  // 短語只給計數(「😊 太好玩了 × 12」),不逐筆列,免得同一句洗版
  const pr = (await env.DB.prepare("SELECT text, COUNT(*) AS n FROM comments WHERE g=? AND status='approved' AND preset=1 GROUP BY text").bind(g).all()).results || []
  const presets = {}
  for (const r of pr) presets[r.text] = r.n
  return json({
    ok: true, likes: (like && like.n) || 0, presets,
    comments: rows.map((r) => ({ id: r.id, name: r.name || '', text: r.text, preset: !!r.preset, at: r.created_at })),
  })
}

// ── 按讚 ──
async function postLike(request, url, env) {
  const g = url.searchParams.get('g') || ''
  if (!G_RE.test(g)) return json({ ok: false, error: 'bad id' }, 400)
  const ua = request.headers.get('User-Agent') || ''
  if (!ua || BOT_RE.test(ua)) return json({ ok: true, skipped: 'bot' })
  const h = await ipHash(request)
  if (!(await rateOk(env, `like:${g}:${h}`, 600))) {
    const like = await env.DB.prepare('SELECT n FROM likes WHERE g=?').bind(g).first()
    return json({ ok: true, likes: (like && like.n) || 0, dup: true })
  }
  const body = await readBody(request)
  const title = clean(body.title, 80) || null
  await env.DB.prepare('INSERT INTO likes(g, n, title) VALUES(?, 1, ?) ON CONFLICT(g) DO UPDATE SET n = n + 1, title = COALESCE(excluded.title, likes.title)').bind(g, title).run()
  const like = await env.DB.prepare('SELECT n FROM likes WHERE g=?').bind(g).first()
  return json({ ok: true, likes: like.n })
}

// ── 留言(短語直接上;自己打的字存 pending)──
async function postComment(request, env) {
  const ua = request.headers.get('User-Agent') || ''
  if (!ua || BOT_RE.test(ua)) return json({ ok: true, pending: true })   // 爬蟲:假裝收下,實際不存
  const body = await readBody(request)
  const g = String(body.g || '')
  if (!G_RE.test(g)) return json({ ok: false, error: 'bad id' }, 400)
  if (body.hp) return json({ ok: true, pending: true })                   // honeypot 有填 = 機器人
  // 1013 使用者拍板:短語可以一次多選(body.presets 陣列,最多 6 句、重複的只算一次),跟自己打的字可以一起送
  const picks = []
  for (const x of (Array.isArray(body.presets) ? body.presets : [])) { const t = String(x || '').trim(); if (PRESET_SET.has(t) && !picks.includes(t)) picks.push(t) }
  let raw = String(body.text || '').trim()
  if (PRESET_SET.has(raw)) { if (!picks.includes(raw)) picks.push(raw); raw = '' }   // 舊版 widget:短語放在 text
  const text = clean(raw, 300)
  if (!picks.length && !text) return json({ ok: false, error: '留言是空的' }, 400)
  const preset = !text
  const mode = body.mode === 'kids' ? 'kids' : 'free'
  // 1013 使用者拍板:兒童站也要能自己打字(兩種留言方式都要有)——自己打的字照樣過個資擋 + Turnstile + 待審;兒童站不收暱稱
  let name = ''
  if (!preset) {
    if (PII_RE.test(text)) return json({ ok: false, error: '留言請不要放電話、Email、網址或帳號等個人資料喔' }, 400)
    name = mode === 'kids' ? '' : clean(body.name, 20)
    if (name && PII_RE.test(name)) return json({ ok: false, error: '暱稱請不要放電話或帳號' }, 400)
    // 自由輸入:Turnstile(有設祕密才驗;沒設就只靠待審 + 頻率)
    if (env.TURNSTILE_SECRET) {
      const token = String(body.cf || '')
      if (!token) return json({ ok: false, error: '請等「我不是機器人」驗證完成再送出' }, 403)
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get('CF-Connecting-IP') || '' }),
      })
      const v = await r.json().catch(() => ({}))
      if (!v.success) return json({ ok: false, error: '驗證沒有通過,請重新整理再試一次' }, 403)
    }
  }
  const h = await ipHash(request)
  if (!(await rateOk(env, `cm:${h}`, preset ? 10 : 30))) return json({ ok: false, error: '太快了,請稍等一下再留言' }, 429)
  const title = clean(body.title, 80) || null
  // 短語是固定清單裡的字、沒有暱稱,不可能夾帶個資或髒話 ⇒ 不用審,直接顯示(1013 使用者拍板);自己打的字存 pending
  const ins = 'INSERT INTO comments(g, title, name, text, preset, status) VALUES(?,?,?,?,?,?)'
  const stmts = picks.map((t) => env.DB.prepare(ins).bind(g, title, null, t, 1, 'approved'))
  if (text) stmts.push(env.DB.prepare(ins).bind(g, title, name || null, text, 0, 'pending'))
  await env.DB.batch(stmts)
  return json({ ok: true, pending: !!text, presets: picks.length })
}

// ── 後台 ──
function authAdmin(url, env) {
  const k = env && env.ADMIN_KEY
  if (!k) return 'nokey'
  return (url.searchParams.get('key') || '') === k ? 'ok' : 'bad'
}
const ADMIN_CSS = `body{font-family:system-ui,"Microsoft JhengHei",sans-serif;background:#faf9f7;color:#222;margin:0;padding:16px;font-size:17px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.15rem;margin:28px 0 8px}.sub{color:#666;margin:0 0 16px;font-size:.95rem}
.c{background:#fff;border:1px solid #e5e0d8;border-radius:12px;padding:12px 14px;margin:0 0 10px}
.c .m{color:#666;font-size:.9rem;margin:0 0 6px}.c .t{font-size:1.15rem;margin:0 0 8px;white-space:pre-wrap;word-break:break-word}
.c form{display:inline}button{font-size:1rem;padding:8px 16px;border-radius:8px;border:1px solid #cbb;background:#fff;cursor:pointer;margin-right:8px;min-height:44px}
button.ok{background:#2a7a3b;color:#fff;border-color:#2a7a3b}button.no{color:#b3261e}
table{border-collapse:collapse;width:100%;max-width:640px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}td:last-child,th:last-child{text-align:right}
.empty{color:#888}.badge{display:inline-block;background:#eef;border-radius:6px;padding:0 6px;font-size:.85rem}`

async function admin(request, url, env) {
  const a = authAdmin(url, env)
  if (a === 'nokey') return new Response('未設定 ADMIN_KEY——先跑「npx wrangler secret put ADMIN_KEY」設一組密碼,再用 /admin?key=<密碼> 進後台。', { status: 503, headers: ADMIN_HEAD })
  if (a === 'bad') {
    const tried = (url.searchParams.get('key') || '') !== ''
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>留言審核(需密碼)</title>
<style>${ADMIN_CSS}body{display:grid;place-items:center;min-height:90vh}form.login{background:#fff;border:1px solid #e5e0d8;border-radius:12px;padding:24px;max-width:340px}input{font-size:1.2rem;padding:10px;width:100%;box-sizing:border-box;margin:10px 0}.err{color:#b3261e;font-weight:600}</style>
<form class="login" method="GET" action="/admin"><h2 style="margin:0 0 6px">💬 留言審核</h2><p class="sub">內部管理用,需要密碼。</p>${tried ? '<p class="err">密碼錯誤,再試一次。</p>' : ''}
<input type="password" name="key" placeholder="請輸入密碼" autofocus autocomplete="current-password"><button type="submit" class="ok" style="width:100%">進入</button></form>`,
      { status: tried ? 401 : 200, headers: ADMIN_HEAD })
  }
  const key = esc(url.searchParams.get('key'))
  const pending = (await env.DB.prepare("SELECT * FROM comments WHERE status='pending' ORDER BY id ASC LIMIT 200").all()).results || []
  const recent = (await env.DB.prepare("SELECT * FROM comments WHERE status='approved' AND preset=0 ORDER BY id DESC LIMIT 50").all()).results || []
  const likes = (await env.DB.prepare('SELECT g, n, title FROM likes ORDER BY n DESC LIMIT 100').all()).results || []
  const msg = url.searchParams.get('msg') || ''
  const card = (r, acts) => `<div class="c"><p class="m">${esc(r.title || r.g)} <span class="badge">${esc(r.g)}</span> · ${TPE(r.created_at)}${r.name ? ' · ' + esc(r.name) : ''}${r.preset ? ' · 短語' : ''}</p><p class="t">${esc(r.text)}</p>${acts}</div>`
  const act = (id, a, label, cls) => `<form method="POST" action="/admin/act?key=${key}&id=${id}&a=${a}"><button class="${cls}">${label}</button></form>`
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>留言審核</title><style>${ADMIN_CSS}</style>
<h1>💬 留言審核</h1><p class="sub">放行後才會出現在網站上。${msg ? '<b>' + esc(msg) + '</b>' : ''}</p>
<h2>待審(${pending.length})</h2>
${pending.length ? pending.map((r) => card(r, act(r.id, 'approve', '✅ 放行', 'ok') + act(r.id, 'reject', '🗑 不放行', 'no'))).join('') : '<p class="empty">目前沒有待審留言。</p>'}
<h2>最近放行的(${recent.length})</h2>
${recent.length ? recent.map((r) => card(r, act(r.id, 'delete', '🗑 撤下', 'no'))).join('') : '<p class="empty">還沒有放行的留言。</p>'}
<h2>👍 讚數排行</h2>
${likes.length ? '<table><tr><th>作品</th><th>讚</th></tr>' + likes.map((r) => `<tr><td>${esc(r.title || r.g)} <span class="badge">${esc(r.g)}</span></td><td>${r.n}</td></tr>`).join('') + '</table>' : '<p class="empty">還沒有人按讚。</p>'}`
  return new Response(html, { headers: ADMIN_HEAD })
}

async function adminAct(request, url, env) {
  if (authAdmin(url, env) !== 'ok') return new Response('forbidden', { status: 403, headers: ADMIN_HEAD })
  const id = Number(url.searchParams.get('id'))
  const a = url.searchParams.get('a')
  let msg = ''
  if (!Number.isInteger(id) || id <= 0) msg = 'id 不對'
  else if (a === 'approve') { await env.DB.prepare("UPDATE comments SET status='approved' WHERE id=?").bind(id).run(); msg = `#${id} 已放行` }
  else if (a === 'reject') { await env.DB.prepare("UPDATE comments SET status='rejected' WHERE id=?").bind(id).run(); msg = `#${id} 不放行` }
  else if (a === 'delete') { await env.DB.prepare('DELETE FROM comments WHERE id=?').bind(id).run(); msg = `#${id} 已撤下` }
  else msg = '動作不對'
  return Response.redirect(`${url.origin}/admin?key=${encodeURIComponent(url.searchParams.get('key'))}&msg=${encodeURIComponent(msg)}`, 303)
}

// ── 可嵌入的前端 ──
// 一行接入:<script src="https://hfpc-feedback.summer09201017.workers.dev/widget.js" data-g="<id>" data-mode="free|kids" data-title="<作品名>" defer></script>
// 會把 UI 放進 data-root 指定的容器(CSS 選擇器),沒給就放 #hfpc-feedback,都沒有就放在 script 標籤後面。
// data-collapsed:收合成一顆「💬 按讚・留言 · 👍 N」(首頁用);同一頁可放多份,按讚會互相同步。
//離線/被擋/Worker 掛了都靜默,不影響作品本身。
function widgetJs(env) {
  const src = `(function(){
var s=document.currentScript;if(!s)return;
var g=s.getAttribute('data-g')||'',mode=s.getAttribute('data-mode')==='kids'?'kids':'free',title=s.getAttribute('data-title')||document.title||'';
var LIKE=s.getAttribute('data-like')||(mode==='kids'?'👍 好玩就按個讚':'👍 好聽就按個讚');
if(!/^[a-z0-9][a-z0-9-]{0,59}$/.test(g))return;
var API=${JSON.stringify('https://hfpc-feedback.summer09201017.workers.dev')},SITEKEY=${JSON.stringify(env.TURNSTILE_SITEKEY || '')},PRESETS=${JSON.stringify(PRESETS)};
var root=null,rs=s.getAttribute('data-root');try{root=rs?document.querySelector(rs):document.getElementById('hfpc-feedback');}catch(e){}
if(root&&root.getAttribute('data-hf-on'))root=null;if(!root){root=document.createElement('div');if(!document.getElementById('hfpc-feedback'))root.id='hfpc-feedback';s.parentNode.insertBefore(root,s.nextSibling);}
root.setAttribute('data-hf-on','1');root.classList.add('hfpc-fb');var fold=s.hasAttribute('data-collapsed');
var LK='hfpc-like:'+g,liked=false;try{liked=localStorage.getItem(LK)==='1';}catch(e){}
var css='#hfpc-feedback{font:inherit;line-height:1.5;margin:16px 0}#hfpc-feedback *{box-sizing:border-box}'+
'#hfpc-feedback .hf-like{font:inherit;font-size:1.15em;min-height:48px;padding:8px 20px;border-radius:999px;border:2px solid #d9534f;background:#fff;color:#d9534f;cursor:pointer}'+
'#hfpc-feedback .hf-like.on{background:#d9534f;color:#fff}#hfpc-feedback .hf-like:disabled{opacity:.7;cursor:default}'+
'#hfpc-feedback .hf-chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}#hfpc-feedback .hf-chips button{font:inherit;color:#333;min-height:44px;padding:6px 14px;border-radius:999px;border:1px solid #bbb;background:#fff;cursor:pointer}'+
'#hfpc-feedback .hf-chips button.on{background:#2a7a3b;border-color:#2a7a3b;color:#fff}'+
'#hfpc-feedback textarea,#hfpc-feedback input{font:inherit;color:#333;background:#fff;width:100%;padding:10px;border:1px solid #bbb;border-radius:8px;margin:6px 0}#hfpc-feedback textarea{min-height:88px}'+
'#hfpc-feedback .hf-send{font:inherit;min-height:44px;padding:8px 20px;border-radius:8px;border:0;background:#2a7a3b;color:#fff;cursor:pointer}#hfpc-feedback .hf-send:disabled{opacity:.6}'+
'#hfpc-feedback .hf-msg{margin:8px 0;min-height:1.5em}#hfpc-feedback .hf-msg.err{color:#b3261e}#hfpc-feedback .hf-msg.ok{color:#2a7a3b}'+
'#hfpc-feedback .hf-tally{display:flex;flex-wrap:wrap;gap:6px 14px;margin:10px 0 0;font-weight:600}#hfpc-feedback .hf-tally:empty{display:none}'+
'#hfpc-feedback .hf-list{list-style:none;padding:0;margin:12px 0 0}#hfpc-feedback .hf-list li{border-top:1px solid #e5e0d8;padding:8px 0}#hfpc-feedback .hf-list .hf-who{opacity:.65;font-size:.9em}'+
'#hfpc-feedback .hf-hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}#hfpc-feedback .hf-small{opacity:.7;font-size:.9em;margin:4px 0}'+
'#hfpc-feedback .hf-fold>summary{cursor:pointer;display:inline-block;min-height:44px;padding:8px 18px;border-radius:999px;border:2px solid #d9534f;background:#fff;color:#d9534f;font-weight:600;list-style:none}#hfpc-feedback .hf-fold>summary::-webkit-details-marker{display:none}#hfpc-feedback .hf-fold[open]>summary{margin-bottom:8px}';
css=css.replace(/#hfpc-feedback/g,'.hfpc-fb');if(!document.getElementById('hfpc-fb-css')){var st=document.createElement('style');st.id='hfpc-fb-css';st.textContent=css;document.head.appendChild(st);}
function el(t,a,c){var e=document.createElement(t);for(var k in (a||{})){if(k==='text')e.textContent=a[k];else if(k==='html')e.innerHTML=a[k];else e.setAttribute(k,a[k]);}(c||[]).forEach(function(x){e.appendChild(x)});return e;}
var likeBtn=el('button',{type:'button','class':'hf-like'+(liked?' on':''),text:(liked?'👍 已按讚':LIKE)+' · 0'});
var likeRow=el('p',{},[likeBtn]);
var msg=el('p',{'class':'hf-msg',role:'status'});
var list=el('ul',{'class':'hf-list'}),tally=el('div',{'class':'hf-tally'});
var chips=el('div',{'class':'hf-chips'});var picked=[];
PRESETS.forEach(function(p){var b=el('button',{type:'button',text:p,'aria-pressed':'false'});b.onclick=function(){var i=picked.indexOf(p);if(i<0)picked.push(p);else picked.splice(i,1);var on=picked.indexOf(p)>=0;b.className=on?'on':'';b.setAttribute('aria-pressed',on?'true':'false');};chips.appendChild(b);});
var ta=null,nameIn=null,hp=el('input',{'class':'hf-hp',tabindex:'-1',autocomplete:'off','aria-hidden':'true'}),cfDiv=null,cfId=null;
var send=el('button',{type:'button','class':'hf-send',text:'送出留言'});
var form=el('div',{},[el('p',{'class':'hf-small',text:mode==='kids'?'短語可以一次點好幾句,送出馬上就會出現在下面;自己打的字要等老師看過才會出現(不要寫電話、地址、姓名喔)。':'上面的短語可以一次點好幾句,送出會直接出現;自己打的字會先經過審核才顯示,請不要留電話、Email 等個人資料。'}),chips]);
{ta=el('textarea',{maxlength:'300',placeholder:mode==='kids'?'也可以自己打字(最多 300 字)':'想說的話(最多 300 字)'});form.appendChild(ta);if(mode==='free'){nameIn=el('input',{maxlength:'20',placeholder:'暱稱(可不填)'});form.appendChild(nameIn);}
 if(SITEKEY){cfDiv=el('div',{'class':'hf-cf'});form.appendChild(cfDiv);}}
form.appendChild(hp);form.appendChild(send);form.appendChild(msg);
var body=el('div',{},[likeRow,form,tally,list]),sum=null;
if(fold){sum=el('summary',{text:'💬 按讚・留言'});root.appendChild(el('details',{'class':'hf-fold'},[sum,body]));}else root.appendChild(body);
function setLikes(n){var t=Number(n||0).toLocaleString('zh-TW');if(n==='?')t='?';likeBtn.textContent=(liked?'👍 已按讚':LIKE)+' · '+t;if(sum)sum.textContent='💬 按讚・留言 · 👍 '+t;}
// 同一頁有兩份(首頁收合版 + 結算版)時,一份按了另一份跟著變
window.addEventListener('hfpc-fb-like',function(e){var d=e.detail||{};if(d.g!==g)return;liked=true;likeBtn.className='hf-like on';likeBtn.disabled=true;if(d.likes!=null)setLikes(d.likes);});
function render(d){setLikes(d.likes);tally.innerHTML='';var P=d.presets||{};PRESETS.forEach(function(p){if(P[p])tally.appendChild(el('span',{text:p+' × '+Number(P[p]).toLocaleString('zh-TW')}));});list.innerHTML='';(d.comments||[]).forEach(function(c){var li=el('li',{},[el('span',{text:c.text}),el('span',{'class':'hf-who',text:'  — '+(c.name||'匿名')+(c.at?' · '+c.at.slice(0,10):'')})]);list.appendChild(li);});}
function load(){fetch(API+'/api/feedback?g='+encodeURIComponent(g)).then(function(r){return r.ok?r.json():null}).then(function(d){if(d)render(d)}).catch(function(){});}
load();
likeBtn.onclick=function(){if(liked)return;liked=true;try{localStorage.setItem(LK,'1')}catch(e){}likeBtn.className='hf-like on';likeBtn.disabled=true;
 fetch(API+'/api/like?g='+encodeURIComponent(g),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title})}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d){setLikes(d.likes);try{window.dispatchEvent(new CustomEvent('hfpc-fb-like',{detail:{g:g,likes:d.likes}}))}catch(e){}}}).catch(function(){setLikes('?')});};
function ensureCf(){if(!cfDiv||cfId!==null)return;cfId=false;function go(){try{cfId=window.turnstile.render(cfDiv,{sitekey:SITEKEY,language:'zh-tw'});}catch(e){cfId=false}}
 if(window.turnstile)go();else{var sc=document.createElement('script');sc.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';sc.async=true;sc.onload=go;document.head.appendChild(sc);}}
if(ta){ta.addEventListener('focus',ensureCf);}chips.addEventListener('click',ensureCf);
send.onclick=function(){var text=(ta?ta.value:'').trim();if(!text&&!picked.length){msg.className='hf-msg err';msg.textContent=mode==='kids'?'先點一句短語,或自己打幾個字喔':'先點一句短語,或寫點什麼吧';return;}
 var body={g:g,title:title,mode:mode,presets:picked.slice(),text:text,name:nameIn?nameIn.value:'',hp:hp.value};
 if(cfDiv&&window.turnstile&&cfId!==null&&cfId!==false){try{body.cf=window.turnstile.getResponse(cfId)||'';}catch(e){}}
 send.disabled=true;msg.className='hf-msg';msg.textContent='送出中…';
 fetch(API+'/api/comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
  send.disabled=false;if(d&&d.ok){msg.className='hf-msg ok';msg.textContent=d.pending?(d.presets?'收到了,謝謝!短語已經放上去;自己打的字審核通過後才會出現。':'收到了,謝謝!審核通過後就會出現在這裡。'):'收到了,謝謝!';if(d.presets)load();if(ta)ta.value='';picked=[];[].forEach.call(chips.children,function(x){x.className='';x.setAttribute('aria-pressed','false')});if(cfDiv&&window.turnstile&&cfId){try{window.turnstile.reset(cfId)}catch(e){}}}
  else{msg.className='hf-msg err';msg.textContent=(d&&d.error)||'送出失敗,請再試一次';}}).catch(function(){send.disabled=false;msg.className='hf-msg err';msg.textContent='網路不通,請稍後再試';});};
})();`
  return new Response(src, { headers: { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=600' } })
}
