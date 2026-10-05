/**
 * The HUNT console: the admin-facing half of the security / bug-bounty digest.
 *
 * The job itself is covered by `security.test.ts`. What is tested here is the
 * part that exists because the job is invisible: the overview an operator
 * reads, the live feed probe, the channel they can set without a redeploy, and
 * the three run modes (preview / send / force) — including the guarantees that
 * make a preview safe to press at any time.
 */

import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  buildSecurityOverview,
  getStoredSecurityChannel,
  maskChannel,
  probeSecurityFeeds,
  setStoredSecurityChannel,
} from '../src/security/admin';
import {
  loadSecurityDestination,
  normalizeSecurityChannel,
  runSecurityJob,
  SECURITY_CHANNEL_SETTING,
} from '../src/security/job';
import { SECURITY_SOURCES } from '../src/security/sources';
import { getSetting } from '../src/settings';

const BASE = 'https://worker.test';
const PASSWORD = 'test-admin-password';
const NOW = new Date('2026-10-05T17:00:00Z'); // 20:30 Tehran

/* ------------------------------------------------------------- fixtures -- */

const WRITEUPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[How I Tricked OpenClaw Into Attacking Its Own Network: A NAT64 SSRF Bypass]]></title>
    <description><![CDATA[A single misread pair of bytes let a public-looking IPv6 address point at 169.254.169.254.]]></description>
    <link>https://infosecwriteups.com/how-i-tricked-openclaw-9b93a7f11cd9</link>
    <pubDate>Mon, 05 Oct 2026 04:44:33 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[The moment it clicked]]></title>
    <description><![CDATA[A long read with no obvious keywords in the title at all.]]></description>
    <link>https://infosecwriteups.com/the-moment-it-clicked-abc123</link>
    <pubDate>Mon, 05 Oct 2026 03:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const EXPLOITDB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[[webapps] Krayin CRM 2.2.4 - IDOR]]></title>
    <link>https://www.exploit-db.com/exploits/52687</link>
    <pubDate>Mon, 05 Oct 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

/** A feed that answers 200 with an HTML login page — the dangerous failure. */
const DEAD_HTML = `<!doctype html><html><body>Log in to continue</body></html>`;

const xml = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/rss+xml' } });

/**
 * Stands in for the whole outside world: the six real feed URLs, OpenRouter
 * and Telegram. Anything else is a bug in the code under test.
 */
