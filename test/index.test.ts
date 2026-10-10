import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'

async function call(
    method: string,
    path: string,
    init: RequestInit<IncomingRequestCfProperties> = {},
): Promise<Response> {
    const request = new Request<unknown, IncomingRequestCfProperties>(`https://notify.example${path}`, {
        method,
        ...init,
    })
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)
    return response
}

describe('/healthz', () => {
    it('answers GET without credentials', async () => {
        const response = await call('GET', '/healthz')
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('ok')
    })

    it('rejects other methods', async () => {
        const response = await call('POST', '/healthz')
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET')
    })
})

describe('the deployed handler', () => {
    it('serves /webhook and turns away callers without a token', async () => {
        const response = await call('POST', '/webhook?channels=loki', { body: '{"title":"x"}' })
        expect(response.status).toBe(401)
    })
})

describe('unknown paths', () => {
    it('are 404', async () => {
        const response = await call('GET', '/nope')
        expect(response.status).toBe(404)
    })
})
