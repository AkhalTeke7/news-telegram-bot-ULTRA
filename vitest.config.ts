import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.json' },
      miniflare: {
      bindings: {
        ADMIN_PASSWORD: 'test-admin-password',
        // Empty token => add-channel flow skips the Telegram round-trip in tests.
        TELEGRAM_BOT_TOKEN: '',
        // Production paces AI requests (3.2s) and album renders (10.5s) to
        // respect free-tier rate limits; the suite must never sleep for real.
        AI_REQUEST_PACE_MS: '0',
        IMAGE_RENDER_SPACING_MS: '0',
      },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