function stubWorld(opts: { sent?: string[]; telegramOk?: boolean; deadFeeds?: boolean } = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (url.includes('infosecwriteups.com')) {
      return opts.deadFeeds ? new Response(DEAD_HTML, { headers: { 'content-type': 'text/html' } }) : xml(WRITEUPS_XML);
    }
    if (url.includes('exploit-db.com')) return opts.deadFeeds ? new Response('nope', { status: 503 }) : xml(EXPLOITDB_XML);
    if (url.includes('intigriti.com') || url.includes('portswigger.net') || url.includes('github.com')) {
      return xml(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel></channel></rss>`);
    }
    if (url.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/sendMessage')) {
      opts.sent?.push(JSON.parse(String((init as RequestInit).body)).text as string);
      return opts.telegramOk === false
        ? new Response(JSON.stringify({ ok: false, description: 'CHAT_NOT_FOUND' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1, date: 0 } }), {
            headers: { 'content-type': 'application/json' },
          });
    }
    throw new Error(`unexpected call: ${url}`);
  };
  return { impl, calls };
}

const baseEnv = (over: Record<string, unknown> = {}) => ({
  ...env,
  TELEGRAM_BOT_TOKEN: 'T',
  TELEGRAM_DESTINATION_CHANNEL: '@main_channel',
  TIMEZONE: 'Asia/Tehran',
  OPENROUTER_API_KEY: 'sk-test',
  ...over,
});

async function login(): Promise<string> {
  const res = await worker.fetch(
    new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }),
    baseEnv() as never,
    createExecutionContext()
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string; env?: Record<string, unknown> } = {}
): Promise<Response> {
  const { cookie, env: envOver, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  return worker.fetch(
    new Request(`${BASE}${path}`, { ...rest, headers }),
    baseEnv(envOver) as never,
    createExecutionContext()
  );
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM security_seen`).run();
  await env.DB.prepare(`DELETE FROM job_claims`).run();
  await env.DB.prepare(`DELETE FROM job_runs`).run();
  await env.DB.prepare(`DELETE FROM llm_usage`).run();
  await env.DB.prepare(`DELETE FROM ai_settings WHERE key = ?1`).bind(SECURITY_CHANNEL_SETTING).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------- channel config -- */

describe('security channel configuration', () => {
  it('accepts the shapes Telegram actually uses', () => {
    expect(normalizeSecurityChannel('@my_sec_channel')).toBe('@my_sec_channel');
    expect(normalizeSecurityChannel('  @my_sec_channel  ')).toBe('@my_sec_channel');
    // A username typed without the @ is still a username.
    expect(normalizeSecurityChannel('my_sec_channel')).toBe('@my_sec_channel');
    expect(normalizeSecurityChannel('-1001234567890')).toBe('-1001234567890');
    expect(normalizeSecurityChannel('MAIN')).toBe('MAIN');
  });

  it('rejects anything that is not a channel', () => {
    for (const bad of ['', '   ', 'https://t.me/x', '@sh', 'two words', '@bad-char!', null, 42]) {
      expect(normalizeSecurityChannel(bad as never)).toBeNull();
    }
  });

  it('stores a valid channel and refuses an invalid one', async () => {
    const ok = await setStoredSecurityChannel(env.DB, 'hunt_writeups');
    expect(ok).toEqual({ ok: true, value: '@hunt_writeups' });
    expect(await getSetting(env.DB, SECURITY_CHANNEL_SETTING)).toBe('@hunt_writeups');

    const bad = await setStoredSecurityChannel(env.DB, 'https://t.me/hunt');
    expect(bad.ok).toBe(false);
    // The bad value never overwrites the good one.
    expect(await getStoredSecurityChannel(env.DB)).toBe('@hunt_writeups');

    await setStoredSecurityChannel(env.DB, null);
    expect(await getStoredSecurityChannel(env.DB)).toBeNull();
  });

  it('prefers the panel setting over the secret, and falls back when cleared', async () => {
    const e = baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@from_secret' }) as never;

    expect(await loadSecurityDestination(e)).toBe('@from_secret');

    await setStoredSecurityChannel(env.DB, '@from_panel');
    expect(await loadSecurityDestination(e)).toBe('@from_panel');

    // MAIN deliberately points the digest at the main news channel.
    await setStoredSecurityChannel(env.DB, 'MAIN');
    expect(await loadSecurityDestination(e)).toBe('@main_channel');

    await setStoredSecurityChannel(env.DB, null);
    expect(await loadSecurityDestination(e)).toBe('@from_secret');
  });

  it('never echoes a channel back in full', () => {
    expect(maskChannel('@my_security_channel')).toBe('@my…nel');
    expect(maskChannel('@my_security_channel')).not.toContain('security');
    expect(maskChannel(null)).toBeNull();
  });
});

/* ------------------------------------------------------------ overview --- */

describe('buildSecurityOverview', () => {
  it('reports the unconfigured deployment honestly', async () => {
    const o = await buildSecurityOverview(baseEnv({ TELEGRAM_SECURITY_CHANNEL: undefined }) as never, {
      now: NOW,
    });

    expect(o.destination.configured).toBe(false);
    expect(o.destination.source).toBeNull();
    expect(o.destination.masked).toBeNull();
    expect(o.destination.botTokenConfigured).toBe(true);
    expect(o.lastRun).toBeNull();
    expect(o.claim.status).toBeNull();
    expect(o.seen).toEqual({ total: 0, last24h: 0 });
    expect(o.sources).toHaveLength(SECURITY_SOURCES.length);
    expect(o.rejected.map((r) => r.name)).toContain('HackerOne Hacktivity');
  });

  it('says where the destination came from', async () => {
    const withSecret = await buildSecurityOverview(
      baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@from_secret' }) as never,
      { now: NOW }
    );
    expect(withSecret.destination).toMatchObject({ configured: true, source: 'secret' });

    await setStoredSecurityChannel(env.DB, '@from_panel');
    const withSetting = await buildSecurityOverview(
      baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@from_secret' }) as never,
      { now: NOW }
    );
    expect(withSetting.destination).toMatchObject({ configured: true, source: 'setting' });
    expect(withSetting.destination.masked).not.toContain('from_panel');
  });

  it('surfaces today\u2019s claim, the last run and the delivered ledger', async () => {
    await env.DB.prepare(
      `INSERT INTO job_claims (job, claim_date, status, detail) VALUES ('security', '2026-10-05', 'sent', '1 message(s)')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO job_runs (job, trigger, status, detail, finished_at, duration_ms)
       VALUES ('security', '30 16 * * *', 'success', 'feeds=6/6 messages=1', '2026-10-05T16:31:00.000Z', 4200)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO security_seen (item_key, source_id, title, link, seen_at)
       VALUES ('k1', 'exploit-db', 'Krayin CRM 2.2.4 - IDOR', 'https://www.exploit-db.com/exploits/52687', ?1)`
    )
      .bind(new Date(NOW.getTime() - 3_600_000).toISOString())
      .run();

    const o = await buildSecurityOverview(baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@sec_channel' }) as never, {
      now: NOW,
    });

    expect(o.claim.date).toBe('2026-10-05');
    expect(o.claim.status).toBe('sent');
    expect(o.lastRun?.status).toBe('success');
    expect(o.lastRun?.detail).toContain('messages=1');
    expect(o.seen).toEqual({ total: 1, last24h: 1 });
    expect(o.recent[0]).toMatchObject({ sourceId: 'exploit-db' });
    expect(o.schedule.cron).toBe('30 16 * * *');
  });
});

/* ---------------------------------------------------------- feed probe --- */

describe('probeSecurityFeeds', () => {
  it('reports items, what the filter keeps and what is new', async () => {
    const { impl } = stubWorld();
    const feeds = await probeSecurityFeeds(baseEnv() as never, { now: NOW, fetchImpl: impl });

    expect(feeds).toHaveLength(SECURITY_SOURCES.filter((s) => s.enabled).length);

    const writeups = feeds.find((f) => f.id === 'infosec-writeups')!;
    expect(writeups.ok).toBe(true);
    expect(writeups.items).toBe(2);
    expect(writeups.kept).toBeGreaterThan(0);
    expect(writeups.kept).toBeLessThanOrEqual(writeups.items);
    // Nothing has been posted yet, so everything kept is also new.
    expect(writeups.fresh).toBe(writeups.kept);
    expect(writeups.samples).toHaveLength(2);
    expect(writeups.samples[0].kept).toBe(true);
    expect(writeups.host).toBe('infosecwriteups.com');
  });

  it('counts an already-delivered item as no longer new', async () => {
    const { impl } = stubWorld();
    const before = await probeSecurityFeeds(baseEnv() as never, { now: NOW, fetchImpl: impl });
    expect(before.find((f) => f.id === 'exploit-db')!.fresh).toBe(1);

    // Deliver it, exactly as a real run would.
    await runSecurityJob(baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@sec_channel' }) as never, {
      now: NOW,
      fetchImpl: impl,
    });

    const after = await probeSecurityFeeds(baseEnv() as never, { now: NOW, fetchImpl: impl });
    const exploit = after.find((f) => f.id === 'exploit-db')!;
    expect(exploit.kept).toBe(1);
    expect(exploit.fresh).toBe(0);
  });

  it('flags a feed that is dead, and one that answers 200 with HTML', async () => {
    const { impl } = stubWorld({ deadFeeds: true });
    const feeds = await probeSecurityFeeds(baseEnv() as never, { now: NOW, fetchImpl: impl });

    const html = feeds.find((f) => f.id === 'infosec-writeups')!;
    expect(html.ok).toBe(true); // HTTP said 200 …
    expect(html.items).toBe(0); // … and the panel still shows it as empty.

    const broken = feeds.find((f) => f.id === 'exploit-db')!;
    expect(broken.ok).toBe(false);
    expect(broken.error).toBe('http_503');
  });

  it('marks a feed stale against its own cadence', async () => {
    const { impl } = stubWorld();
    // Ten days after the fixtures were published: fine for PortSwigger
    // (1440h), long past due for InfoSec Write-ups (48h).
    const later = new Date(NOW.getTime() + 10 * 86_400_000);
    const feeds = await probeSecurityFeeds(baseEnv() as never, { now: later, fetchImpl: impl });

    const writeups = feeds.find((f) => f.id === 'infosec-writeups')!;
    expect(writeups.stale).toBe(true);
    expect(writeups.newestAgeHours).toBeGreaterThan(200);
  });
});

