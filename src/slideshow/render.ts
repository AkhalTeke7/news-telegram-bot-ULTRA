/**
 * Rasterizes slide HTML into PNGs through Cloudflare Browser Run.
 *
 * Browser Run (formerly Browser Rendering) Quick Actions are rate limited to
 * roughly ONE request every 10 seconds on the Workers Free plan (30/second on
 * Paid), so slides are rendered sequentially with a configurable gap. A 429
 * stops the loop instead of hammering: a partial album still ships.
 *
 * The screenshot is dispatched via the shared `browserScreenshot()` helper
 * already used by the existing album, so both code paths keep working
 * whichever shape the binding exposes (`quickAction('screenshot', …)` or
 * `screenshot(…)`).
 */

import { browserScreenshot, type BrowserBinding } from '../newsImage';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './slideTemplate';

/** Free plan: ~1 Quick Action / 10s. Paid can safely lower this. */
export const DEFAULT_SLIDE_SPACING_MS = 10_500;
export const DEFAULT_RENDER_TIMEOUT_MS = 25_000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** PNG magic number + IHDR, so a JSON error body is never mistaken for an image. */
export function readPngSize(buffer: ArrayBuffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null;
  const view = new DataView(buffer);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (view.getUint8(i) !== signature[i]) return null;
  }
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface RenderedSlide<TMeta> {
  meta: TMeta;
  png: ArrayBuffer;
  bytes: number;
  width: number;
  height: number;
}

export interface RenderSlidesResult<TMeta> {
  slides: RenderedSlide<TMeta>[];
  /** Slides that could not be rendered. */
  skipped: number;
  /** True once Browser Run answered 429 and the loop stopped early. */
  rateLimited: boolean;
  browserRunMs: number;
  /** Short, secret-free reason for the first failure. */
  error?: string;
}

export interface RenderSlidesOptions<TMeta> {
  browser: BrowserBinding | undefined;
  /** HTML + whatever the caller needs to correlate the PNG back to its item. */
  pages: readonly { html: string; meta: TMeta }[];
  spacingMs?: number;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Renders every page in order.
 *
 * Never throws. A failure degrades to a shorter album; the caller decides
 * whether what survived is worth sending.
 */
export async function renderSlides<TMeta>(
  opts: RenderSlidesOptions<TMeta>
): Promise<RenderSlidesResult<TMeta>> {
  const slides: RenderedSlide<TMeta>[] = [];
  let skipped = 0;
  let rateLimited = false;
  let browserRunMs = 0;
  let error: string | undefined;

  if (!opts.browser || opts.pages.length === 0) {
    return { slides, skipped: opts.pages.length, rateLimited, browserRunMs, error: 'browser_binding_missing' };
  }

  const waitFor = opts.sleepImpl ?? sleep;
  const spacing = opts.spacingMs ?? 0;

  for (let i = 0; i < opts.pages.length; i++) {
    if (rateLimited) {
      skipped++;
      continue;
    }
    if (i > 0 && spacing > 0) await waitFor(spacing);

    const started = Date.now();
    try {
      const response = await browserScreenshot(opts.browser, {
        html: opts.pages[i].html,
        viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, deviceScaleFactor: 1 },
        screenshotOptions: { type: 'png', fullPage: false, captureBeyondViewport: false },
        gotoOptions: { waitUntil: 'networkidle0', timeout: opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS },
      });

      if (response.status === 429) {
        browserRunMs += Date.now() - started;
        error ??= 'browser_run_429';
        rateLimited = true;
        skipped++;
        continue;
      }

      const png = await response.arrayBuffer();
      browserRunMs += Date.now() - started;
      const size = readPngSize(png);
      if (!response.ok || !size) {
        error ??= `browser_run_status_${response.status}`;
        skipped++;
        continue;
      }

      slides.push({ meta: opts.pages[i].meta, png, bytes: png.byteLength, width: size.width, height: size.height });
    } catch (e) {
      browserRunMs += Date.now() - started;
      error ??= e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 120) : String(e).slice(0, 120);
      skipped++;
    }
  }

  return { slides, skipped, rateLimited, browserRunMs, ...(error ? { error } : {}) };
}
