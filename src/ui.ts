export const APP_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>مدیریت کانال‌ها</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitcount+Ink&family=Vazirmatn:wght@300;400;500;700;800&display=swap" rel="stylesheet">
<style>
  :root{--ink:#1c2029;--soft:#6f7683;--up:#159d78;--down:#d9455b;--warn:#a47522;--line:rgba(70,80,100,.28);--accent:#3a6fb8}
  *{margin:0;padding:0;box-sizing:border-box}
  html{min-height:100%}
  body{min-height:100vh;font-family:Vazirmatn,Tahoma,"Segoe UI",sans-serif;color:var(--ink);line-height:1.8;padding:28px 16px 48px;position:relative;overflow-x:hidden;
    background:radial-gradient(ellipse 45% 60% at 0% 55%,#a9b0cb 0%,transparent 70%),radial-gradient(ellipse 40% 50% at 100% 15%,#b4cdca 0%,transparent 70%),radial-gradient(ellipse 35% 45% at 100% 100%,#d7dfc2 0%,transparent 70%),radial-gradient(ellipse 50% 50% at 50% 45%,#e8eaf1 0%,transparent 80%),#cfd5e0;background-attachment:fixed}
  .bubble{position:fixed;z-index:0;pointer-events:none;border-radius:46% 54% 50% 50%/52% 46% 54% 48%;
    background:radial-gradient(circle at 30% 24%,rgba(255,255,255,.95) 0,rgba(255,255,255,.35) 14%,rgba(255,255,255,0) 40%),radial-gradient(circle at 50% 50%,rgba(255,255,255,.08) 0,rgba(190,202,225,.42) 100%);
    border:1px solid rgba(255,255,255,.75);box-shadow:inset 8px 8px 18px rgba(255,255,255,.9),inset -11px -14px 24px rgba(105,120,155,.38),0 20px 30px rgba(70,80,110,.2)}
  .bubble.gold{opacity:.9;background:radial-gradient(circle at 30% 24%,rgba(255,251,230,.97) 0,rgba(255,232,150,.5) 16%,rgba(255,205,70,0) 43%),radial-gradient(circle at 50% 50%,rgba(255,214,80,.14) 0,rgba(238,176,30,.46) 100%);border-color:rgba(255,242,190,.9);box-shadow:inset 8px 8px 18px rgba(255,251,225,.92),inset -11px -14px 24px rgba(200,140,10,.28),0 16px 26px rgba(190,140,30,.2)}
  .b1{left:3%;top:90px;width:74px;height:70px}.b2{right:2%;bottom:8%;width:100px;height:98px}.b3{left:6%;bottom:4%;width:36px;height:34px}
  .wrap{position:relative;z-index:1;max-width:1040px;margin:0 auto}
  .glass{border-radius:30px;padding:20px;margin-bottom:18px;background:radial-gradient(ellipse at 30% 0%,rgba(255,255,255,.85) 0%,rgba(255,255,255,0) 60%),linear-gradient(145deg,rgba(255,255,255,.62),rgba(255,255,255,.34));border:1px solid rgba(255,255,255,.85);backdrop-filter:blur(30px) saturate(1.2);-webkit-backdrop-filter:blur(30px) saturate(1.2);box-shadow:0 30px 60px rgba(70,82,110,.16),inset 2px 2px 3px rgba(255,255,255,.95),inset -2px -2px 6px rgba(170,182,205,.28)}
  .tile,.ch{border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.72),rgba(255,255,255,.28));border:1px solid rgba(255,255,255,.72);box-shadow:inset 1px 1px 2px rgba(255,255,255,.9),0 8px 18px rgba(70,82,110,.10)}
  .header{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:18px;padding:0 6px;flex-wrap:wrap}
  .title{display:flex;align-items:center;gap:12px;font-size:30px;font-weight:800;line-height:1.2;text-shadow:1px 1px 0 rgba(255,255,255,.5)}
  .title i{width:11px;height:11px;border-radius:50%;background:#e9a93a;box-shadow:0 0 0 5px rgba(255,255,255,.55),0 0 14px rgba(233,169,58,.6)}
  .sub{color:var(--soft);font-size:13px;margin:2px 0 0}
  .clock{text-align:center;padding:12px 28px;border-radius:999px;font-size:14px;font-weight:500;background:linear-gradient(145deg,rgba(255,255,255,.8),rgba(190,216,246,.5));border:1px solid rgba(255,255,255,.9);box-shadow:0 10px 18px rgba(70,95,150,.18)}
  .clock b{display:block;color:var(--accent);font-weight:700;font-size:18px;letter-spacing:1px}
  h2{font-size:18px;font-weight:700;margin-bottom:14px}
  label{display:block;font-size:13px;color:var(--soft);margin-bottom:6px}
  select{width:100%;padding:13px 16px;border-radius:16px;border:1px solid rgba(255,255,255,.9);background:rgba(255,255,255,.75);color:var(--ink);font:inherit;font-size:15px;direction:ltr;text-align:left;outline:none;box-shadow:inset 2px 2px 5px rgba(120,135,165,.14)}
  select:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(58,111,184,.15)}
  input[type=text],input[type=password]{width:100%;padding:13px 16px;border-radius:16px;border:1px solid rgba(255,255,255,.9);background:rgba(255,255,255,.65);color:var(--ink);font:inherit;font-size:15px;direction:ltr;text-align:left;outline:none;box-shadow:inset 2px 2px 5px rgba(120,135,165,.14)}
  input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(58,111,184,.15)}
  button{font:inherit;font-size:14px;font-weight:500;cursor:pointer;border-radius:14px;padding:9px 18px;color:var(--ink);background:linear-gradient(145deg,rgba(255,255,255,.9),rgba(255,255,255,.45));border:1px solid rgba(255,255,255,.9);box-shadow:3px 3px 8px rgba(100,110,125,.12),inset 1px 1px 2px #fff;transition:transform .12s}
  button:hover:not(:disabled){transform:translateY(-1px)}
  button.primary{color:#fff;border-color:rgba(58,111,184,.6);background:linear-gradient(145deg,#5b9dff,#3a6fb8)}
  button.danger{color:var(--down);border-color:rgba(217,69,91,.3);background:rgba(217,69,91,.1)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .row{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
  .msg{margin-top:10px;font-size:14px;min-height:22px}.msg.err{color:var(--down)}.msg.ok{color:var(--up)}
  .hidden{display:none!important}
  .stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
  .tile{padding:12px 16px;border-inline-start:4px solid transparent}
  .tile .k{display:block;font-size:12px;color:var(--soft)}.tile .v{font-size:16px;font-weight:700;word-break:break-word}
  .tile.good{border-inline-start-color:var(--up)}.tile.good .v{color:var(--up)}
  .tile.warn{border-inline-start-color:var(--warn)}.tile.warn .v{color:var(--warn)}
  .tile.bad{border-inline-start-color:var(--down)}.tile.bad .v{color:var(--down)}
  .errs{grid-column:1/-1;font-size:13px;color:var(--warn)}
  .list{display:grid;gap:12px}
  .ch{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1.4fr) auto;gap:14px;align-items:center;padding:14px 18px}
  .ch.disabled .meta,.ch.disabled .who{opacity:.5}
  .who a{color:var(--accent);font-weight:700;direction:ltr;display:inline-block;text-decoration:none}
  .who small{display:block;color:var(--soft);font-size:12px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;font-size:12px}
  .chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:12px;font-variant-numeric:tabular-nums;background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.85)}
  .chip.on{color:var(--up);background:rgba(21,157,120,.11);border-color:rgba(21,157,120,.28)}
  .chip.off{color:var(--soft);background:rgba(111,118,131,.1);border-color:rgba(111,118,131,.22)}
  .acts{display:flex;gap:8px}
  .empty{color:var(--soft);text-align:center;padding:26px 0}
  .signature{margin-top:26px;text-align:center;font-family:"Bitcount Ink",Arial,sans-serif;font-size:26px;letter-spacing:.8px;text-shadow:1px 1px 0 rgba(255,255,255,.65)}
  /* ابزارها و آزمون — mode toggle + test buttons */
  .mode-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;flex-wrap:wrap;margin-top:4px}
  .mode-title{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
  .mode-title .dot{width:9px;height:9px;border-radius:50%;background:var(--soft);box-shadow:0 0 0 4px rgba(255,255,255,.5);transition:.2s}
  .mode-row.live .dot{background:var(--up);box-shadow:0 0 0 4px rgba(21,157,120,.18),0 0 10px rgba(21,157,120,.5)}
  .switch{position:relative;flex:0 0 auto;width:58px;height:32px}
  .switch input{opacity:0;width:0;height:0;position:absolute}
  .switch .sl{position:absolute;inset:0;cursor:pointer;border-radius:999px;background:rgba(111,118,131,.25);border:1px solid rgba(255,255,255,.85);box-shadow:inset 2px 2px 6px rgba(120,135,165,.22);transition:.2s}
  .switch .sl:before{content:'';position:absolute;top:3px;inset-inline-start:3px;width:24px;height:24px;border-radius:50%;background:linear-gradient(145deg,#fff,#e6ebf4);box-shadow:0 3px 6px rgba(70,82,110,.3),inset 1px 1px 2px #fff;transition:.2s}
  .switch input:checked + .sl{background:linear-gradient(145deg,#57c9a5,#159d78);border-color:rgba(21,157,120,.5)}
  .switch input:checked + .sl:before{transform:translateX(-28px)}
  .switch input:disabled + .sl{opacity:.5;cursor:not-allowed}
  .log{margin-top:12px;padding:14px 18px;border-radius:16px;font:inherit;font-size:13px;line-height:1.9;white-space:pre-wrap;word-break:break-word;color:var(--ink);background:rgba(13,21,29,.06);border:1px solid rgba(255,255,255,.8);box-shadow:inset 2px 2px 5px rgba(120,135,165,.12);max-height:280px;overflow:auto}
  @media(max-width:720px){.ch{grid-template-columns:1fr}.acts{justify-content:flex-start}.title{font-size:24px}}
</style>
</head>
<body>
<div class="bubble gold b1"></div><div class="bubble b2"></div><div class="bubble gold b3"></div>
<div class="wrap">

  <section id="loginView" class="glass" style="max-width:440px;margin:12vh auto 0">
    <div class="title" style="margin-bottom:6px"><i></i>ورود مدیر</div>
    <div class="sub" style="margin-bottom:18px">برای مدیریت کانال‌ها رمز مدیر را وارد کنید.</div>
    <label for="password">رمز مدیر</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="••••••••">
    <div class="row"><button id="loginBtn" class="primary">ورود</button></div>
    <div id="loginMsg" class="msg"></div>
  </section>

  <div id="appView" class="hidden">
    <div class="header">
      <div>
        <div class="title"><i></i>مدیریت کانال‌های خبر</div>
        <div class="sub">کانال‌های عمومی تلگرام که هر ساعت بررسی می‌شوند.</div>
      </div>
      <div style="display:flex;gap:12px;align-items:center">
        <div class="clock">تهران<b id="clock">--:--</b></div>
        <button id="logoutBtn">خروج</button>
      </div>
    </div>

    <section class="glass">
      <h2>وضعیت سامانه</h2>
      <div class="stats" id="statusBox"><div class="tile"><span class="k">در حال بارگذاری…</span></div></div>
      <div class="row"><button id="refreshStatus">به‌روزرسانی وضعیت</button></div>
      <div id="statusMsg" class="msg"></div>
    </section>

    <section class="glass">
      <h2>افزودن کانال</h2>
      <label for="username">نام کاربری یا نشانی عمومی کانال</label>
      <input id="username" type="text" placeholder="@channelname یا https://t.me/channelname" autocomplete="off">
      <div class="row"><button id="addBtn" class="primary">افزودن کانال</button></div>
      <div id="addMsg" class="msg"></div>
    </section>

    <section class="glass">
      <h2>کانال‌ها</h2>
      <div id="rows" class="list"></div>
      <div id="empty" class="empty hidden">هنوز کانالی ثبت نشده است.</div>
      <div id="listMsg" class="msg"></div>
    </section>

    <section class="glass" id="modelSection">
      <h2>مدل هوش مصنوعی (رایگان)</h2>
      <div class="sub" style="margin-bottom:10px">فقط مدل‌های رایگان OpenRouter فهرست می‌شوند. اگر مدلی را انتخاب کنید همان مدل برای خلاصه‌سازی و رتبه‌بندی استفاده می‌شود؛ با انتخاب «خودکار» سامانه بهترین مدل رایگان را خودش برمی‌گزیند.</div>
      <label for="modelSelect">مدل مورد استفاده</label>
      <select id="modelSelect"><option value="">در حال بارگذاری…</option></select>
      <div class="row">
        <button id="saveModelBtn" class="primary">ذخیره مدل</button>
        <button id="refreshModelsBtn">🔄 به‌روزرسانی فهرست مدل‌ها</button>
      </div>
      <div id="modelMsg" class="msg"></div>
    </section>

    <section class="glass" id="toolsSection">
      <h2>ابزارها و آزمون</h2>
      <div class="mode-row tile" id="modeRow">
        <div style="min-width:220px;flex:1">
          <div class="mode-title"><span class="dot"></span>فقط جمع‌آوری اخبار (بدون پردازش)</div>
          <div class="sub">در این حالت سامانه فقط اخبار را جمع‌آوری و ذخیره می‌کند؛ هیچ خلاصه‌سازی، رتبه‌بندی یا انتشاری انجام نمی‌شود و چیزی به کانال مقصد ارسال نمی‌گردد.</div>
        </div>
        <label class="switch" title="حالت فقط جمع‌آوری">
          <input type="checkbox" id="modeToggle">
          <span class="sl"></span>
        </label>
      </div>

      <div class="sub" style="margin:16px 0 8px">دکمه‌های آزمایشی — اجرای دستی بدون انتظار برای زمان‌بندی ساعتی:</div>
      <div class="row" style="margin-top:0">
        <button id="collectNowBtn" class="primary">📥 جمع‌آوری فوری اخبار</button>
        <button id="fullRunBtn">⚙️ اجرای کامل پردازش</button>
        <button id="testMessageBtn">🧪 ارسال پیام آزمایشی</button>
        <button id="testImageBtn">🖼 ارسال تصویر آزمایشی</button>
      </div>
      <div id="toolsMsg" class="msg"></div>
      <pre id="toolsLog" class="log hidden" dir="rtl"></pre>
    </section>
  </div>
  <div class="signature">Akhal-Teke</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const setMsg = (el, text, kind) => { el.textContent = text; el.className = 'msg' + (kind ? ' ' + kind : ''); };
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function faDate(iso) {
  if (!iso) return 'هرگز';
  try { return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(new Date(iso)); }
  catch { return iso; }
}

function faDuration(ms) {
  if (ms < 1000) return 'کمتر از یک ثانیه';
  if (ms < 60000) return Math.round(ms / 1000) + ' ثانیه';
  return Math.round(ms / 6000) / 10 + ' دقیقه';
}

function tickClock() {
  $('clock').textContent = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date());
}
tickClock(); setInterval(tickClock, 15000);

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...options });
  if (res.status === 204) return null;
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'خطای نامشخص از سرور');
  return data;
}

