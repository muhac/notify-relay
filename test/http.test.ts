import { describe, expect, it } from 'vitest'
import { expectOk, RateLimited } from '../src/core/http'

async function rateLimit(retryAfter?: string): Promise<RateLimited> {
    const headers: Record<string, string> = retryAfter === undefined ? {} : { 'retry-after': retryAfter }
    const error = await expectOk(new Response(null, { status: 429, headers })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RateLimited)
    return error as RateLimited
}

describe('expectOk', () => {
    it.each([
        ['2', 2000],
        ['0', 0],
        ['0.5', 500],
    ])('reads Retry-After %s as a wait of %i ms', async (value, ms) => {
        expect((await rateLimit(value)).retryAfterMs).toBe(ms)
    })

    it.each([
        ['missing', undefined],
        ['empty', ''],
        ['negative', '-1'],
        ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
        ['not a number', 'soon'],
    ])('treats a Retry-After that is %s as too long to wait', async (_, value) => {
        expect((await rateLimit(value)).retryAfterMs).toBe(Infinity)
    })
})
