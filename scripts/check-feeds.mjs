/**
 * Health check for every RSS/Atom feed the bot depends on:
 * `src/breaking/sources.ts` (finance) and `src/security/sources.ts` (writeups).
 *
 *   npm run check:feeds
 *
 * For each source it reports HTTP status, redirects, how many items parsed,
 * how old the newest item is, and how many of them the keyword pre-filter
 * would currently pass. A feed that answers 200 but is FROZEN is the
 * dangerous case — it looks healthy while silently never producing news — so
 * staleness is flagged loudly.
 *
 * Exits non-zero if any enabled feed is broken or stale, which makes it
 * usable in CI.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STALE_HOURS = 48;
const TIMEOUT_MS = 15_000;

const outDir = join(tmpdir(), `feedcheck-${process.pid}`);
mkdirSync(outDir, { recursive: true });
const entry = join(outDir, 'entry.ts');
const outFile = join(outDir, 'bundle.mjs');
const src = (f) => JSON.stringify(join(process.cwd(), 'src/breaking', f));
const sec = (f) => JSON.stringify(join(process.cwd(), 'src/security', f));

writeFileSync(
  entry,
  `export { BREAKING_SOURCES, REJECTED_SOURCES } from ${src('sources.ts')};
export { parseFeed } from ${src('rss.ts')};
export { prefilter } from ${src('filter.ts')};
export {
  SECURITY_SOURCES,
  REJECTED_SOURCES as SECURITY_REJECTED,
} from ${sec('sources.ts')};
export { evaluate } from ${sec('filter.ts')};
`
);

execFileSync(
  'node_modules/.bin/esbuild',
  [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${outFile}`, '--log-level=warning'],
  { stdio: 'inherit' }
);

const {
  BREAKING_SOURCES,
  REJECTED_SOURCES,
  parseFeed,
  prefilter,
  SECURITY_SOURCES,
  SECURITY_REJECTED,
  evaluate,
} = await import(pathToFileURL(outFile).href);

const pad = (value, width) => String(value).padEnd(width);
const hoursAgo = (date, now) => (now - date.getTime()) / 3_600_000;

/**
 * `kept` differs per group: the finance feeds are judged by the keyword
 * pre-filter, the security feeds by the relevance filter. Both answer the
 * same question — how much of this feed would actually reach a channel.
 */
async function checkGroup(label, sources, keptFor) {
  console.log(`\n=== ${label}: ${sources.length} feeds ===\n`);
  const rows = [];

  for (const source of sources) {
    const started = Date.now();
    const row = { id: source.id, name: source.name, verdict: '?', detail: '' };
    try {
      const res = await fetch(source.url, {
        headers: {
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          'user-agent': 'Mozilla/5.0 (compatible; NewsBreakingBot/1.0)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const ms = Date.now() - started;
      if (!res.ok) {
        row.verdict = '❌ DEAD';
        row.detail = `HTTP ${res.status}`;
      } else {
        const body = await res.text();
        const entries = parseFeed(body);
        const dated = entries.filter((e) => e.publishedAt).map((e) => e.publishedAt);
        const newest = dated.length ? new Date(Math.max(...dated.map((d) => d.getTime()))) : null;
        const age = newest ? hoursAgo(newest, now) : null;
        const kept = keptFor(entries, source);

        if (entries.length === 0) {
          row.verdict = '❌ EMPTY';
          // The failure mode that matters: a 200 that is really an HTML page.
          row.detail = /^\s*<!doctype html|<html/i.test(body)
            ? `200 in ${ms}ms but the body is HTML, not a feed`
            : `200 in ${ms}ms, 0 items parsed`;
        } else if (age !== null && age > (source.staleHours ?? STALE_HOURS)) {
          row.verdict = '⚠️ STALE';
          row.detail = `newest item ${age.toFixed(0)}h old — DROP THIS FEED`;
        } else {
          row.verdict = '✅ OK';
          row.detail = `${entries.length} items, newest ${
            age === null ? 'undated' : `${age.toFixed(1)}h ago`
          }, ${kept} kept, ${ms}ms`;
        }
        if (res.redirected) row.detail += ` (redirected -> ${res.url})`;
      }
    } catch (error) {
      row.verdict = '❌ ERROR';
      row.detail =
        error?.name === 'TimeoutError'
          ? `timeout after ${TIMEOUT_MS}ms`
          : String(error?.message ?? error);
    }
    rows.push(row);
    console.log(`${pad(row.verdict, 10)} ${pad(row.name, 24)} ${row.detail}`);
  }
  return rows;
}

const now = Date.now();

const financeRows = await checkGroup('finance / breaking news', BREAKING_SOURCES, (entries) =>
  entries.filter((e) => prefilter(e.title, e.description).passed).length
);

const securityRows = await checkGroup('security writeups', SECURITY_SOURCES, (entries, source) =>
  entries.filter((e) => evaluate(e, source).keep).length
);

const rows = [...financeRows, ...securityRows];

console.log('\npreviously checked and rejected (do not re-add):');
for (const rejected of REJECTED_SOURCES) {
  console.log(`  ✗ ${pad(rejected.reason, 24)} ${rejected.url}`);
}
for (const rejected of SECURITY_REJECTED) {
  console.log(`  ✗ ${rejected.name}`);
  for (const url of rejected.tried) console.log(`      tried: ${url}`);
  console.log(`      ${rejected.reason}`);
}

const broken = rows.filter((row) => !row.verdict.startsWith('✅'));
console.log(`\n${rows.length - broken.length}/${rows.length} feeds healthy`);

rmSync(outDir, { recursive: true, force: true });
if (broken.length > 0) {
  console.error(`\n${broken.length} feed(s) need attention: ${broken.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