function showLogin() { $('loginView').classList.remove('hidden'); $('appView').classList.add('hidden'); }
function showApp() { $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden'); }

function tile(k, v, cls) {
  const t = mk('div', 'tile' + (cls ? ' ' + cls : ''));
  t.append(mk('span', 'k', k), mk('span', 'v', String(v)));
  return t;
}

function syncModeBanner() {
  $('modeRow').classList.toggle('live', $('modeToggle').checked);
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('modeToggle').checked = !!s.collectionOnly;
    syncModeBanner();
  } catch {}
}

let modelCatalog = { models: [], selected: null, pinned: null };

// Free-model catalog. A refresh re-queries OpenRouter (one subrequest); the
// default read is cache-only, so opening the panel costs nothing.
async function loadModels(refresh) {
  const sel = $('modelSelect');
  try {
    const data = await api('/api/models' + (refresh ? '?refresh=1' : ''));
    modelCatalog = data;
    sel.textContent = '';
    const auto = mk('option', '', 'خودکار (بهترین مدل رایگان)');
    auto.value = '';
    sel.appendChild(auto);
    for (const id of data.models) {
      const o = mk('option', '', id + (id === data.selected && !data.pinned ? '  ← در حال استفاده' : ''));
      o.value = id;
      sel.appendChild(o);
    }
    sel.value = data.pinned || '';
    const parts = [];
    parts.push(data.models.length + ' مدل رایگان');
    if (data.selected) parts.push('مدل فعلی: ' + data.selected);
    parts.push(data.pinned ? 'انتخاب دستی' : 'انتخاب خودکار');
    if (data.refreshError) parts.push('⚠️ به‌روزرسانی فهرست ناموفق بود (' + data.refreshError + ')؛ فهرست ذخیره‌شده نمایش داده شد.');
    setMsg($('modelMsg'), parts.join(' — '), data.refreshError ? 'err' : null);
  } catch (e) {
    setMsg($('modelMsg'), e.message, 'err');
  }
}

