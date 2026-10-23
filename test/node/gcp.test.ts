import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// The deploy package, served by the Functions Framework as Cloud Run functions serves it
const FRAMEWORK = 'node_modules/@google-cloud/functions-framework/build/src/main.js'

let framework: ChildProcess
let loki: Server
let origin: string
let pushed: string[] = []

async function freePort(): Promise<number> {
    const server = createNetServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    await new Promise((resolve) => server.close(resolve))
    return port
}

beforeAll(async () => {
    execFileSync('npm', ['run', '--silent', 'build:gcp'], { stdio: 'ignore' })

    loki = createHttpServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
            pushed.push(body)
            res.writeHead(204).end()
        })
    })
    await new Promise<void>((resolve) => loki.listen(0, '127.0.0.1', resolve))

    const port = await freePort()
    framework = spawn(process.execPath, [FRAMEWORK, '--source=dist/gcp', '--target=relay', `--port=${port}`], {
        env: {
            PATH: process.env.PATH!,
            TOKEN_TEST: 'nr_test',
            CHANNEL_LOGS_TYPE: 'loki',
            CHANNEL_LOGS_URL: `http://127.0.0.1:${(loki.address() as { port: number }).port}/loki/api/v1/push`,
            CHANNEL_LOGS_USER: '1',
            CHANNEL_LOGS_TOKEN: 'x',
        },
    })
    origin = `http://127.0.0.1:${port}`
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 100))) {
        if (await fetch(`${origin}/healthz`).then(() => true, () => false)) return
    }
    throw new Error('the Functions Framework did not start')
}, 60_000)

afterAll(() => {
    framework?.kill()
    loki?.close()
})

beforeEach(() => {
    pushed = []
})

const lines = () => pushed.map((body) => JSON.parse(JSON.parse(body).streams[0].values[0][1]))

function send(body: string, headers: Record<string, string> = {}) {
    return fetch(`${origin}/webhook?channels=logs`, { method: 'POST', headers: { authorization: 'Bearer nr_test', ...headers }, body })
}

describe('cloud run functions', () => {
    it('serves /healthz', async () => {
        const response = await fetch(`${origin}/healthz`)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('ok')
    })

    it.each([
        ['application/json', 'which the framework parses'],
        ['text/plain; charset=utf-8', 'which the framework reads as text'],
        ['application/octet-stream', 'which the framework reads as raw bytes'],
    ])('delivers a body sent as %s, %s', async (type) => {
        const response = await send(JSON.stringify({ title: 'deploy done', text: 'über' }), { 'content-type': type })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ messages: [{ delivered: ['logs'], failed: [] }] })
        expect(lines()).toEqual([{ title: 'deploy done', text: 'über' }])
    })

    it('delivers a body sent without a content type, which no parser of the framework reads', async () => {
        const response = await fetch(`${origin}/webhook?channels=logs`, {
            method: 'POST',
            headers: { authorization: 'Bearer nr_test' },
            body: new Blob([JSON.stringify({ title: 'untyped' })]).stream(),
            duplex: 'half',
        })

        expect(response.status).toBe(200)
        expect(lines()).toEqual([{ title: 'untyped' }])
    })

    it('turns away a caller without a token', async () => {
        const response = await fetch(`${origin}/webhook?channels=logs`, { method: 'POST', body: '{"title":"x"}' })

        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
        expect(pushed).toHaveLength(0)
    })

    it('refuses a body over 64 KB', async () => {
        const response = await send(JSON.stringify({ title: 'x', text: 'x'.repeat(64 * 1024) }), { 'content-type': 'application/json' })

        expect(response.status).toBe(413)
        expect(pushed).toHaveLength(0)
    })

    it('leaves JSON that does not parse to the framework, which answers 400 without its stack', async () => {
        const response = await send('{"title":', { 'content-type': 'application/json' })

        expect(response.status).toBe(400)
        expect(await response.text()).not.toContain('node_modules')
    })
})
