import { describe, expect, it } from 'vitest'
import type { Channel } from '../src/core/channels'
import { deliver, type Outbound } from '../src/core/deliver'
import { RateLimited } from '../src/core/http'
import type { Message } from '../src/core/message'

const message: Message = { source: 'test', title: 'hello', level: 'normal' }

type Behaviour = 'ok' | 'fail' | 'hang' | number

// Each call consumes the next behaviour; a number means 429 asking to wait that many milliseconds
function channel(name: string, behaviours: Behaviour[], calls: string[]): Channel {
    const adapter: Outbound = {
        type: 'fake',
        params: [],
        async send(_msg, _params, ctx) {
            calls.push(name)
            const next = behaviours.shift() ?? 'ok'
            if (next === 'fail') throw new Error('HTTP 500')
            if (typeof next === 'number') throw new RateLimited(next)
            if (next === 'hang') {
                await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
            }
        },
    }
    return { name, type: 'fake', adapter, params: {}, missing: [] }
}

function setup(spec: Record<string, Behaviour[]>, extra: Channel[] = []) {
    const calls: string[] = []
    const sleeps: number[] = []
    const channels = new Map<string, Channel>(
        [...Object.entries(spec).map(([name, b]) => channel(name, b, calls)), ...extra].map((c) => [c.name, c]),
    )
    const deps = {
        channels,
        fetch: async () => new Response(null),
        connect: (): never => {
            throw new Error('fake channels do not connect')
        },
        now: () => 0,
        sleep: async (ms: number) => void sleeps.push(ms),
        timeoutMs: 20,
    }
    return { calls, sleeps, deps }
}

describe('deliver', () => {
    it('tells each adapter which channel it is sending for', async () => {
        const seen: string[] = []
        const adapter: Outbound = { type: 'fake', params: [], send: async (_msg, _params, ctx) => void seen.push(ctx.channel) }
        const channels = new Map<string, Channel>(
            ['ops', 'family'].map((name) => [name, { name, type: 'fake', adapter, params: {}, missing: [] }]),
        )
        const connect = (): never => {
            throw new Error('fake channels do not connect')
        }
        await deliver(message, ['ops', 'family'], [], { channels, fetch: async () => new Response(null), connect, now: () => 0, sleep: async () => {} })
        expect(seen.sort()).toEqual(['family', 'ops'])
    })

    it('sends to the whole primary group', async () => {
        const { calls, deps } = setup({ a: ['ok'], b: ['ok'] })
        const outcome = await deliver(message, ['a', 'b'], ['c'], deps)
        expect(outcome).toEqual({ ok: true, delivered: ['a', 'b'], failed: [] })
        expect(calls.sort()).toEqual(['a', 'b'])
    })

    it('needs only one primary success and then skips the fallback', async () => {
        const { calls, deps } = setup({ a: ['fail'], b: ['ok'], c: ['ok'] })
        const outcome = await deliver(message, ['a', 'b'], ['c'], deps)
        expect(outcome).toEqual({ ok: true, delivered: ['b'], failed: [{ channel: 'a', error: 'HTTP 500' }] })
        expect(calls).not.toContain('c')
    })

    it('walks the fallback in order and stops at the first success', async () => {
        const { calls, deps } = setup({ a: ['fail'], c: ['fail'], d: ['ok'], e: ['ok'] })
        const outcome = await deliver(message, ['a'], ['c', 'd', 'e'], deps)
        expect(outcome.ok).toBe(true)
        expect(outcome.delivered).toEqual(['d'])
        expect(calls).toEqual(['a', 'c', 'd'])
    })

    it('fails when every channel fails', async () => {
        const { deps } = setup({ a: ['fail'], c: ['fail'] })
        const outcome = await deliver(message, ['a'], ['c'], deps)
        expect(outcome).toEqual({
            ok: false,
            delivered: [],
            failed: [
                { channel: 'a', error: 'HTTP 500' },
                { channel: 'c', error: 'HTTP 500' },
            ],
        })
    })

    it('gives up on a channel that does not answer in time', async () => {
        const { deps } = setup({ a: ['hang'] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'a', error: 'timeout' }])
    })

    it('retries a short rate limit once', async () => {
        const { calls, sleeps, deps } = setup({ a: [1500, 'ok'] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.delivered).toEqual(['a'])
        expect(sleeps).toEqual([1500])
        expect(calls).toEqual(['a', 'a'])
    })

    it('does not wait out a long rate limit', async () => {
        const { calls, sleeps, deps } = setup({ a: [2500] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'a', error: 'rate limited' }])
        expect(sleeps).toEqual([])
        expect(calls).toEqual(['a'])
    })

    it('retries at most once', async () => {
        const { calls, deps } = setup({ a: [100, 100, 'ok'] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'a', error: 'rate limited' }])
        expect(calls).toEqual(['a', 'a'])
    })

    it('fails a channel that is missing parameters without calling it', async () => {
        const broken: Channel = { ...channel('logs', ['ok'], []), missing: ['USER', 'TOKEN'] }
        const { deps } = setup({}, [broken])
        const outcome = await deliver(message, ['logs'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'logs', error: 'missing USER, TOKEN' }])
    })

    it('fails a channel of an unknown type', async () => {
        const { deps } = setup({}, [{ name: 'pager', type: 'pagerduty', params: {}, missing: [] }])
        const outcome = await deliver(message, ['pager'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'pager', error: "unknown type 'pagerduty'" }])
    })
})