async function loadStatus() {
  const box = $('statusBox');
  try {
    const s = await api('/api/status');
    const run = s.cron.lastRun;
    const rc = !run ? '' : run.status === 'failed' ? 'bad' : run.status === 'partial' ? 'warn' : 'good';
    const collectionOnly = !!(s.processing && s.processing.collectionOnly);
    const items = [
      ['حالت پردازش', collectionOnly ? 'فقط جمع‌آوری اخبار' : 'کامل (خلاصه + انتشار)', collectionOnly ? 'warn' : 'good'],
      ['کانال‌های فعال', s.channels.enabled + ' از ' + s.channels.total, s.channels.enabled > 0 ? 'good' : 'warn'],
      ['آخرین اجرای ساعتی', run ? faDate(run.ranAt) : 'هنوز اجرا نشده', rc],
      ['نتیجه آخرین اجرا', run ? run.status : '—', rc],
      ['کل اخبار ذخیره‌شده', s.messages.total, ''],
      ['آخرین جمع‌آوری', faDate(s.messages.lastCollectedAt), ''],
      ['پیام‌های یک ساعت اخیر', s.messages.collectedLastHour, ''],
      ['تبلیغات فیلترشده', s.messages.filteredAdvertisements, ''],
      ['در انتظار خلاصه‌سازی', s.messages.waitingSummarization, !collectionOnly && s.messages.waitingSummarization > 0 ? 'warn' : ''],
      ['در انتظار انتشار', s.messages.waitingPublishing, !collectionOnly && s.messages.waitingPublishing > 0 ? 'warn' : ''],
      ['خلاصه‌شده یک ساعت اخیر', s.messages.summarizedLastHour, ''],
      ['منتشرشده یک ساعت اخیر', s.messages.publishedLastHour, ''],
      ['آخرین خلاصه‌سازی', faDate(s.messages.lastSummarizedAt), ''],
      ['آخرین انتشار', faDate(s.messages.lastPublishedAt), ''],
      ['مدل رایگان فعال', s.ai.model || '—', s.ai.model ? 'good' : 'warn'],
      ['نحوه انتخاب مدل', s.ai.pinnedModel ? 'دستی (' + s.ai.pinnedModel + ')' : 'خودکار', ''],
      ['تعداد مدل‌های رایگان', s.ai.freeModelsCached, ''],
      ['آخرین به‌روزرسانی فهرست مدل‌ها', faDate(s.ai.lastModelRefreshAt), ''],
      ['کانال مقصد', s.publishing.destinationConfigured ? 'تنظیم شده' : 'تنظیم نشده', s.publishing.destinationConfigured ? 'good' : 'bad'],
      ['اجراهای ۲۴ ساعت اخیر', s.cron.runs24h + ' (' + s.cron.failedRuns24h + ' ناموفق)', s.cron.failedRuns24h > 0 ? 'warn' : ''],
    ];
    box.textContent = '';
    for (const [k, v, c] of items) box.appendChild(tile(k, v, c));
    if (s.recentErrors.length > 0) {
      box.appendChild(mk('div', 'errs', 'خطاهای اخیر: ' + s.recentErrors.map((e) => e.category + ' (' + e.count + ')').join('، ')));
    }
    setMsg($('statusMsg'), '', null);
  } catch (e) {
    box.textContent = '';
    box.appendChild(tile('وضعیت', e.message, 'bad'));
  }
}

