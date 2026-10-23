import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { configDefaults, defineConfig } from 'vitest/config'

// The core's tests run on both runtimes, so it cannot come to rely on either
const CORE = ['test/*.test.ts']

export default defineConfig({
    test: {
        projects: [
            {
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
                                new Response(null, {
                                    status: request.method === 'POST' && request.url === 'https://logs.example/loki/api/v1/push' ? 204 : 502,
                                }),
                        },
                    }),
                ],
                test: { name: 'workers', include: CORE },
            },
            {
                test: {
                    name: 'node',
                    environment: 'node',
                    include: [...CORE, 'test/node/*.test.ts'],
                    exclude: [...configDefaults.exclude, 'test/cloudflare.test.ts'],
                },
            },
        ],
    },
})
