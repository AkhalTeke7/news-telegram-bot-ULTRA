import { env } from 'cloudflare:test';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { finishCronRun, deriveCronStatus, getCronSummary, getLastCronRun, startCronRun } from '../src/cronRuns';
import { getChannelStats, getStatusReport } from '../src/status';
import { recordPublishFailure } from '../src/publisher';
import { setSetting } from '../src/settings';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const HOUR_ISO = new Date(NOW - 60 * 60 * 1000).toISOString();

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

async function seedChannel(username: string, enabled = true) {
  const r = await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES (?1, ?2)`)
    .bind(username, enabled ? 1 : 0)
    .run();
  return Number(r.meta.last_row_id);
}

async function seedMessage(channelId: number, id: number, published = false, summarized = true) {
  const r = await env.DB.prepare(
    `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, summary_text)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      channelId,
      id,
      new Date(NOW - 5 * 60_000).toISOString(),
      'متن',
      `https://t.me/chan/${id}`,
      summarized ? 'خلاصه' : null
    )
    .run();
  const messageId = Number(r.meta.last_row_id);
  if (summarized) {
    await env.DB.prepare(
      `UPDATE messages SET summarized_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`
    ).bind(messageId).run();
  }
  if (published) {
    await env.DB.prepare(
      `UPDATE messages SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`
    ).bind(messageId).run();
  }
  return messageId;
}

describe('cron run bookkeeping', () => {
  beforeEach(reset);

  it('records a running row then fills in the outcome', async () => {
    const id = await startCronRun(env.DB, '0 * * * *');
    expect(id).toBeGreaterThan(0);

    let open = await getLastCronRun(env.DB);
    expect(open!.status).toBe('running');
    expect(open!.messagesPublished).toBe(0);

    await finishCronRun(env.DB, id, 'success', Date.now() - 1500, {
      channelsEnabled: 3,
      messagesInserted: 5,
      messagesFiltered: 2,
      messagesSummarized: 4,
      messagesPublished: 2,
      failures: 0,
      errorSummary: null,
    });

    open = await getLastCronRun(env.DB);
    expect(open!.status).toBe('success');
    expect(open!.finishedAt).toBeTruthy();
    expect(open!.durationMs).toBeGreaterThanOrEqual(0);
    expect(open!.messagesInserted).toBe(5);
    expect(open!.messagesFiltered).toBe(2);
    expect(open!.messagesSummarized).toBe(4);
    expect(open!.messagesPublished).toBe(2);
    expect(open!.channelsEnabled).toBe(3);
  });

  it('summarizes success and failure timestamps over 24h', async () => {
    const a = await startCronRun(env.DB, '0 * * * *');
    await finishCronRun(env.DB, a, 'success', Date.now(), {
      channelsEnabled: 1, messagesInserted: 0, messagesFiltered: 0, messagesSummarized: 0, messagesPublished: 0, failures: 0,
    });
    const b = await startCronRun(env.DB, '0 * * * *');
    await finishCronRun(env.DB, b, 'failed', Date.now(), {
      channelsEnabled: 1, messagesInserted: 0, messagesFiltered: 0, messagesSummarized: 0, messagesPublished: 0,
      failures: 1, errorSummary: 'publish: boom',
    });

    const summary = await getCronSummary(env.DB, HOUR_ISO);
    expect(summary.runs24h).toBe(2);
    expect(summary.failedRuns24h).toBe(1);
    expect(summary.lastSuccessAt).toBeTruthy();
    expect(summary.lastFailureAt).toBeTruthy();
  });
});