async function loadChannels() {
  const { channels } = await api('/api/channels');
  const list = $('rows');
  list.textContent = '';
  $('empty').classList.toggle('hidden', channels.length > 0);

  for (const ch of channels) {
    const card = mk('div', 'ch' + (ch.enabled ? '' : ' disabled'));

    const who = mk('div', 'who');
    const link = mk('a', '', '@' + ch.channelUsername);
    link.href = 'https://t.me/' + ch.channelUsername;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    who.append(link, mk('small', '', ch.channelTitle || '—'));

    const st = ch.stats || { messages: 0, summarized: 0, published: 0 };
    const meta = mk('div', 'meta');
    meta.append(
      mk('span', 'chip ' + (ch.enabled ? 'on' : 'off'), ch.enabled ? 'فعال' : 'غیرفعال'),
      mk('span', 'chip', 'پیام / خلاصه / منتشرشده: ' + st.messages + ' / ' + st.summarized + ' / ' + st.published),
      mk('span', 'chip', 'آخرین بررسی: ' + faDate(ch.lastCheckedAt))
    );

    const toggle = mk('button', '', ch.enabled ? 'غیرفعال کردن' : 'فعال کردن');
    toggle.onclick = async () => {
      toggle.disabled = true;
      try {
        await api('/api/channels/' + ch.id, { method: 'PATCH', body: JSON.stringify({ enabled: !ch.enabled }) });
        setMsg($('listMsg'), 'وضعیت کانال به‌روزرسانی شد.', 'ok');
        await loadChannels();
        loadStatus();
      } catch (e) { setMsg($('listMsg'), e.message, 'err'); toggle.disabled = false; }
    };

    const del = mk('button', 'danger', 'حذف');
    del.onclick = async () => {
      if (!confirm('کانال @' + ch.channelUsername + ' حذف شود؟')) return;
      del.disabled = true;
      try {
        await api('/api/channels/' + ch.id, { method: 'DELETE' });
        setMsg($('listMsg'), 'کانال حذف شد.', 'ok');
        await loadChannels();
        loadStatus();
      } catch (e) { setMsg($('listMsg'), e.message, 'err'); del.disabled = false; }
    };

    const acts = mk('div', 'acts');
    acts.append(toggle, del);
    card.append(who, meta, acts);
    list.appendChild(card);
  }
}

