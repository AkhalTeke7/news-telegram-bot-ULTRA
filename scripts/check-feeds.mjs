/**
 * Health check for every breaking-news RSS feed in `src/breaking/sources.ts`.
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

writeFileSync(
  entry,
  `export { BREAKING_SOURCES, REJECTED_SOURCES } from ${src('sources.ts')};
export { parseFeed } from ${src('rss.ts')};
export { prefilter } from ${src('filter.ts')};
`
);

execFileSync(
  'node_modules/.bin/esbuild',
  [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${outFile}`, '--log-level=warning'],
  { stdio: 'inherit' }
);

const { BREAKING_SOURCES, REJECTED_SOURCES, parseFeed, prefilter } = await import(
  pathToFileURL(outFile).href
);

const pad = (value, width) => String(value).padEnd(width);
const hoursAgo = (date, now) => (now - date.getTime()) / 3_600_000;

console.log(`checking ${BREAKING_SOURCES.length} feeds…\n`);

const now = Date.now();
const rows = [];

for (const source of BREAKING_SOURCES) {
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
      const entries = parseFeed(await res.text());
      const dated = entries.filter((e) => e.publishedAt).map((e) => e.publishedAt);
      const newest = dated.length ? new Date(Math.max(...dated.map((d) => d.getTime()))) : null;
      const age = newest ? hoursAgo(newest, now) : null;
      const passing = entries.filter((e) => prefilter(e.title, e.description).passed).length;

      if (entries.length === 0) {
        row.verdict = '❌ EMPTY';
        row.detail = `200 in ${ms}ms, 0 items parsed`;
      } else if (age !== null && age > STALE_HOURS) {
        row.verdict = '⚠️ STALE';
        row.detail = `newest item ${age.toFixed(0)}h old — DROP THIS FEED`;
      } else {
        row.verdict = '✅ OK';
        row.detail = `${entries.length} items, newest ${
          age === null ? 'undated' : `${age.toFixed(1)}h ago`
        }, ${passing} pass pre-filter, ${ms}ms`;
      }
      if (res.redirected) row.detail += ` (redirected -> ${res.url})`;
    }
  } catch (error) {
    row.verdict = '❌ ERROR';
    row.detail = error?.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS}ms` : String(error?.message ?? error);
  }
  rows.push(row);
  console.log(`${pad(row.verdict, 10)} ${pad(row.name, 22)} ${row.detail}`);
}

console.log('\npreviously checked and rejected (do not re-add):');
for (const rejected of REJECTED_SOURCES) {
  console.log(`  ✗ ${pad(rejected.reason, 24)} ${rejected.url}`);
}

const broken = rows.filter((row) => !row.verdict.startsWith('✅'));
console.log(`\n${rows.length - broken.length}/${rows.length} feeds healthy`);

rmSync(outDir, { recursive: true, force: true });
if (broken.length > 0) {
  console.error(`\n${broken.length} feed(s) need attention: ${broken.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
