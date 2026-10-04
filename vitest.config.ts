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
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
