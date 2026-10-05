/**
 * Prints the EXACT Telegram message the daily calendar job would send, using
 * the real Forex Factory feed. No Cloudflare account, no bot token, nothing
 * sent anywhere.
 *
 *   node scripts/preview-calendar.mjs                 # today, Asia/Tehran
 *   node scripts/preview-calendar.mjs 2026-10-07      # a specific local day
 *   node scripts/preview-calendar.mjs 2026-10-07 Europe/London
 *   node scripts/preview-calendar.mjs --file feed.json 2026-10-07
 *
 * `--file` reads a saved copy of the feed instead of the network, which is how
 * you reproduce a past day or test without egress.
 *
 * The analysis block (Task 4) is NOT included here: it needs an LLM key and a
 * live call. What you see is the guaranteed-deliverable part — the plain list
 * that ships even when every provider is down.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
let file = null;
const fileFlag = argv.indexOf('--file');
if (fileFlag !== -1) {
  file = argv[fileFlag + 1];
  argv.splice(fileFlag, 2);
}
const dateArg = argv[0] ?? null;
const timeZone = argv[1] ?? 'Asia/Tehran';

/* Bundle the TypeScript we need into a temp ESM module. */
const outDir = join(tmpdir(), `calendar-preview-${process.pid}`);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'calendar.mjs');
const entry = join(outDir, 'entry.ts');

import { writeFileSync } from 'node:fs';
writeFileSync(
  entry,
  `export { toCalendarEvents, selectTodayHighImpact, ForexFactoryFeedSchema, FOREX_FACTORY_URL } from ${JSON.stringify(
    join(process.cwd(), 'src/calendar/forexFactory.ts')
  )};
export { buildCalendarMessages } from ${JSON.stringify(join(process.cwd(), 'src/calendar/job.ts'))};
export { jalaliDate } from ${JSON.stringify(join(process.cwd(), 'src/lib/jalali.ts'))};
`
);

execFileSync(
  'node_modules/.bin/esbuild',
  [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${outFile}`, '--log-level=warning'],
  { stdio: 'inherit' }
);

const {
  toCalendarEvents,
  selectTodayHighImpact,
  ForexFactoryFeedSchema,
  FOREX_FACTORY_URL,
  buildCalendarMessages,
  jalaliDate,
} = await import(pathToFileURL(outFile).href);

/* Load the feed. */
let raw;
if (file) {
  raw = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`source: ${file}`);
} else {
  const res = await fetch(FOREX_FACTORY_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error(`\n❌ source returned HTTP ${res.status}. The job would send NOTHING and`);
    console.error('   report the failure. It would not scrape HTML or invent data.\n');
    process.exit(1);
  }
  raw = await res.json();
  console.log(`source: ${FOREX_FACTORY_URL}`);
}

const parsed = ForexFactoryFeedSchema.safeParse(raw);
if (!parsed.success) {
  console.error('\n❌ feed shape changed — the job would abort rather than half-read it.\n');
  process.exit(1);
}

/* Pick the instant that lands on the requested local day. */
const now = dateArg ? new Date(`${dateArg}T12:00:00Z`) : new Date();

const events = toCalendarEvents(parsed.data, timeZone);
const today = selectTodayHighImpact(events, timeZone, now);

console.log(`timezone: ${timeZone}`);
console.log(`rows in feed: ${parsed.data.length}  |  High impact overall: ${events.filter((e) => e.impact === 'High').length}`);
console.log('─'.repeat(60));

if (today.length === 0) {
  console.log('\nNo high-impact events for this local day.');
  console.log('The job sends NOTHING (by design) and marks the day as skipped.\n');
  console.log('High-impact days in this feed:');
  const byDay = new Map();
  for (const event of events.filter((e) => e.impact === 'High')) {
    byDay.set(event.localDate, (byDay.get(event.localDate) ?? 0) + 1);
  }
  for (const [day, count] of [...byDay].sort()) console.log(`  ${day}: ${count}`);
  console.log(`\nRetry with: node scripts/preview-calendar.mjs ${[...byDay.keys()].sort()[0] ?? ''}`);
} else {
  const messages = buildCalendarMessages(today, new Map(), jalaliDate(now, timeZone), false);
  messages.forEach((message, i) => {
    if (messages.length > 1) console.log(`\n── message ${i + 1}/${messages.length} (${message.length} chars) ──`);
    console.log(`\n${message}\n`);
  });
}

rmSync(outDir, { recursive: true, force: true });
