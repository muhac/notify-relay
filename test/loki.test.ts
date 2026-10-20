import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import { loki } from '../src/outbound/loki'

const params = { URL: 'https://logs.example/loki/api/v1/push', USER: '123456', TOKEN: 'glc_secret' }

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): Socket => {
        throw new Error('loki does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_123, signal: new AbortController().signal } }
}

describe('loki', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(loki.type).toBe('loki')
        expect([...loki.params]).toEqual(['URL', 'USER', 'TOKEN'])
    })

    it('pushes one line with low-cardinality labels', async () => {
        const { requests, ctx } = capture(new Response(null, { status: 204 }))
        await loki.send(
            { source: 'github', title: 'deploy done', level: 'low', url: 'https://example.com/run', key: 'k1' },
            params,
            ctx,
        )

        expect(requests).toHaveLength(1)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        expect(request.url).toBe(params.URL)
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(request.headers.get('authorization')).toBe(`Basic ${btoa('123456:glc_secret')}`)

        const body = (await request.json()) as { streams: { stream: unknown; values: [string, string][] }[] }
        expect(body.streams).toHaveLength(1)
        const stream = body.streams[0]!
        expect(stream.stream).toEqual({ job: 'notify-relay', source: 'github', level: 'low' })
        expect(stream.values).toHaveLength(1)
        const [ts, line] = stream.values[0]!
        expect(ts).toBe('1760000000123000000')
        expect(JSON.parse(line)).toEqual({ title: 'deploy done', url: 'https://example.com/run', key: 'k1' })
    })

    it('reports a failed push without leaking the token', async () => {
        const { ctx } = capture(new Response('denied', { status: 401 }))
        const error = await loki.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('HTTP 401')
    })

    it('turns 429 into a rate limit with the delay Loki asks for', async () => {
        const { ctx } = capture(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
        const error = await loki.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(2000)
    })
})
