import { describe, expect, it } from 'vitest'
import { handle } from '../src/app'

const env = {
    CHANNEL_LOKI_TYPE: 'loki',
    CHANNEL_LOKI_URL: 'https://logs.example/loki/api/v1/push',
    CHANNEL_LOKI_USER: '123456',
    CHANNEL_LOKI_TOKEN: 'glc_secret',
    TOKEN_GITHUB: 'nr_github',
} as unknown as Env

function setup(lokiStatus = 204, overrides: Record<string, string | undefined> = {}) {
    const pushed: unknown[] = []
    const urls: string[] = []
    const deps = {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            urls.push(request.url)
            pushed.push(await request.json())
            return new Response(null, { status: lokiStatus })
        },
        now: () => 1_760_000_000_000,
        sleep: async () => {},
    }
    const send = (path: string, init: RequestInit = {}) =>
        handle(new Request(`https://notify.example${path}`, init), { ...env, ...overrides } as Env, deps)
    return { pushed, urls, send }
}

const authorized = (body: unknown, token = 'nr_github'): RequestInit => ({
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
})

describe('POST /webhook', () => {
    it('delivers to Loki under the source the token belongs to', async () => {
        const { pushed, send } = setup()
        const response = await send('/webhook?channels=loki', authorized({ title: 'deploy done', level: 'low' }))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ messages: [{ delivered: ['loki'], failed: [] }] })
        expect(pushed).toEqual([
            {
                streams: [
                    {
                        stream: { job: 'notify-relay', source: 'github', level: 'low' },
                        values: [['1760000000000000000', JSON.stringify({ title: 'deploy done' })]],
                    },
                ],
            },
        ])
    })

    it('delivers to several channels of the same type, each with its own settings', async () => {
        const { urls, send } = setup(204, {
            CHANNEL_ARCHIVE_TYPE: 'loki',
            CHANNEL_ARCHIVE_URL: 'https://archive.example/loki/api/v1/push',
            CHANNEL_ARCHIVE_USER: '654321',
            CHANNEL_ARCHIVE_TOKEN: 'glc_other',
        })
        const response = await send('/webhook?channels=loki,archive', authorized({ title: 'x' }))
        expect(await response.json()).toEqual({ messages: [{ delivered: ['loki', 'archive'], failed: [] }] })
        expect(urls.sort()).toEqual(['https://archive.example/loki/api/v1/push', 'https://logs.example/loki/api/v1/push'])
    })

    it('is 502 when every channel fails, and says why without secrets', async () => {
        const { send } = setup(500)
        const response = await send('/webhook?channels=loki', authorized({ title: 'x' }))

        expect(response.status).toBe(502)
        const text = await response.text()
        expect(JSON.parse(text)).toEqual({ messages: [{ delivered: [], failed: [{ channel: 'loki', error: 'HTTP 500' }] }] })
        expect(text).not.toContain('glc_secret')
        expect(text).not.toContain('nr_github')
    })

    it('checks the token before looking at anything else', async () => {
        const { pushed, send } = setup()
        for (const init of [
            authorized({ title: 'x' }, 'nr_wrong'),
            { method: 'POST', body: JSON.stringify({ title: 'x' }) },
            authorized({ titel: 'not even valid' }, 'nr_wrong'),
        ]) {
            const response = await send('/webhook', init)
            expect(response.status).toBe(401)
            expect(await response.text()).toBe('')
        }
        expect(pushed).toEqual([])
    })

    it('rejects bad requests with the reason', async () => {
        const { pushed, send } = setup()
        const cases: [string, RequestInit, string][] = [
            ['/webhook', authorized({ title: 'x' }), 'channels is required'],
            ['/webhook?channels=pager', authorized({ title: 'x' }), "unknown channel 'pager'"],
            ['/webhook?channels=loki', authorized({ titel: 'x' }), "unknown field 'titel'"],
            [
                '/webhook?channels=loki',
                { ...authorized(null), body: '{"title":' },
                'body must be valid JSON',
            ],
        ]
        for (const [path, init, reason] of cases) {
            const response = await send(path, init)
            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({ error: reason })
        }
        expect(pushed).toEqual([])
    })

    it('refuses bodies over 64 KB', async () => {
        const { pushed, send } = setup()
        const response = await send('/webhook?channels=loki', authorized({ title: 'x', body: 'a'.repeat(64 * 1024) }))
        expect(response.status).toBe(413)
        expect(pushed).toEqual([])
    })

    it('only takes POST', async () => {
        const { send } = setup()
        const response = await send('/webhook?channels=loki', { method: 'GET' })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('POST')
    })
})

describe('GET /healthz', () => {
    it('needs no token and touches no channel', async () => {
        const { pushed, send } = setup()
        const response = await send('/healthz')
        expect(response.status).toBe(200)
        expect(pushed).toEqual([])
    })

    // Deploys do not check settings, so this is where a missing one shows up
    it('is 503 while a configured channel is missing a parameter', async () => {
        for (const missing of ['CHANNEL_LOKI_TOKEN', 'CHANNEL_LOKI_URL']) {
            const { send } = setup(204, { [missing]: undefined })
            const response = await send('/healthz')
            expect(response.status).toBe(503)
            expect(await response.text()).toBe('not ready')
        }
    })

    it('is 503 while a channel has a type the relay does not know', async () => {
        const { send } = setup(204, { CHANNEL_PAGER_TYPE: 'pagerduty' })
        expect((await send('/healthz')).status).toBe(503)
    })

    it('is 503 with no channel at all', async () => {
        const { send } = setup(204, { CHANNEL_LOKI_TYPE: undefined })
        expect((await send('/healthz')).status).toBe(503)
    })

    it('is 503 while no source can authenticate', async () => {
        const { send } = setup(204, { TOKEN_GITHUB: undefined })
        expect((await send('/healthz')).status).toBe(503)
    })
})