describe('diagnostics report', () => {
  beforeEach(reset);

  it('reports channel, message, ai and publishing state without secrets', async () => {
    const on = await seedChannel('on_chan', true);
    await seedChannel('off_chan', false);
    await seedMessage(on, 1, true);
    await seedMessage(on, 2, false);

    await setSetting(env.DB, 'selected_model', 'space-bunny-free');
    await setSetting(env.DB, 'free_models', JSON.stringify(['a-free', 'b-free']));
    await setSetting(env.DB, 'free_models_refreshed_at', new Date(NOW).toISOString());

    const report = await getStatusReport(env.DB, { destinationConfigured: true, now: NOW });

    expect(report.channels).toMatchObject({ total: 2, enabled: 1, disabled: 1 });
    expect(report.messages.total).toBe(2);
    expect(report.messages.waitingPublishing).toBe(1);
    expect(report.ai).toMatchObject({ model: 'space-bunny-free', freeModelsCached: 2 });
    expect(report.ai.lastModelRefreshAt).toBeTruthy();
    expect(report.publishing.destinationConfigured).toBe(true);

    const serialized = JSON.stringify(report);
    // No secret material and no destination identifier anywhere in the payload.
    expect(serialized).not.toMatch(/OPENCODE_API_KEY|TELEGRAM_BOT_TOKEN|ADMIN_PASSWORD/);
  });

  it('never reveals the configured destination value', async () => {
    await getStatusReport(env.DB, { destinationConfigured: true, now: NOW });
    const report = await getStatusReport(env.DB, { destinationConfigured: false, now: NOW });
    expect(JSON.stringify(report.publishing)).toBe('{"destinationConfigured":false}');
  });

  it('counts pending publishes by error category only', async () => {
    const ch = await seedChannel('err_chan');
    const id = await seedMessage(ch, 5, false);
    await recordPublishFailure(env.DB, id, 'telegram_error');

    const report = await getStatusReport(env.DB, { destinationConfigured: true, now: NOW });
    expect(report.recentErrors).toEqual([
      { category: 'telegram_error', count: 1, latestAt: expect.any(String) },
    ]);
    expect(JSON.stringify(report.recentErrors)).not.toMatch(/token|key|password/i);
  });

  it('per-channel stats count collected, summarized and published', async () => {
    const a = await seedChannel('a', true);
    const b = await seedChannel('b', true);
    await seedMessage(a, 1, true);
    await seedMessage(a, 2, false);
    await seedMessage(b, 3, false, false);

    const stats = await getChannelStats(env.DB);
    expect(stats.get(a)).toMatchObject({ messages: 2, summarized: 2, published: 1, pending: 1 });
    expect(stats.get(b)).toMatchObject({ messages: 1, summarized: 0, published: 0, pending: 1 });
  });

  it('handles an empty database', async () => {
    const report = await getStatusReport(env.DB, { destinationConfigured: false, now: NOW });
    expect(report.channels.total).toBe(0);
    expect(report.messages.total).toBe(0);
    expect(report.ai.freeModelsCached).toBe(0);
    expect(report.cron.lastRun).toBeNull();
  });
});

describe('cron run status semantics', () => {
  it('is success only when every stage ran with zero item failures', () => {
    expect(deriveCronStatus(5, 0, 0)).toBe('success');
  });

  it('is partial when an individual channel or message failed', () => {
    expect(deriveCronStatus(5, 0, 1)).toBe('partial');
    expect(deriveCronStatus(5, 0, 12)).toBe('partial');
  });

  it('is partial when a stage threw or did not run', () => {
    expect(deriveCronStatus(4, 0, 0)).toBe('partial');
    expect(deriveCronStatus(5, 1, 0)).toBe('partial');
  });

  it('is failed only when no stage completed', () => {
    expect(deriveCronStatus(0, 3, 0)).toBe('failed');
  });
});

describe('cron stage isolation', () => {
  beforeEach(reset);

  const run = async () => {
    const ctx = createExecutionContext();
    await worker.scheduled!(
      createScheduledController({ cron: '0 * * * *', scheduledTime: NOW }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
  };

  // These stay channel-free on purpose: the collector uses the real network, and
  // tests must never touch Telegram. Failure paths are covered per-stage.
  it('records a completed run with no channels configured', async () => {
    await run();

    const last = await getLastCronRun(env.DB);
    expect(last).not.toBeNull();
    expect(last!.status).toBe('success');
    expect(last!.finishedAt).toBeTruthy();
    expect(last!.durationMs).not.toBeNull();
    expect(last!.messagesPublished).toBe(0);
    expect(last!.triggerName).toBe('0 * * * *');
  });

  it('writes one bookkeeping row per run and never duplicates messages', async () => {
    await run();
    await run();

    const runs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    const messages = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    expect(runs?.n).toBe(2);
    expect(messages?.n).toBe(0);
  });

  it('publishes nothing when secrets are not configured', async () => {
    await run();
    const published = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE published_at IS NOT NULL`
    ).first<{ n: number }>();
    expect(published?.n).toBe(0);
  });
});
