export const APP_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>مدیریت کانال‌ها</title>
<style>
  :root {
    --bg: #0f1720; --panel: #16212c; --line: #24313d; --text: #e8eef4;
    --muted: #90a4b8; --accent: #2f81f7; --on: #16a34a; --off: #64748b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: Vazirmatn, "IRANSans", Tahoma, "Segoe UI", sans-serif;
    line-height: 1.9; padding: 24px 16px;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 0 0 12px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  label { display: block; font-size: 14px; color: var(--muted); margin-bottom: 6px; }
  input[type=text], input[type=password] {
    width: 100%; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--line);
    background: #0d151d; color: var(--text); font-family: inherit; font-size: 15px; direction: ltr; text-align: left;
  }
  button {
    font-family: inherit; font-size: 14px; cursor: pointer; border-radius: 8px;
    padding: 10px 18px; border: 1px solid var(--line); background: #223141; color: var(--text);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { background: #7f1d1d; border-color: #991b1b; color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: right; padding: 12px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; }
  td.dir { direction: ltr; text-align: left; font-family: ui-monospace, monospace; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 13px; white-space: nowrap; }
  .badge.on { background: rgba(22,163,74,.16); color: #4ade80; border: 1px solid rgba(22,163,74,.4); }
  .badge.off { background: rgba(100,116,139,.16); color: #cbd5e1; border: 1px solid rgba(100,116,139,.45); }
  tr.disabled td { opacity: .55; }
  .msg { margin-top: 12px; font-size: 14px; min-height: 22px; }
  .msg.err { color: #f87171; }
  .msg.ok { color: #4ade80; }
  .empty { color: var(--muted); font-size: 14px; padding: 24px 0; text-align: center; }
  .hidden { display: none !important; }
  .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .stat { background: #0d151d; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .stat .k { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .stat .v { font-size: 15px; font-weight: 600; }
  .stat.warn .v { color: #fbbf24; }
  .stat.bad .v { color: #f87171; }
  .stat.good .v { color: #4ade80; }
  .errs { margin-top: 10px; font-size: 13px; color: #fbbf24; }
</style>
</head>
<body>
<div class="wrap">

  <section id="loginView" class="panel">
    <h1>ورود مدیر</h1>
    <div class="sub">برای مدیریت کانال‌ها رمز مدیر را وارد کنید.</div>
    <label for="password">رمز مدیر</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="••••••••">
    <div class="row">
      <button id="loginBtn" class="primary">ورود</button>
    </div>
    <div id="loginMsg" class="msg"></div>
  </section>

  <div id="appView" class="hidden">
    <div class="topbar">
      <h1>مدیریت کانال‌های خبر</h1>
      <button id="logoutBtn">خروج</button>
    </div>
    <div class="sub">کانال‌های عمومی تلگرام که هر ساعت بررسی می‌شوند.</div>

    <section class="panel">
      <h2>وضعیت سامانه</h2>
      <div class="stats" id="statusBox">
        <div class="stat"><span class="k">در حال بارگذاری…</span></div>
      </div>
      <div class="row">
        <button id="refreshStatus">به‌روزرسانی وضعیت</button>
        <button id="testMessageBtn">🧪 ارسال پیام آزمایشی</button>
      </div>
      <div id="statusMsg" class="msg"></div>
    </section>

    <section class="panel">
      <h2>افزودن کانال</h2>
      <label for="username">نام کاربری یا نشانی عمومی کانال</label>
      <input id="username" type="text" placeholder="@channelname یا https://t.me/channelname" autocomplete="off">
      <div class="row">
        <button id="addBtn" class="primary">افزودن کانال</button>
      </div>
      <div id="addMsg" class="msg"></div>
    </section>

    <section class="panel">
      <h2>کانال‌ها</h2>
      <table>
        <thead>
          <tr>
            <th>کانال</th>
            <th>عنوان</th>
            <th>وضعیت</th>
            <th>پیام / خلاصه / منتشرشده</th>
            <th>آخرین بررسی</th>
            <th>عملیات</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="empty" class="empty hidden">هنوز کانالی ثبت نشده است.</div>
      <div id="listMsg" class="msg"></div>
    </section>
  </div>

</div>
<script>
const $ = (id) => document.getElementById(id);
const setMsg = (el, text, kind) => { el.textContent = text; el.className = 'msg' + (kind ? ' ' + kind : ''); };

function faDate(iso) {
  if (!iso) return 'هرگز';
  try {
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch { return iso; }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'خطای نامشخص از سرور');
  return data;
}

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
}

function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
}

async function loadStatus() {
  const box = $('statusBox');
  try {
    const s = await api('/api/status');
    const run = s.cron.lastRun;
    const runClass =
      !run ? '' : run.status === 'failed' ? 'bad' : run.status === 'partial' ? 'warn' : 'good';
    const items = [
      ['کانال‌های فعال', s.channels.enabled + ' از ' + s.channels.total, s.channels.enabled > 0 ? 'good' : 'warn'],
      ['آخرین اجرای ساعتی', run ? faDate(run.ranAt) : 'هنوز اجرا نشده', runClass],
      ['نتیجه آخرین اجرا', run ? run.status : '—', runClass],
      ['پیام‌های یک ساعت اخیر', s.messages.collectedLastHour, ''],
      ['در انتظار خلاصه‌سازی', s.messages.waitingSummarization, s.messages.waitingSummarization > 0 ? 'warn' : ''],
      ['در انتظار انتشار', s.messages.waitingPublishing, s.messages.waitingPublishing > 0 ? 'warn' : ''],
      ['خلاصه‌شده یک ساعت اخیر', s.messages.summarizedLastHour, ''],
      ['منتشرشده یک ساعت اخیر', s.messages.publishedLastHour, ''],
      ['آخرین خلاصه‌سازی', faDate(s.messages.lastSummarizedAt), ''],
      ['آخرین انتشار', faDate(s.messages.lastPublishedAt), ''],
      ['مدل رایگان فعال', s.ai.model || '—', s.ai.model ? 'good' : 'warn'],
      ['تعداد مدل‌های رایگان', s.ai.freeModelsCached, ''],
      ['آخرین به‌روزرسانی فهرست مدل‌ها', faDate(s.ai.lastModelRefreshAt), ''],
      ['کانال مقصد', s.publishing.destinationConfigured ? 'تنظیم شده' : 'تنظیم نشده', s.publishing.destinationConfigured ? 'good' : 'bad'],
      ['اجراهای ۲۴ ساعت اخیر', s.cron.runs24h + ' (' + s.cron.failedRuns24h + ' ناموفق)', s.cron.failedRuns24h > 0 ? 'warn' : ''],
    ];

    box.textContent = '';
    for (const [k, v, cls] of items) {
      const cell = document.createElement('div');
      cell.className = 'stat' + (cls ? ' ' + cls : '');
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = k;
      const val = document.createElement('span');
      val.className = 'v';
      val.textContent = String(v);
      cell.append(key, val);
      box.appendChild(cell);
    }

    if (s.recentErrors.length > 0) {
      const errs = document.createElement('div');
      errs.className = 'errs';
      errs.textContent =
        'خطاهای اخیر: ' +
        s.recentErrors.map((e) => e.category + ' (' + e.count + ')').join('، ');
      box.appendChild(errs);
    }
    setMsg($('statusMsg'), '', null);
  } catch (e) {
    box.textContent = '';
    const cell = document.createElement('div');
    cell.className = 'stat bad';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = 'وضعیت';
    const val = document.createElement('span');
    val.className = 'v';
    val.textContent = e.message;
    cell.append(key, val);
    box.appendChild(cell);
  }
}

async function loadChannels() {
  const { channels } = await api('/api/channels');
  const rows = $('rows');
  rows.textContent = '';
  $('empty').classList.toggle('hidden', channels.length > 0);

  for (const ch of channels) {
    const tr = document.createElement('tr');
    if (!ch.enabled) tr.className = 'disabled';

    const name = document.createElement('td');
    name.className = 'dir';
    const link = document.createElement('a');
    link.href = 'https://t.me/' + ch.channelUsername;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.color = 'var(--accent)';
    link.textContent = '@' + ch.channelUsername;
    name.appendChild(link);

    const title = document.createElement('td');
    title.textContent = ch.channelTitle || '—';

    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (ch.enabled ? 'on' : 'off');
    badge.textContent = ch.enabled ? 'فعال' : 'غیرفعال';
    status.appendChild(badge);

    const counts = document.createElement('td');
    const st = ch.stats || { messages: 0, summarized: 0, published: 0 };
    counts.textContent = st.messages + ' / ' + st.summarized + ' / ' + st.published;

    const checked = document.createElement('td');
    checked.textContent = faDate(ch.lastCheckedAt);

    const actions = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.textContent = ch.enabled ? 'غیرفعال کردن' : 'فعال کردن';
    toggle.onclick = async () => {
      toggle.disabled = true;
      try {
        await api('/api/channels/' + ch.id, { method: 'PATCH', body: JSON.stringify({ enabled: !ch.enabled }) });
        setMsg($('listMsg'), 'وضعیت کانال به‌روزرسانی شد.', 'ok');
        await loadChannels();
      } catch (e) { setMsg($('listMsg'), e.message, 'err'); toggle.disabled = false; }
    };

    const del = document.createElement('button');
    del.className = 'danger';
    del.style.marginRight = '8px';
    del.textContent = 'حذف';
    del.onclick = async () => {
      if (!confirm('کانال @' + ch.channelUsername + ' حذف شود؟')) return;
      del.disabled = true;
      try {
        await api('/api/channels/' + ch.id, { method: 'DELETE' });
        setMsg($('listMsg'), 'کانال حذف شد.', 'ok');
        await loadChannels();
      } catch (e) { setMsg($('listMsg'), e.message, 'err'); del.disabled = false; }
    };

    actions.append(toggle, del);
    tr.append(name, title, status, counts, checked, actions);
    rows.appendChild(tr);
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

// Sends one test message to the configured destination channel and reports
// the server's verdict; the server never reveals the destination itself.
$('testMessageBtn').onclick = async () => {
  const btn = $('testMessageBtn');
  btn.disabled = true;
  setMsg($('statusMsg'), 'در حال ارسال پیام آزمایشی…', null);
  try {
    await api('/api/telegram/test-message', { method: 'POST', body: '{}' });
    setMsg($('statusMsg'), '✅ پیام آزمایشی به کانال مقصد ارسال شد.', 'ok');
  } catch (e) {
    setMsg($('statusMsg'), e.message, 'err');
  }
  btn.disabled = false;
};

// Keeps the diagnostics panel reasonably fresh while the admin is watching.
setInterval(() => {
  if (!$('appView').classList.contains('hidden')) loadStatus();
}, 60000);

(async () => {
  try {
    await api('/api/auth/session');
    showApp();
    await loadChannels();
    await loadStatus();
  } catch { showLogin(); }
})();
</script>
</body>
</html>`;