$('loginBtn').onclick = async () => {
  const btn = $('loginBtn');
  btn.disabled = true;
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    setMsg($('loginMsg'), '', null);
    showApp();
    await loadChannels();
    await loadStatus();
    await loadSettings();
    await loadModels(false);
  } catch (e) { setMsg($('loginMsg'), e.message, 'err'); }
  btn.disabled = false;
};
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

$('logoutBtn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  showLogin();
};

$('addBtn').onclick = async () => {
  const btn = $('addBtn');
  const value = $('username').value.trim();
  if (!value) { setMsg($('addMsg'), 'نام کاربری یا نشانی کانال را وارد کنید.', 'err'); return; }
  btn.disabled = true;
  try {
    const { channel } = await api('/api/channels', { method: 'POST', body: JSON.stringify({ username: value }) });
    $('username').value = '';
    setMsg($('addMsg'), 'کانال @' + channel.channelUsername + ' افزوده شد.', 'ok');
    await loadChannels();
    loadStatus();
  } catch (e) { setMsg($('addMsg'), e.message, 'err'); }
  btn.disabled = false;
};
$('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addBtn').click(); });

$('refreshStatus').onclick = async () => {
  const btn = $('refreshStatus');
  btn.disabled = true;
  await loadStatus();
  btn.disabled = false;
};

