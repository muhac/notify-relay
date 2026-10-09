import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // Real deployments get these from `--var` and `wrangler secret put`; tests use placeholders
            miniflare: {
                bindings: {
                    LOKI_PUSH_URL: 'https://logs.example/loki/api/v1/push',
                    LOKI_USER: '123456',
                    LOKI_TOKEN: 'test-loki-token',
                    TOKEN_TEST: 'nr_test',
                },
            },
        }),
    ],
})
