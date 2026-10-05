/**
 * Clicks the admin panel's buttons without a browser.
 *
 * `src/ui.ts` is one big TS template literal, which means every backslash,
 * `${` and quote in the page's JavaScript is one escaping mistake away from
 * shipping a page whose script throws on line 1 — and a page whose script
 * throws looks exactly like a button that "does nothing". The vitest suite
 * cannot catch that: it runs inside workerd, where `eval` is forbidden, so it
 * can only assert that the markup *contains* an id.
 *
 * This script builds a deliberately small DOM, executes the real inline
 * script against it, and drives the flows that matter:
 *
 *   boot (no session)    -> login view
 *   boot (session)       -> admin view
 *   click 🎯 HUNT        -> hunt view, /hunt in the URL, overview fetched
 *   boot on /hunt        -> hunt view directly
 *   click back           -> admin view, / in the URL
 *
 *   npm run check:ui
 *
 * A developer tool: it is not bundled into the Worker.
 */

import { readFileSync } from 'node:fs';

/* ------------------------------------------------------------ the page --- */

const source = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
// The module exports a single template literal; evaluating it is the only way
// to see exactly what the browser gets, escapes resolved and all.
const html = eval(`${source.replace('export const APP_HTML', 'const APP_HTML')}; APP_HTML`);
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* --------------------------------------------------------- the tiny DOM -- */

class El {
  constructor(tag = 'div', cls = '') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._text = '';
    this.className = cls;
    this.style = {};
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.listeners = {};
    this.classList = {
      add: (c) => {
        if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim();
      },
      remove: (c) => {
        this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' ');
      },
      toggle: (c, on) => (on === undefined ? !this.classList.contains(c) : on)
        ? this.classList.add(c)
        : this.classList.remove(c),
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  get textContent() {
    return this._text || this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get lastChild() {
    return this.children[this.children.length - 1];
  }
  append(...nodes) {
    for (const node of nodes) this.children.push(node);
    this._text = '';
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  click() {
    if (typeof this.onclick === 'function') return this.onclick();
    for (const fn of this.listeners.click ?? []) fn();
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

/** Every element the page declares an id for, with its initial classes. */
function buildDom() {
  const byId = new Map();
  for (const tag of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, name, attrs, id] = tag;
    const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
    byId.set(id, new El(name, cls));
  }
  return byId;
}

/* ------------------------------------------------------------- harness --- */

function run({ path = '/', hash = '', session = true } = {}) {
  const byId = buildDom();
  const calls = [];
  const errors = [];

  const location = { pathname: path, hash, href: `https://panel.test${path}${hash}`, assign(u) { this.pathname = u; } };
  const history = {
    pushState(_state, _title, url) {
      const [p, h = ''] = String(url).split('#');
      location.pathname = p || '/';
      location.hash = h ? `#${h}` : '';
    },
  };

  const fetchStub = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    const body = (payload, status = 200) => ({
      status,
      ok: status < 400,
      json: async () => payload,
    });
    if (String(url).includes('/api/auth/session')) {
      return session ? body({ ok: true }) : body({ error: 'unauthorized' }, 401);
    }
    if (String(url).includes('/api/security/overview')) {
      return body({
        destination: { configured: false, source: null, masked: null, botTokenConfigured: true },
        schedule: { cron: '30 16 * * *', description: 'daily, 20:00 Asia/Tehran' },
        llm: { providers: [], configured: false },
        lastRun: null,
        claim: { date: '2026-10-05', status: null, detail: null },
        seen: { total: 0, last24h: 0 },
        recent: [],
        sources: [{ id: 'exploit-db', name: 'Exploit-DB', kind: 'exploit', host: 'www.exploit-db.com', enabled: true, maxItems: 6, staleHours: 96 }],
        rejected: [{ name: 'HackerOne Hacktivity', reason: 'no feed' }],
      });
    }
    if (String(url).includes('/api/security/feeds/probe')) {
      return body({
        ok: true,
        feeds: [{ id: 'exploit-db', name: 'Exploit-DB', host: 'www.exploit-db.com', ok: true, items: 3, kept: 2, fresh: 2, newestAgeHours: 4, stale: false, samples: [{ title: 'IDOR', link: 'https://x.test/1', kept: true }] }],
      });
    }
    if (String(url).includes('/api/security/run')) {
      return body({ ok: true, status: 'skipped', reason: 'dry_run', dryRun: true, items: 3, candidates: 2, fresh: 2, selected: 0, messages: 0, feedsOk: 6, feedsFailed: 0, preview: ['🛡 Security Writeups — 5 Oct 2026'] });
    }
    if (String(url).includes('/api/channels')) return body({ channels: [] });
    if (String(url).includes('/api/status')) {
      return body({
        cron: { lastRun: null, runs24h: 0, failedRuns24h: 0 },
        channels: { enabled: 0, total: 0 },
        messages: {},
        ai: {},
        publishing: { destinationConfigured: false },
        processing: { collectionOnly: false },
        recentErrors: [],
      });
    }
    if (String(url).includes('/api/settings')) return body({ collectionOnly: false });
    if (String(url).includes('/api/models')) return body({ models: [], selected: null, pinned: null });
    return body({ ok: true });
  };

  const sandbox = {
    document: {
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tag) => new El(tag),
      addEventListener: () => {},
    },
    window: {
      listeners: {},
      addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
      },
    },
    location,
    history,
    fetch: fetchStub,
    setInterval: () => 0,
    setTimeout: (fn) => fn(),
    confirm: () => true,
    alert: () => {},
    console: { log: () => {}, error: (...args) => errors.push(args.join(' ')) },
  };