$('saveModelBtn').onclick = async () => {
  const btn = $('saveModelBtn');
  btn.disabled = true;
  const value = $('modelSelect').value;
  try {
    const data = await api('/api/models', { method: 'POST', body: JSON.stringify({ model: value || null }) });
    modelCatalog = data;
    setMsg($('modelMsg'), data.pinned ? '✅ مدل «' + data.pinned + '» انتخاب شد.' : '✅ انتخاب مدل روی حالت خودکار تنظیم شد.', 'ok');
    loadStatus();
  } catch (e) { setMsg($('modelMsg'), e.message, 'err'); }
  btn.disabled = false;
};

$('refreshModelsBtn').onclick = async () => {
  const btn = $('refreshModelsBtn');
  btn.disabled = true;
  setMsg($('modelMsg'), 'در حال دریافت فهرست مدل‌های رایگان…', null);
  await loadModels(true);
  btn.disabled = false;
};

// Collection-only mode is persisted server-side (ai_settings) and takes effect
// on the very next hourly run: raw news is stored, nothing is processed/sent.
$('modeToggle').addEventListener('change', async () => {
  const on = $('modeToggle').checked;
  $('modeToggle').disabled = true;
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ collectionOnly: on }) });
    $('modeToggle').checked = on;
    setMsg($('toolsMsg'), on
      ? 'حالت «فقط جمع‌آوری» فعال شد؛ دیگر خلاصه‌سازی یا انتشاری انجام نمی‌شود.'
      : 'پردازش کامل فعال شد؛ اخبار خلاصه و در کانال مقصد منتشر می‌شوند.', 'ok');
    loadStatus();
  } catch (e) {
    $('modeToggle').checked = !on;
    setMsg($('toolsMsg'), e.message, 'err');
  }
  $('modeToggle').disabled = false;
  syncModeBanner();
});

