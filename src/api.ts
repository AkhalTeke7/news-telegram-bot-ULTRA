import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import {
  clearSessionCookie,
  createSessionToken,
  isAuthenticated,
  sessionCookie,
  timingSafeEqual,
} from './auth';
import {
  deleteChannel,
  listChannels,
  setChannelEnabled,
} from './channels';
import { runNewsPipeline } from './pipeline';
import { getFreeModelCatalog, setPinnedModel } from './modelManager';
import { AiError } from './openrouter';
import { isCollectionOnly, setCollectionOnly } from './processingMode';
import { resolveDestination } from './publisher';
import { addSourceChannel } from './sourceChannels';
import { getChannelStats, getStatusReport } from './status';
import { sendTestImage } from './testImage';
import { sendTestMessage } from './testMessage';
import { handleWebhook, type WaitUntilCtx } from './telegramAdmin';
import { isProductionHost, registerTelegramWebhook } from './telegramSetup';
import type { Env } from './types';

const BODY_LIMIT = 8 * 1024;

type Bindings = { Bindings: Env };

const fail = (c: Context, status: number, error: string) => c.json({ error }, status as 400);

/**
 * Reads a JSON body. The content-type requirement is deliberate: a cross-site
 * form/fetch cannot set application/json without a CORS preflight, so a
 * JSON-only body rule blocks CSRF even if the cookie flags were ever relaxed.
 */