/* -------------------------------------------------------- run modes ------ */

describe('manual run modes', () => {
  it('preview builds the digest and sends, claims and records NOTHING', async () => {
    const sent: string[] = [];
    const { impl } = stubWorld({ sent });

    const result = await runSecurityJob(baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@sec_channel' }) as never, {
      now: NOW,
      fetchImpl: impl,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.reason).toBe('dry_run');
    expect(result.preview?.[0]).toContain('Security Writeups');
    expect(result.preview?.[0]).toContain('NAT64 SSRF Bypass');
    expect(sent).toHaveLength(0);

    const claims = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_claims`).first<{ n: number }>();
    const seen = await env.DB.prepare(`SELECT COUNT(*) AS n FROM security_seen`).first<{ n: number }>();
    expect(claims?.n).toBe(0);
    expect(seen?.n).toBe(0);
  });

  it('previews even when no channel is configured — that is the point', async () => {
    const { impl } = stubWorld();
    const result = await runSecurityJob(
      baseEnv({ TELEGRAM_SECURITY_CHANNEL: undefined }) as never,
      { now: NOW, fetchImpl: impl, dryRun: true }
    );

    expect(result.destinationConfigured).toBe(false);
    expect(result.reason).toBe('dry_run');
    expect(result.preview?.length).toBeGreaterThan(0);
  });

  it('a preview does not consume the day: the real run still posts', async () => {
    const sent: string[] = [];
    const { impl } = stubWorld({ sent });
    const e = baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@sec_channel' }) as never;

    await runSecurityJob(e, { now: NOW, fetchImpl: impl, dryRun: true });
    const real = await runSecurityJob(e, { now: NOW, fetchImpl: impl });

    expect(real.status).toBe('success');
    expect(real.messages).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('a plain second run is refused, a forced one goes out', async () => {
    const sent: string[] = [];
    const { impl } = stubWorld({ sent });
    const e = baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@sec_channel' }) as never;

    const first = await runSecurityJob(e, { now: NOW, fetchImpl: impl });
    expect(first.status).toBe('success');

    const second = await runSecurityJob(e, { now: NOW, fetchImpl: impl });
    expect(second.alreadyClaimed).toBe(true);
    expect(second.forced).toBeUndefined();
    expect(sent).toHaveLength(1);

    // Everything fresh was delivered by the first run, so a force has nothing
    // left to say — which is itself the honest answer.
    const forced = await runSecurityJob(e, { now: NOW, fetchImpl: impl, force: true });
    expect(forced.reason).toBe('all_already_posted');
    expect(forced.forced).toBe(true);

    // With the ledger cleared, the same force really does post again.
    await env.DB.prepare(`DELETE FROM security_seen`).run();
    const again = await runSecurityJob(e, { now: NOW, fetchImpl: impl, force: true });
    expect(again.status).toBe('success');
    expect(again.forced).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('uses the channel saved in the panel', async () => {
    const { impl, calls } = stubWorld();
    await setStoredSecurityChannel(env.DB, '@panel_channel');

    const result = await runSecurityJob(
      baseEnv({ TELEGRAM_SECURITY_CHANNEL: '@secret_channel' }) as never,
      { now: NOW, fetchImpl: impl }
    );

    expect(result.status).toBe('success');
    expect(calls.some((url) => url.includes('/sendMessage'))).toBe(true);
  });
});

/* ------------------------------------------------------------- the API --- */

describe('HUNT API', () => {
  it('requires the admin session for every endpoint', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/security/overview'],
      ['POST', '/api/security/channel'],
      ['POST', '/api/security/feeds/probe'],
      ['POST', '/api/security/run'],
    ];
    for (const [method, path] of routes) {
      const res = await call(path, { method, body: method === 'GET' ? undefined : '{}' });
      expect([401, 403]).toContain(res.status);
    }
  });

  it('serves the overview without leaking the channel or the token', async () => {
    const cookie = await login();
    await setStoredSecurityChannel(env.DB, '@hunt_secret_channel');

    const res = await call('/api/security/overview', { cookie });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain('hunt_secret_channel');
    expect(body).not.toContain(PASSWORD);
    const data = JSON.parse(body);
    expect(data.destination).toMatchObject({ configured: true, source: 'setting' });
    expect(data.sources.length).toBeGreaterThan(0);
  });

  it('saves and clears the channel', async () => {
    const cookie = await login();

    const saved = await call('/api/security/channel', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ channel: 'hunt_writeups' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ ok: true, configured: true });
    expect(await getStoredSecurityChannel(env.DB)).toBe('@hunt_writeups');

    const cleared = await call('/api/security/channel', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ channel: null }),
    });
    expect(await cleared.json()).toMatchObject({ ok: true, configured: false });
    expect(await getStoredSecurityChannel(env.DB)).toBeNull();
  });

  it('rejects a junk channel with 400 and keeps the old one', async () => {
    const cookie = await login();
    await setStoredSecurityChannel(env.DB, '@good_channel');

    const res = await call('/api/security/channel', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ channel: 'https://t.me/hunt' }),
    });
    expect(res.status).toBe(400);
    expect(await getStoredSecurityChannel(env.DB)).toBe('@good_channel');

    const missing = await call('/api/security/channel', { method: 'POST', cookie, body: '{}' });
    expect(missing.status).toBe(400);
  });

  it('probes the live feeds', async () => {
    const cookie = await login();
    const { impl } = stubWorld();
    vi.stubGlobal('fetch', impl);

    const res = await call('/api/security/feeds/probe', { method: 'POST', cookie, body: '{}' });
    const data = (await res.json()) as { ok: boolean; feeds: { id: string; items: number }[] };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.feeds.find((f) => f.id === 'infosec-writeups')?.items).toBe(2);
  });

  it('runs a preview that sends nothing', async () => {
    const cookie = await login();
    const sent: string[] = [];
    vi.stubGlobal('fetch', stubWorld({ sent }).impl);

    const res = await call('/api/security/run', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ mode: 'preview' }),
      env: { TELEGRAM_SECURITY_CHANNEL: '@sec_channel' },
    });
    const data = (await res.json()) as { ok: boolean; preview: string[]; dryRun: boolean };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.dryRun).toBe(true);
    expect(data.preview[0]).toContain('Security Writeups');
    expect(sent).toHaveLength(0);
  });

  it('sends on demand, and rejects an unknown mode', async () => {
    const cookie = await login();
    const sent: string[] = [];
    vi.stubGlobal('fetch', stubWorld({ sent }).impl);
    await setStoredSecurityChannel(env.DB, '@hunt_channel');

    const res = await call('/api/security/run', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ mode: 'send' }),
    });
    const data = (await res.json()) as { ok: boolean; messages: number };
    expect(res.status).toBe(200);
    expect(data.messages).toBe(1);
    expect(sent).toHaveLength(1);

    const bad = await call('/api/security/run', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ mode: 'publish' }),
    });
    expect(bad.status).toBe(400);
  });
});

/* ------------------------------------------------------------- the view -- */

describe('the HUNT view inside the admin panel', () => {
  it('ships a hunt button, a hunt view and its own route', async () => {
    const res = await call('/');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('id="huntBtn"');
    expect(html).toContain('id="huntView"');
    expect(html).toContain('id="huntBackBtn"');
    // Reachable by URL, and switched client-side — no second login.
    expect(html).toContain("location.hash = '#hunt'");
    expect(html).toContain("hashchange");
    for (const id of ['huntStatus', 'huntFeeds', 'huntPreview', 'huntChannel', 'huntRecent']) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const path of [
      '/api/security/overview',
      '/api/security/channel',
      '/api/security/feeds/probe',
      '/api/security/run',
    ]) {
      expect(html).toContain(path);
    }
  });
});
