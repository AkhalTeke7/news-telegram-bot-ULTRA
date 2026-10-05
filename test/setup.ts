import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import messagesSql from '../migrations/0002_messages.sql?raw';
import aiSql from '../migrations/0003_ai_summaries.sql?raw';
import publishingSql from '../migrations/0004_publishing.sql?raw';
import cronRunsSql from '../migrations/0005_cron_runs.sql?raw';
import telegramAdminSql from '../migrations/0006_telegram_admin.sql?raw';
import adFilterSql from '../migrations/0007_ad_filter.sql?raw';
import titleImportanceSql from '../migrations/0008_title_importance.sql?raw';
import editorialSql from '../migrations/0009_ai_editorial_metadata.sql?raw';
import rssSourcesSql from '../migrations/0010_rss_sources.sql?raw';
import rssChannelSql from '../migrations/0011_rss_channel_metadata.sql?raw';
import scheduledJobsSql from '../migrations/0012_scheduled_jobs.sql?raw';

// ponytail: strips `--` comments, then splits on `;`. Still assumes no
// semicolons inside string literals in migration files; add a real SQL splitter
// if a migration ever stores text containing them.
const toQueries = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: '0001_init.sql', queries: toQueries(initSql) },
    { name: '0002_messages.sql', queries: toQueries(messagesSql) },
    { name: '0003_ai_summaries.sql', queries: toQueries(aiSql) },
    { name: '0004_publishing.sql', queries: toQueries(publishingSql) },
    { name: '0005_cron_runs.sql', queries: toQueries(cronRunsSql) },
    { name: '0006_telegram_admin.sql', queries: toQueries(telegramAdminSql) },
    { name: '0007_ad_filter.sql', queries: toQueries(adFilterSql) },
    { name: '0008_title_importance.sql', queries: toQueries(titleImportanceSql) },
    { name: '0009_ai_editorial_metadata.sql', queries: toQueries(editorialSql) },
    { name: '0010_rss_sources.sql', queries: toQueries(rssSourcesSql) },
    { name: '0011_rss_channel_metadata.sql', queries: toQueries(rssChannelSql) },
    { name: '0012_scheduled_jobs.sql', queries: toQueries(scheduledJobsSql) },
  ]);

  // Migration 0010 seeds default RSS sources (BBC Persian, ...). They must stay
  // disabled in tests: the suite is network-free, and an enabled source would
  // make every pipeline run record offline fetch failures (status 'partial').
  await env.DB.prepare(`UPDATE rss_sources SET enabled = 0`).run();
});
