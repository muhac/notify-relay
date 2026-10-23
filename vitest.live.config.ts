import { execFileSync, spawnSync } from 'node:child_process'
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
    'LIVE_IMAP_HOST',
    'LIVE_IMAP_USER',
    'LIVE_IMAP_PASSWORD',
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

const relay: Record<string, string> = {
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
}

// With LIVE_IMAGE the relay under test is that image, started here with the settings the Worker would get
const image = process.env.LIVE_IMAGE
const relayUrl = image ? await start(image, relay) : undefined

async function start(image: string, settings: Record<string, string>): Promise<string> {
    // Passed by name, so the values stay out of the process list
    const names = Object.keys(settings).flatMap((name) => ['--env', name])
    const id = execFileSync('docker', ['run', '--detach', '--rm', '--publish', '127.0.0.1::8080', ...names, image], {
        env: { ...process.env, ...settings },
        encoding: 'utf8',
    }).trim()
    process.on('exit', (code) => {
        if (code !== 0) spawnSync('docker', ['logs', id], { stdio: 'inherit' })
        spawnSync('docker', ['stop', id])
    })
    const origin = `http://${execFileSync('docker', ['port', id, '8080/tcp'], { encoding: 'utf8' }).split('\n')[0]}`
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200))) {
        if (await fetch(`${origin}/healthz`).then(() => true, () => false)) return origin
    }
    throw new Error(`${image} did not start listening`)
}

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
                bindings: {
                    ...relay,
                    ...(relayUrl && { LIVE_RELAY_URL: relayUrl }),
                    LIVE_TARGET: image ? 'Docker' : 'Workers',
                    LIVE_IMAP_HOST: live.LIVE_IMAP_HOST,
                    LIVE_IMAP_USER: live.LIVE_IMAP_USER,
                    LIVE_IMAP_PASSWORD: live.LIVE_IMAP_PASSWORD,
                    LIVE_COMMIT: GITHUB_SHA ?? 'local',
                    LIVE_COMMIT_URL: repository ? `${repository}/commit/${GITHUB_SHA}` : 'local',
                    LIVE_RUN_URL: repository ? `${repository}/actions/runs/${GITHUB_RUN_ID}` : 'local',
                },
            },
        }),
    ],
    test: { include: ['test/live/*.test.ts'] },
})
