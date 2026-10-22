import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const NAMES = [
    'LIVE_LOKI_URL',
    'LIVE_LOKI_USER',
    'LIVE_LOKI_TOKEN',
    'LIVE_SMTP_HOST',
    'LIVE_SMTP_USER',
    'LIVE_SMTP_PASSWORD',
    'LIVE_SMTP_ADDRESS',
] as const

const missing = NAMES.filter((name) => !process.env[name])
if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
const live = Object.fromEntries(NAMES.map((name) => [name, process.env[name]!])) as Record<(typeof NAMES)[number], string>

const smtp = (id: string, port: string) => ({
    [`CHANNEL_${id}_TYPE`]: 'smtp',
    [`CHANNEL_${id}_HOST`]: live.LIVE_SMTP_HOST,
    [`CHANNEL_${id}_PORT`]: port,
    [`CHANNEL_${id}_USER`]: live.LIVE_SMTP_USER,
    [`CHANNEL_${id}_PASSWORD`]: live.LIVE_SMTP_PASSWORD,
    [`CHANNEL_${id}_FROM`]: live.LIVE_SMTP_ADDRESS,
    [`CHANNEL_${id}_TO`]: live.LIVE_SMTP_ADDRESS,
})

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
                bindings: {
                    CHANNEL_LOKI_TYPE: 'loki',
                    CHANNEL_LOKI_URL: live.LIVE_LOKI_URL,
                    CHANNEL_LOKI_USER: live.LIVE_LOKI_USER,
                    CHANNEL_LOKI_TOKEN: live.LIVE_LOKI_TOKEN,
                    ...smtp('SMTP_587', '587'),
                    ...smtp('SMTP_465', '465'),
                    TOKEN_LIVE: 'nr_live',
                },
            },
        }),
    ],
    test: { include: ['test/live/*.test.ts'] },
})
