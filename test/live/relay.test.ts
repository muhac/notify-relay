import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'

const run = crypto.randomUUID()
const vars = env as unknown as Record<string, string>

async function call(method: string, path: string, init: RequestInit<IncomingRequestCfProperties> = {}): Promise<Response> {
    const request = new Request<unknown, IncomingRequestCfProperties>(`https://notify.example${path}`, { method, ...init })
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)
    return response
}

async function send(channel: string): Promise<unknown> {
    const response = await call('POST', `/webhook?channels=${channel}`, {
        headers: { authorization: 'Bearer nr_live' },
        body: JSON.stringify({ title: `notify-relay live test ${run}`, text: `Sent through ${channel} by the live test.` }),
    })
    return response.json()
}

async function readBack(): Promise<boolean> {
    const query = new URL('query_range', vars.CHANNEL_LOKI_URL)
    query.searchParams.set('query', `{job="notify-relay", source="live"} |= "${run}"`)
    query.searchParams.set('start', `${Date.now() - 10 * 60_000}000000`)
    const authorization = `Basic ${btoa(`${vars.CHANNEL_LOKI_USER}:${vars.CHANNEL_LOKI_TOKEN}`)}`
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 2000))) {
        const response = await fetch(query, { headers: { authorization } })
        expect(response.status).toBe(200)
        const { data } = (await response.json()) as { data: { result: unknown[] } }
        if (data.result.length > 0) return true
    }
    return false
}

describe('live', () => {
    it('is ready with every channel configured', async () => {
        expect((await call('GET', '/healthz')).status).toBe(200)
    })

    it('pushes to Loki, where the line can be read back', async () => {
        expect(await send('loki')).toEqual({ messages: [{ delivered: ['loki'], failed: [] }] })
        expect(await readBack()).toBe(true)
    }, 90_000)

    it.each(['smtp-587', 'smtp-465'])('gets mail through %s accepted', async (channel) => {
        expect(await send(channel)).toEqual({ messages: [{ delivered: [channel], failed: [] }] })
    }, 30_000)
})