// Safe, human-readable Persian labels for the server's error categories.
function aiErrorLabel(category) {
  const map = {
    config_missing: 'کلید API تنظیم نشده',
    no_free_model: 'مدل رایگانی در دسترس نیست',
    rate_limited: 'محدودیت نرخ درخواست',
    provider_error: 'خطای سرویس‌دهنده مدل',
    invalid_response: 'پاسخ نامعتبر مدل (JSON خراب)',
    timeout: 'اتمام زمان انتظار',
    network: 'خطای شبکه',
    empty_after_filter: 'متن پس از فیلتر خالی شد',
  };
  return map[category] || category;
}

function imageReasonLabel(reason) {
  const map = {
    browser_binding_missing: 'اتصال Browser Run تنظیم نشده است',
    no_suitable_items: 'خبری مناسب برای تصویر وجود نداشت',
    render_failed: 'ساخت تصویر ناموفق بود',
    send_failed: 'ارسال تصویر به تلگرام ناموفق بود',
  };
  return map[reason] || reason || 'نامشخص';
}

function showRunLog(lines) {
  const pre = $('toolsLog');
  pre.textContent = lines.join('\\n');
  pre.classList.remove('hidden');
}

// Manual pipeline runs. 'collect' forces raw collection only; 'process' forces
// the full pipeline for this run regardless of the stored mode.
async function runPipeline(mode, btn) {
  btn.disabled = true;
  setMsg($('toolsMsg'), mode === 'collect' ? 'در حال جمع‌آوری اخبار از کانال‌ها…' : 'در حال اجرای کامل پردازش…', null);
  try {
    const r = await api('/api/pipeline/run', { method: 'POST', body: JSON.stringify({ mode }) });
    const lines = [
      'وضعیت اجرا: ' + r.status + (r.collectionOnly ? ' (فقط جمع‌آوری)' : ' (پردازش کامل)'),
      'مدت اجرا: ' + faDuration(r.durationMs),
    ];
    if (r.collection) {
      lines.push('جمع‌آوری: ' + r.collection.succeeded + ' از ' + r.collection.enabledChannels + ' کانال موفق — ' + r.collection.inserted + ' پیام جدید' + (r.collection.failed > 0 ? ' (' + r.collection.failed + ' ناموفق)' : ''));
    }
    if (!r.collectionOnly) {
      lines.push('تبلیغات فیلترشده: ' + r.filteredAdvertisements);
      if (r.summarization) {
        lines.push('خلاصه‌سازی: ' + r.summarization.summarized + ' از ' + r.summarization.eligible + (r.summarization.model ? ' — مدل: ' + r.summarization.model : '') + (r.summarization.failed > 0 ? ' (' + r.summarization.failed + ' خطا)' : ''));
        const cats = r.summarization.failureCategories || {};
        const catKeys = Object.keys(cats);
        if (catKeys.length > 0) {
          lines.push('علت خطاهای خلاصه‌سازی: ' + catKeys.map((k) => aiErrorLabel(k) + ' (' + cats[k] + ')').join('، '));
        }
        if (r.summarization.abandonedModels && r.summarization.abandonedModels.length > 0) {
          lines.push('مدل‌های کنارگذاشته‌شده: ' + r.summarization.abandonedModels.join('، '));
        }
      }
      if (r.ranking) {
        lines.push('رتبه‌بندی: ' + r.ranking.important + ' خبر مهم از ' + r.ranking.ranked);
      }
      if (r.publishing) {
        lines.push('انتشار: ' + r.publishing.published + ' از ' + r.publishing.eligible + (r.publishing.bale ? ' — بیل: ' + r.publishing.bale.sent + ' ارسال' : ''));
        if (r.publishing.image) {
          lines.push('تصویر خبری: ' + (r.publishing.image.sent
            ? 'ارسال شد (' + r.publishing.image.cards + ' کارت)'
            : 'ارسال نشد — ' + imageReasonLabel(r.publishing.image.reason)));
        }
      }
    } else {
      lines.push('پردازش انجام نشد — در این حالت فقط اخبار خام ذخیره می‌شوند.');
    }
    if (r.itemFailures > 0) lines.push('خطای سطح رکورد: ' + r.itemFailures);
    if (r.errors && r.errors.length > 0) lines.push('خطاهای مرحله: ' + r.errors.join(' | '));
    showRunLog(lines);
    setMsg($('toolsMsg'), r.ok ? '✅ اجرا تمام شد.' : '⚠️ اجرا با خطا تمام شد؛ جزئیات در کادر پایین.', r.ok ? 'ok' : 'err');
    loadStatus();
    loadChannels();
  } catch (e) {
    setMsg($('toolsMsg'), e.message, 'err');
  }
  btn.disabled = false;
}

