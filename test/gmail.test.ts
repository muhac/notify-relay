import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Message } from '../src/core/message'
import { gmail } from '../src/outbound/gmail'

const params = { CLIENT_ID: 'client.apps.example', CLIENT_SECRET: 'csecret', REFRESH_TOKEN: 'rtoken', TO: 'you@example.com' }
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

function fake(token: Response, sent: Response = Response.json({ id: 'm1' })) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push(request)
        return request.url === TOKEN_URL ? token.clone() : sent.clone()
    }
    return { requests, ctx: { fetch, now: () => 0, signal: new AbortController().signal } }
}

const granted = () => Response.json({ access_token: 'ya29.access', expires_in: 3599, token_type: 'Bearer' })

function utf8(base64: string): string {
    const binary = atob(base64.replaceAll('-', '+').replaceAll('_', '/').replace(/\s+/g, ''))
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

// Splits the raw RFC 2822 message the relay hands Gmail into headers and the decoded body
async function sentMail(request: Request) {
    const { raw } = (await request.json()) as { raw: string }
    const mime = utf8(raw)
    const [head, body] = mime.split('\r\n\r\n')
    const headers = Object.fromEntries(
        head!.split('\r\n').map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 2)]),
    )
    return { raw, headers, text: utf8(body!) }
}

const message: Message = {
    source: 'ci',
    title: '部署失败 deploy failed',
    body: 'functions-deploy on main',
    url: 'https://github.com/example/run',
    level: 'high',
}

describe('gmail', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(gmail.type).toBe('gmail')
        expect([...gmail.params]).toEqual(['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'TO'])
    })

    it('mints an access token from the refresh token, then sends as the authorized account', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send(message, params, ctx)

        expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TOKEN_URL}`, `POST ${SEND_URL}`])
        const form = new URLSearchParams(await requests[0]!.text())
        expect(Object.fromEntries(form)).toEqual({
            client_id: 'client.apps.example',
            client_secret: 'csecret',
            refresh_token: 'rtoken',
            grant_type: 'refresh_token',
        })
        expect(requests[1]!.headers.get('authorization')).toBe('Bearer ya29.access')
        expect(requests[1]!.headers.get('content-type')).toBe('application/json')
    })

    it('writes a plain-text mail with the title in both subject and body, so email-to-SMS gateways keep it', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send(message, params, ctx)
        const { raw, headers, text } = await sentMail(requests[1]!)

        expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(headers.to).toBe('you@example.com')
        expect(headers.from).toBeUndefined()
        expect(headers['content-type']).toBe('text/plain; charset=UTF-8')
        expect(headers['content-transfer-encoding']).toBe('base64')
        expect(headers.subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
        expect(utf8(headers.subject!.slice('=?UTF-8?B?'.length, -2))).toBe('部署失败 deploy failed')
        expect(text).toBe('部署失败 deploy failed\n\nfunctions-deploy on main\n\nhttps://github.com/example/run')
    })

    it('leaves out the parts a message does not have', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send({ source: 's', title: 'only a title', level: 'low' }, params, ctx)
        expect((await sentMail(requests[1]!)).text).toBe('only a title')
    })

    it('reports a revoked or expired refresh token clearly and sends nothing', async () => {
        const { requests, ctx } = fake(Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe('refresh token revoked or expired (invalid_grant)')
        expect(requests).toHaveLength(1)
    })

    it('reports other token failures by status, without secrets', async () => {
        const { ctx } = fake(new Response('boom', { status: 500 }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe('HTTP 500')
    })

    it('turns a 429 from Gmail into a rate limit', async () => {
        const { ctx } = fake(granted(), new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(1000)
    })

    it('reports a rejected send by status', async () => {
        const { ctx } = fake(granted(), new Response('forbidden', { status: 403 }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe('HTTP 403')
    })
})
