/**
 * Generates `src/slideshow/fontAssets.ts` from the `vazirmatn` npm package.
 *
 * The slide template must NOT load fonts from the internet (Browser Run would
 * race the network and Persian text would render with a fallback font, losing
 * shaping). So the two weights the template uses are embedded as base64 data
 * URLs inside the HTML we hand to Browser Run.
 *
 * `vazirmatn` is a devDependency and the generated file is committed, so a
 * production deploy never needs the package.
 *
 * Run: npm run build:fonts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Only the weights the slide template actually uses. Each extra weight costs ~67 KB of base64 in every render request. */
const WEIGHTS = [
  { name: 'REGULAR', weight: 400, file: 'node_modules/vazirmatn/fonts/webfonts/Vazirmatn-Regular.woff2' },
  { name: 'BOLD', weight: 700, file: 'node_modules/vazirmatn/fonts/webfonts/Vazirmatn-Bold.woff2' },
];

const parts = [];
let total = 0;

for (const { name, weight, file } of WEIGHTS) {
  const abs = resolve(root, file);
  let bytes;
  try {
    bytes = readFileSync(abs);
  } catch {
    console.error(`[build-fonts] missing ${file} — run: npm install`);
    process.exit(1);
  }
  const b64 = bytes.toString('base64');
  total += b64.length;
  parts.push(
    `/** Vazirmatn ${weight} (woff2, ${bytes.length} bytes raw). */\n` +
      `export const VAZIRMATN_${name}_WOFF2_BASE64 =\n  '${b64}';`
  );
}

const header = `/**
 * GENERATED FILE — do not edit by hand. Run \`npm run build:fonts\` to refresh.
 *
 * Vazirmatn by Saber Rastikerdar, SIL Open Font License 1.1.
 * Source: the \`vazirmatn\` npm package (devDependency), fonts/webfonts/*.woff2.
 *
 * Embedded as base64 so the slide HTML is fully self-contained: Browser Run
 * never fetches a font over the network, which is what guarantees correct
 * Persian shaping and RTL rendering on every single screenshot.
 */

`;

const outPath = resolve(root, 'src/slideshow/fontAssets.ts');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, header + parts.join('\n\n') + '\n', 'utf8');

console.log(
  `[build-fonts] wrote ${outPath} (${WEIGHTS.length} weights, ${(total / 1024).toFixed(1)} KB base64)`
);