$('collectNowBtn').onclick = () => runPipeline('collect', $('collectNowBtn'));
$('fullRunBtn').onclick = () => runPipeline('process', $('fullRunBtn'));

// Sends one test message to the configured destination channel and reports
// the server's verdict; the server never reveals the destination itself.
$('testMessageBtn').onclick = async () => {
  const btn = $('testMessageBtn');
  btn.disabled = true;
  setMsg($('toolsMsg'), 'در حال ارسال پیام آزمایشی…', null);
  try {
    await api('/api/telegram/test-message', { method: 'POST', body: '{}' });
    setMsg($('toolsMsg'), '✅ پیام آزمایشی به کانال مقصد ارسال شد.', 'ok');
  } catch (e) {
    setMsg($('toolsMsg'), e.message, 'err');
  }
  btn.disabled = false;
};

// Renders the REAL pending news into the run image and sends ONLY that image.
// Reports the server's verdict; nothing is marked published by the test.
$('testImageBtn').onclick = async () => {
  const btn = $('testImageBtn');
  btn.disabled = true;
  setMsg($('toolsMsg'), 'در حال ساخت و ارسال تصویر آزمایشی…', null);
  try {
    const r = await api('/api/telegram/test-image', { method: 'POST', body: '{}' });
    setMsg($('toolsMsg'), '✅ تصویر آزمایشی ارسال شد — ' + r.cards + ' کارت، ' + r.ticker + ' عنوان دیگر.', 'ok');
  } catch (e) {
    setMsg($('toolsMsg'), e.message, 'err');
  }
  btn.disabled = false;
};

setInterval(() => { if (!$('appView').classList.contains('hidden')) loadStatus(); }, 60000);

(async () => {
  try {
    await api('/api/auth/session');
    showApp();
    await loadChannels();
    await loadStatus();
    await loadSettings();
    await loadModels(false);
  }
  catch { showLogin(); }
})();
</script>
</body>
</html>`;
