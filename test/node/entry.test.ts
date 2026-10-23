import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = 'dist/node/index.mjs'
const children: ChildProcess[] = []

beforeAll(() => {
    execFileSync('npm', ['run', '--silent', 'build:node'], { stdio: 'ignore' })
}, 60_000)

afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
})

// Port 0 lets the system pick; the bundle prints the port it got
async function start(env: Record<string, string>): Promise<{ child: ChildProcess; origin: string }> {
    const child = spawn(process.execPath, [BUNDLE], { env: { PATH: process.env.PATH!, PORT: '0', ...env } })
    children.push(child)
    let output = ''
    for await (const chunk of child.stdout!) {
        output += String(chunk)
        const port = /listening on port (\d+)/.exec(output)?.[1]
        if (port) return { child, origin: `http://127.0.0.1:${port}` }
    }
    throw new Error(`exited before listening: ${output}`)
}

describe('node entry', () => {
    it('reads its configuration from the environment', async () => {
        const { origin } = await start({
            CHANNEL_LOGS_TYPE: 'loki',
            CHANNEL_LOGS_URL: 'https://logs.invalid/loki/api/v1/push',
            CHANNEL_LOGS_USER: '1',
            CHANNEL_LOGS_TOKEN: 'x',
            TOKEN_TEST: 'nr_test',
        })

        expect((await fetch(`${origin}/healthz`)).status).toBe(200)
        const response = await fetch(`${origin}/webhook?channels=logs`, {
            method: 'POST',
            headers: { authorization: 'Bearer nr_test' },
            body: '{"title":"x"}',
        })
        expect(response.status).toBe(502)
        expect(await response.json()).toMatchObject({ messages: [{ delivered: [], failed: [{ channel: 'logs' }] }] })
    })

    it('is not ready without configuration', async () => {
        const { origin } = await start({})
        expect((await fetch(`${origin}/healthz`)).status).toBe(503)
    })

    it('exits cleanly on SIGTERM, as a container stop sends', async () => {
        const { child } = await start({})
        child.kill('SIGTERM')
        const [code] = await once(child, 'exit')
        expect(code).toBe(0)
    })
})