async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) return null;

  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > BODY_LIMIT) return null;

  const raw = await c.req.text();
  if (raw.length > BODY_LIMIT) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseId(raw: string): number | null {
  if (!/^[0-9]{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function createApi(): Hono<Bindings> {
  const app = new Hono<Bindings>();

  // Public: liveness, Telegram webhook (own secret check), login.
  // Everything else under /api requires a valid admin session.
  app.get('/api/health', (c) => c.json({ ok: true }));

  app.all('/api/telegram/webhook', async (c) => {
    // Hono throws when no execution context is present (e.g. direct unit tests);
    // handleWebhook handles a missing context by processing inline.
    let exec: WaitUntilCtx | undefined;
    try {
      exec = c.executionCtx;
    } catch {
      exec = undefined;
    }
    const result = await handleWebhook(c.req.raw, c.env, exec);
    return c.json(
      result.handled ? { ok: true } : { ok: false },
      result.status as 200
    );
  });

  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c);
    const password = body?.password;
    const configured = c.env.ADMIN_PASSWORD;

    if (!configured) return fail(c, 503, 'رمز مدیر روی سرور تنظیم نشده است.');
    if (typeof password !== 'string' || !timingSafeEqual(password, configured)) {
      return fail(c, 401, 'رمز مدیر نادرست است.');
    }

    const token = await createSessionToken(configured);
    c.header('set-cookie', sessionCookie(token), { append: true });
    return c.json({ ok: true });
  });

  app.use('/api/*', async (c, next) => {
    if (!(await isAuthenticated(c.req.raw, c.env.ADMIN_PASSWORD))) {
      return fail(c, 401, 'برای ادامه وارد شوید.');
    }
    await next();
  });

  app.post('/api/auth/logout', (c) => {
    c.header('set-cookie', clearSessionCookie(), { append: true });
    return c.json({ ok: true });
  });

  app.get('/api/auth/session', (c) =>
    c.json({ authenticated: true, csrfHeader: 'content-type' })
  );

  app.get('/api/channels', async (c) => {
    const channels = await listChannels(c.env.DB);
    const stats = await getChannelStats(c.env.DB);
    return c.json({
      channels: channels.map((channel) => ({
        ...channel,
        stats: stats.get(channel.id) ?? { messages: 0, summarized: 0, published: 0, pending: 0 },
      })),
    });
  });

  app.get('/api/status', async (c) => {
    const report = await getStatusReport(c.env.DB, {
      destinationConfigured: resolveDestination(c.env) !== null,
    });
    return c.json(report);
  });

  // Processing mode: "collection only" means the hourly run just fetches and
  // stores raw news — no ad filter, no summarization, no ranking, no publish.
  // Persisted in ai_settings, so it survives deploys. Never a secret.
  app.get('/api/settings', async (c) => {
    return c.json({ collectionOnly: await isCollectionOnly(c.env.DB) });
  });

  app.post('/api/settings', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'بدنه درخواست باید JSON معتبر و کوچک باشد.');
    if (typeof body.collectionOnly !== 'boolean') {
      return fail(c, 400, 'فیلد collectionOnly باید مقدار true یا false داشته باشد.');
    }
    await setCollectionOnly(c.env.DB, body.collectionOnly);
    return c.json({ collectionOnly: body.collectionOnly });
  });

  /**
   * FREE model catalog + manual selection.
   *
   * GET  /api/models              → cached list, current + pinned model
   * GET  /api/models?refresh=1    → re-queries OpenRouter first
   * POST /api/models { model }    → pin one free model ("" / null = automatic)
   *
   * Only ids proven free by discovery can be pinned; the free-only rule is
   * enforced in setPinnedModel(), never here.
   */
  app.get('/api/models', async (c) => {
    const refresh = ['1', 'true', 'yes'].includes((c.req.query('refresh') ?? '').toLowerCase());
    try {
      const catalog = await getFreeModelCatalog(c.env.DB, { refresh });
      return c.json(catalog);
    } catch (error) {
      if (refresh && error instanceof AiError) {
        // The refresh failed: still answer with the cached catalog so the admin
        // panel degrades instead of breaking.
        const catalog = await getFreeModelCatalog(c.env.DB);
        return c.json({ ...catalog, refreshError: error.category });
      }
      throw error;
    }
  });

  app.post('/api/models', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'بدنه درخواست باید JSON معتبر و کوچک باشد.');

    const raw = body.model;
    if (raw !== null && typeof raw !== 'string') {
      return fail(c, 400, 'فیلد model باید رشته یا null باشد.');
    }
    if (typeof raw === 'string' && raw.length > 200) {
      return fail(c, 400, 'شناسهٔ مدل بیش از حد طولانی است.');
    }

    const outcome = await setPinnedModel(c.env.DB, raw);
    if (outcome === 'unknown_model') {
      return fail(c, 422, 'این مدل در فهرست مدل‌های رایگان نیست. ابتدا فهرست را به‌روزرسانی کنید.');
    }
    const catalog = await getFreeModelCatalog(c.env.DB);
    return c.json({ ...catalog, outcome });
  });

  /**
   * Manual pipeline run from the admin panel. Runs inline and returns the
   * outcome summary (counts and safe categories only). body.mode:
   *  - 'collect' → force a collection-only run (raw news, no processing)
   *  - 'process' → force the full collect → filter → summarize → rank → publish
   *  - omitted   → follow the stored collection-only setting
   * The override affects this run only; the stored setting is never changed.
   */
  app.post('/api/pipeline/run', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'بدنه درخواست باید JSON معتبر و کوچک باشد.');

    let modeOverride: 'collect' | 'process' | undefined;
    if (body.mode !== undefined) {
      if (body.mode !== 'collect' && body.mode !== 'process') {
        return fail(c, 400, 'مقدار mode باید «collect» یا «process» باشد.');
      }
      modeOverride = body.mode;
    }

    const outcome = await runNewsPipeline(c.env.DB, c.env, {
      trigger: 'manual-ui',
      modeOverride,
    });
    return c.json({
      ok: outcome.status !== 'failed',
      status: outcome.status,
      collectionOnly: outcome.collectionOnly,
      ranAt: outcome.ranAt,
      durationMs: outcome.durationMs,
      collection: outcome.collection,
      filteredAdvertisements: outcome.filteredAdvertisements,
      summarization: outcome.summarization,
      ranking: outcome.ranking,
      publishing: outcome.publishing,
      itemFailures: outcome.itemFailures,
      errors: outcome.errors,
    });
  });

  app.post('/api/channels', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'بدنه درخواست باید JSON معتبر و کوچک باشد.');

    // Shared with the Telegram admin interface so validation lives in one place.
    const result = await addSourceChannel(c.env.DB, {
      token: c.env.TELEGRAM_BOT_TOKEN,
      rawInput: body.username ?? body.url,
    });

    switch (result.code) {
      case 'added':
        return c.json({ channel: result.channel }, 201);
      case 'duplicate':
        return fail(c, 409, 'این کانال قبلاً ثبت شده است.');
      case 'not_public_channel':
        return fail(c, 422, `کانال یافت نشد یا عمومی نیست.`);
      case 'telegram_unavailable':
        return fail(c, 502, 'ارتباط با تلگرام برقرار نشد. بعداً دوباره تلاش کنید.');
      default:
        return fail(c, 400, result.message);
    }
  });

  app.patch('/api/channels/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return fail(c, 400, 'شناسه کانال معتبر نیست.');

    const body = await readJson(c);
    if (!body) return fail(c, 400, 'بدنه درخواست باید JSON معتبر و کوچک باشد.');
    if (typeof body.enabled !== 'boolean') {
      return fail(c, 400, 'فیلد enabled باید مقدار true یا false داشته باشد.');
    }

    const updated = await setChannelEnabled(c.env.DB, id, body.enabled);
    if (!updated) return fail(c, 404, 'کانال یافت نشد.');
    return c.json({ channel: updated });
  });

  // TEMPORARY: registers the Telegram webhook for this Worker. Authenticated by
  // the admin session above and additionally restricted to the production host.
  app.post('/api/telegram/setup-webhook', async (c) => {
    const hostname = new URL(c.req.url).hostname;
    if (!isProductionHost(hostname)) {
      return fail(c, 403, 'این endpoint فقط روی دامنه production فعال است.');
    }
    const outcome = await registerTelegramWebhook(c.env);
    return c.json(outcome.body, outcome.status as 200);
  });

  // Sends one clearly-marked test message to the configured destination so the
  // admin can verify token + destination + channel admin rights without a cron
  // run. Authenticated by the admin session; the response never contains the
  // destination value or the token.
  app.post('/api/telegram/test-message', async (c) => {
    const result = await sendTestMessage(c.env);
    if (result.ok) {
      return c.json({ ok: true, messageId: result.messageId });
    }
    switch (result.category) {
      case 'destination_not_configured':
      case 'invalid_destination':
      case 'token_missing':
        // Server-side configuration problem, not a Telegram failure.
        return fail(c, 503, result.message);
      case 'rate_limited':
        return fail(c, 429, result.message);
      default:
        return fail(c, 502, result.message);
    }
  });

  // Renders the REAL pending news into the run image and sends ONLY that image
  // to the configured destination — a diagnostic for the Browser Run → sendPhoto
  // path. Nothing is marked published and no text digests are sent.
  // Authenticated by the admin session; the response never contains the
  // destination value or the token.
  app.post('/api/telegram/test-image', async (c) => {
    const result = await sendTestImage(c.env);
    if (result.ok) {
      return c.json({
        ok: true,
        messageId: result.messageId,
        cards: result.cards,
        ticker: result.ticker,
        bytes: result.bytes,
      });
    }
    switch (result.category) {
      case 'no_news':
        return fail(c, 404, result.message);
      case 'destination_not_configured':
      case 'invalid_destination':
      case 'token_missing':
      case 'browser_missing':
        // Server-side configuration problem, not a Telegram/Browser failure.
        return fail(c, 503, result.message);
      case 'rate_limited':
        return fail(c, 429, result.message);
      default:
        return fail(c, 502, result.message);
    }
  });

  app.delete('/api/channels/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return fail(c, 400, 'شناسه کانال معتبر نیست.');

    const deleted = await deleteChannel(c.env.DB, id);
    if (!deleted) return fail(c, 404, 'کانال یافت نشد.');
    return c.body(null, 204);
  });

  app.all('/api/*', (c) => fail(c, 404, 'مسیر مورد نظر یافت نشد.'));

  app.onError((err, c) => {
    console.error('API error', err);
    return fail(c, 500, 'خطای داخلی سرور.');
  });

  return app;
}

export type { Next };
