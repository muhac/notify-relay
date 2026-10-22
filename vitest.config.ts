import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
                bindings: {
                    CHANNEL_LOKI_TYPE: 'loki',
                    CHANNEL_LOKI_URL: 'https://logs.example/loki/api/v1/push',
                    CHANNEL_LOKI_USER: '123456',
                    CHANNEL_LOKI_TOKEN: 'test-loki-token',
                    TOKEN_TEST: 'nr_test',
                },
                outboundService: (request) =>
                    new Response(null, { status: request.method === 'POST' && request.url === 'https://logs.example/loki/api/v1/push' ? 204 : 502 }),
            },
        }),
    ],
})
