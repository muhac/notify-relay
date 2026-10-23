import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const NAMES = [
    'LIVE_LOKI_URL',
    'LIVE_LOKI_USER',
    'LIVE_LOKI_TOKEN',
    'LIVE_SMTP_HOST',
    'LIVE_SMTP_USER',
    'LIVE_SMTP_PASSWORD',
    'LIVE_SMTP_FROM',
    'LIVE_SMTP_TO',
    'LIVE_GMAIL_CLIENT_ID',
    'LIVE_GMAIL_CLIENT_SECRET',
    'LIVE_GMAIL_REFRESH_TOKEN',
    'LIVE_GMAIL_FROM',
    'LIVE_GMAIL_TO',
] as const

const missing = NAMES.filter((name) => !process.env[name])
if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
const live = Object.fromEntries(NAMES.map((name) => [name, process.env[name]!])) as Record<(typeof NAMES)[number], string>

const { GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
const repository = GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}` : undefined

const smtp = (id: string, port: string) => ({
    [`CHANNEL_${id}_TYPE`]: 'smtp',
    [`CHANNEL_${id}_HOST`]: live.LIVE_SMTP_HOST,
    [`CHANNEL_${id}_PORT`]: port,
    [`CHANNEL_${id}_USER`]: live.LIVE_SMTP_USER,
    [`CHANNEL_${id}_PASSWORD`]: live.LIVE_SMTP_PASSWORD,
    [`CHANNEL_${id}_FROM`]: live.LIVE_SMTP_FROM,
    [`CHANNEL_${id}_TO`]: live.LIVE_SMTP_TO,
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
                    CHANNEL_GMAIL_TYPE: 'gmail',
                    CHANNEL_GMAIL_CLIENT_ID: live.LIVE_GMAIL_CLIENT_ID,
                    CHANNEL_GMAIL_CLIENT_SECRET: live.LIVE_GMAIL_CLIENT_SECRET,
                    CHANNEL_GMAIL_REFRESH_TOKEN: live.LIVE_GMAIL_REFRESH_TOKEN,
                    CHANNEL_GMAIL_FROM: live.LIVE_GMAIL_FROM,
                    CHANNEL_GMAIL_TO: live.LIVE_GMAIL_TO,
                    TOKEN_LIVE: 'nr_live',
                    LIVE_COMMIT: GITHUB_SHA ?? 'local',
                    LIVE_COMMIT_URL: repository ? `${repository}/commit/${GITHUB_SHA}` : 'local',
                    LIVE_RUN_URL: repository ? `${repository}/actions/runs/${GITHUB_RUN_ID}` : 'local',
                },
            },
        }),
    ],
    test: { include: ['test/live/*.test.ts'] },
})