  const fn = new Function(...Object.keys(sandbox), script);
  fn(...Object.values(sandbox));

  return { byId, calls, errors, location, sandbox, $: (id) => byId.get(id) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* --------------------------------------------------------------- checks -- */

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('\nadmin panel · scripts/check-ui.mjs\n');

{
  console.log('boot without a session');
  const app = run({ session: false });
  await tick();
  await tick();
  check('login view is shown', !app.$('loginView').classList.contains('hidden'));
  check('admin view stays hidden', app.$('appView').classList.contains('hidden'));
  check('hunt view stays hidden', app.$('huntView').classList.contains('hidden'));
  check('no script errors', app.errors.length === 0, app.errors[0]);
}

{
  console.log('\nboot with a session, then click 🎯 HUNT');
  const app = run({ session: true });
  await tick();
  await tick();
  check('admin view is shown', !app.$('appView').classList.contains('hidden'));
  check('hunt button exists', Boolean(app.$('huntBtn')));

  app.$('huntBtn').click();
  await tick();
  await tick();

  check('hunt view is shown', !app.$('huntView').classList.contains('hidden'));
  check('admin view is hidden', app.$('appView').classList.contains('hidden'));
  check('url is /hunt', app.location.pathname === '/hunt', app.location.pathname);
  check('overview was fetched', app.calls.some((c) => c.url.includes('/api/security/overview')));
  check('status tiles rendered', app.$('huntStatus').children.length > 3);
  check(
    'diagnosis names the missing channel',
    app.$('huntDiag').textContent.includes('No destination channel'),
    app.$('huntDiag').textContent
  );

  app.$('huntProbeBtn').click();
  await tick();
  await tick();
  check('feed probe ran', app.calls.some((c) => c.url.includes('/feeds/probe')));
  check('feed rows rendered', app.$('huntFeeds').children.length > 0);

  app.$('huntPreviewBtn').click();
  await tick();
  await tick();
  check('preview ran', app.calls.some((c) => c.url.includes('/api/security/run')));
  check('preview text is visible', !app.$('huntPreview').classList.contains('hidden'));
  check(
    'preview shows the digest',
    app.$('huntPreview').textContent.includes('Security Writeups'),
    app.$('huntPreview').textContent
  );

  app.$('huntBackBtn').click();
  await tick();
  check('back returns to the admin view', !app.$('appView').classList.contains('hidden'));
  check('url is /', app.location.pathname === '/', app.location.pathname);
  check('no script errors', app.errors.length === 0, app.errors[0]);
}

{
  console.log('\nthe second entry point, in ابزارها و آزمون');
  const app = run({ session: true });
  await tick();
  await tick();
  app.$('huntOpenBtn').click();
  await tick();
  check('tools button opens the console', !app.$('huntView').classList.contains('hidden'));
}

{
  console.log('\nloading /hunt directly');
  const app = run({ path: '/hunt', session: true });
  await tick();
  await tick();
  check('hunt view opens on boot', !app.$('huntView').classList.contains('hidden'));
  check('overview was fetched', app.calls.some((c) => c.url.includes('/api/security/overview')));
}

{
  console.log('\nthe legacy #hunt link still works');
  const app = run({ path: '/', hash: '#hunt', session: true });
  await tick();
  await tick();
  check('hunt view opens on boot', !app.$('huntView').classList.contains('hidden'));
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
