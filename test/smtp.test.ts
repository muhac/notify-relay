import { describe, expect, it } from 'vitest'
import type { Connect, Connection } from '../src/core/deliver'
import type { Message } from '../src/core/message'
import { smtp } from '../src/outbound/smtp'
import { decode, parseMail } from './mail'

const params = {
    HOST: 'smtp.example.com',
    USER: 'relay@example.com',
    PASSWORD: 'app-password',
    FROM: 'Home Relay <relay@example.com>',
    TO: 'you@example.com, 运维 <ops@example.com>',
}

const message: Message = {
    source: 'ci',
    title: '部署失败 deploy failed',
    text: 'functions-deploy failed on main',
    rich: '<p>functions-deploy <b>failed</b></p>',
    url: 'https://github.com/example/run',
    level: 'high',
}

const NOW = Date.UTC(2026, 9, 20, 21, 18, 28)

// The message itself is answered as DATA_END; null hangs up, 'hang' never answers, 'reset' fails the write
type Replies = Record<string, string | null>

const DEFAULT_REPLIES: Replies = {
    greeting: '220 smtp.example.com ESMTP',
    EHLO: '250-smtp.example.com\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN',
    STARTTLS: '220 ready',
    AUTH: '235 accepted',
    MAIL: '250 ok',
    RCPT: '250 ok',
    DATA: '354 go ahead',
    DATA_END: '250 queued',
    QUIT: '221 bye',
}

function server(overrides: Replies = {}, { bytewise = false } = {}) {
    const replies = { ...DEFAULT_REPLIES, ...overrides }
    const sent: { line: string; tls: boolean }[] = []
    const connections: { address: Parameters<Connect>[0]; options: Parameters<Connect>[1] }[] = []
    let closes = 0
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    function socket(tls: boolean, greet: boolean): Connection {
        let reply = (_: string | null) => {}
        let ended = false
        const readable = new ReadableStream<Uint8Array>({
            start(controller) {
                reply = (text) => {
                    if (ended || text === 'hang') return
                    if (text === null) {
                        ended = true
                        controller.close()
                        return
                    }
                    const bytes = encoder.encode(`${text}\r\n`)
                    if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
                    else controller.enqueue(bytes)
                }
            },
        })
        let buffer = ''
        let data = false
        const writable = new WritableStream<Uint8Array>({
            write(chunk) {
                buffer += decoder.decode(chunk, { stream: true })
                for (let end; (end = buffer.indexOf(data ? '\r\n.\r\n' : '\r\n')) >= 0; ) {
                    const line = buffer.slice(0, end)
                    buffer = buffer.slice(end + (data ? 5 : 2))
                    sent.push({ line, tls })
                    const verb = data ? 'DATA_END' : line.split(' ')[0]!.toUpperCase()
                    const answer = verb in replies ? replies[verb]! : '500 unknown'
                    if (answer === 'reset') throw new Error('connection reset')
                    data = verb === 'DATA' && answer?.startsWith('354') === true
                    reply(answer)
                }
            },
        })
        const self: Connection = {
            readable,
            writable,
            close: async () => {
                closes++
                reply(null)
            },
            startTls: () => socket(true, false),
        }
        if (greet) queueMicrotask(() => reply(replies.greeting ?? null))
        return self
    }

    const connect: Connect = (address, options) => {
        connections.push({ address, options })
        return socket(options.secureTransport === 'on', true)
    }
    return {
        sent,
        connections,
        closes: () => closes,
        ctx: (signal = new AbortController().signal) => ({
            fetch: async (): Promise<Response> => {
                throw new Error('smtp does not fetch')
            },
            connect,
            now: () => NOW,
            signal,
            channel: 'mail',
        }),
    }
}

const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => (e as Error).message)

describe('smtp', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(smtp.type).toBe('smtp')
        expect([...smtp.params]).toEqual(['HOST', 'USER', 'PASSWORD', 'FROM', 'TO'])
        expect([...(smtp.optional ?? [])]).toEqual(['PORT', 'ALLOW_TO'])
    })

    it('connects to HOST on 587 by default, ready to upgrade to TLS', async () => {
        const fake = server()
        await smtp.send(message, params, fake.ctx())
        expect(fake.connections).toEqual([
            { address: { hostname: 'smtp.example.com', port: 587 }, options: { secureTransport: 'starttls', allowHalfOpen: false } },
        ])
    })

    it('connects to PORT when it is set', async () => {
        const fake = server()
        await smtp.send(message, { ...params, PORT: '2587' }, fake.ctx())
        expect(fake.connections[0]!.address).toEqual({ hostname: 'smtp.example.com', port: 2587 })
    })

    it('upgrades to TLS before it authenticates, then submits to every recipient and quits', async () => {
        const fake = server()
        await smtp.send(message, params, fake.ctx())

        const plain = fake.sent.filter((s) => !s.tls).map((s) => s.line)
        const secure = fake.sent.filter((s) => s.tls).map((s) => s.line)
        expect(plain).toEqual(['EHLO example.com', 'STARTTLS'])
        expect(secure.slice(0, 5)).toEqual([
            'EHLO example.com',
            `AUTH PLAIN ${btoa('\0relay@example.com\0app-password')}`,
            'MAIL FROM:<relay@example.com>',
            'RCPT TO:<you@example.com>',
            'RCPT TO:<ops@example.com>',
        ])
        expect(secure[5]).toBe('DATA')
        expect(secure.at(-1)).toBe('QUIT')
        expect(fake.closes()).toBeGreaterThan(0)
    })

    it('uses implicit TLS on port 465, so every command is encrypted and none is STARTTLS', async () => {
        const fake = server()
        await smtp.send(message, { ...params, PORT: '465' }, fake.ctx())
        expect(fake.connections[0]!.options).toEqual({ secureTransport: 'on', allowHalfOpen: false })
        expect(fake.sent.every((s) => s.tls)).toBe(true)
        expect(fake.sent.slice(0, 2).map((s) => s.line)).toEqual([
            'EHLO example.com',
            `AUTH PLAIN ${btoa('\0relay@example.com\0app-password')}`,
        ])
    })

    it('ignores whatever the server sent in plaintext after agreeing to STARTTLS', async () => {
        const fake = server({ STARTTLS: '220 ready\r\n535 injected before the handshake' })
        await smtp.send(message, params, fake.ctx())
        expect(fake.sent.at(-1)!.line).toBe('QUIT')
    })

    it('submits the same message as gmail, with Date and Message-ID added', async () => {
        const fake = server()
        await smtp.send(message, params, fake.ctx())
        const data = fake.sent.find((s, i) => fake.sent[i - 1]?.line === 'DATA')!.line
        const { lines, headers, parts } = parseMail(data)

        expect(headers.from).toBe('"Home Relay" <relay@example.com>')
        expect(decode(headers.to!)).toBe('you@example.com, 运维 <ops@example.com>')
        expect(decode(headers.subject!)).toBe('部署失败 deploy failed')
        expect(headers.date).toBe('Tue, 20 Oct 2026 21:18:28 +0000')
        expect(headers['message-id']).toMatch(/^<[0-9a-f-]{36}@example\.com>$/)
        expect(parts.map((p) => p.content)).toEqual(['functions-deploy failed on main', '<p>functions-deploy <b>failed</b></p>'])
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
    })

    it('never sends the credentials when the server will not start TLS', async () => {
        const fake = server({ STARTTLS: '454 TLS not available' })
        expect(await failure(smtp.send(message, params, fake.ctx()))).toBe('SMTP 454 on STARTTLS')
        expect(fake.sent.map((s) => s.line)).toEqual(['EHLO example.com', 'STARTTLS'])
        expect(fake.closes()).toBeGreaterThan(0)
    })

    it('reports a rejected login by code and step, and sends no mail', async () => {
        const fake = server({ AUTH: '535 5.7.8 authentication failed' })
        expect(await failure(smtp.send(message, params, fake.ctx()))).toBe('SMTP 535 on AUTH')
        expect(fake.sent.some((s) => s.line.startsWith('MAIL'))).toBe(false)
    })

    it('leaves the server text out of errors, since it can quote an address', async () => {
        const fake = server({ RCPT: '550 5.1.1 <you@example.com>: Recipient address rejected' })
        expect(await failure(smtp.send(message, params, fake.ctx()))).toBe('SMTP 550 on RCPT TO')
    })

    it.each([
        ['greeting', { greeting: '250 not a greeting' }, 'SMTP 250 on greeting'],
        ['STARTTLS', { STARTTLS: '250 ok' }, 'SMTP 250 on STARTTLS'],
        ['AUTH', { AUTH: '250 ok' }, 'SMTP 250 on AUTH'],
        ['MAIL FROM', { MAIL: '251 ok' }, 'SMTP 251 on MAIL FROM'],
        ['DATA', { DATA: '350 go ahead' }, 'SMTP 350 on DATA'],
        ['the message', { DATA_END: '251 queued' }, 'SMTP 251 on DATA'],
    ])('accepts only the reply %s defines, not any code of the same class', async (_, overrides, error) => {
        const fake = server(overrides)
        expect(await failure(smtp.send(message, params, fake.ctx()))).toBe(error)
    })

    it('accepts 251 for a recipient the server will forward', async () => {
        const fake = server({ RCPT: '251 user not local; will forward' })
        await smtp.send(message, params, fake.ctx())
        expect(fake.sent.at(-1)!.line).toBe('QUIT')
    })

    it('fails when the server hangs up before accepting the mail', async () => {
        const fake = server({ DATA_END: null })
        expect(await failure(smtp.send(message, params, fake.ctx()))).toBe('SMTP connection closed')
    })

    it('counts the mail as sent once the server queued it, even if the connection drops at QUIT', async () => {
        const fake = server({ QUIT: 'reset' })
        await smtp.send(message, params, fake.ctx())
        expect(fake.closes()).toBeGreaterThan(0)
    })

    it('reads replies however the stream splits them', async () => {
        const fake = server({}, { bytewise: true })
        await smtp.send(message, params, fake.ctx())
        expect(fake.sent.at(-1)!.line).toBe('QUIT')
    })

    it('fails on a reply that is not SMTP, sending nothing', async () => {
        const fake = server({ greeting: 'HTTP/1.1 400 Bad Request' })
        expect(await failure(smtp.send(message, params, fake.ctx()))).toBe('SMTP malformed reply')
        expect(fake.sent).toEqual([])
    })

    it('closes the connection when the attempt is aborted', async () => {
        const fake = server({ DATA_END: 'hang' })
        const controller = new AbortController()
        const sending = failure(smtp.send(message, params, fake.ctx(controller.signal)))
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.abort(new DOMException('timeout', 'TimeoutError'))
        expect(await sending).toBe('SMTP connection closed')
        expect(fake.closes()).toBeGreaterThan(0)
    })

    it('sends to the message\'s own recipients when ALLOW_TO lets every one of them through', async () => {
        const fake = server()
        const to = 'Boss <Boss@Example.NET>, team@example.org'
        await smtp.send({ ...message, to: { mail: to } }, { ...params, ALLOW_TO: '*@example.org, boss@example.net' }, fake.ctx())
        const rcpt = fake.sent.filter((s) => s.line.startsWith('RCPT')).map((s) => s.line)
        expect(rcpt).toEqual(['RCPT TO:<Boss@Example.NET>', 'RCPT TO:<team@example.org>'])
        const data = fake.sent.find((s, i) => fake.sent[i - 1]?.line === 'DATA')!.line
        expect(parseMail(data).headers.to).toBe('"Boss" <Boss@Example.NET>, team@example.org')
    })

    it('lets any recipient through with ALLOW_TO=*', async () => {
        const fake = server()
        await smtp.send({ ...message, to: { mail: 'anyone@anywhere.example' } }, { ...params, ALLOW_TO: '*' }, fake.ctx())
        expect(fake.sent.filter((s) => s.line.startsWith('RCPT')).map((s) => s.line)).toEqual(['RCPT TO:<anyone@anywhere.example>'])
    })

    it('keeps TO when the message names recipients only for other channels', async () => {
        const fake = server()
        await smtp.send({ ...message, to: { other: 'team@example.org' } }, { ...params, ALLOW_TO: '*' }, fake.ctx())
        expect(fake.sent.filter((s) => s.line.startsWith('RCPT')).map((s) => s.line)).toEqual([
            'RCPT TO:<you@example.com>',
            'RCPT TO:<ops@example.com>',
        ])
    })

    it.each([
        ['a channel without ALLOW_TO', {}, 'you@example.com', 'custom recipients not enabled'],
        ['a recipient outside ALLOW_TO', { ALLOW_TO: '*@example.org' }, 'team@example.org, spy@example.com', 'recipient not allowed'],
        ['a subdomain of an allowed domain', { ALLOW_TO: '*@example.org' }, 'team@mail.example.org', 'recipient not allowed'],
        ['a malformed ALLOW_TO', { ALLOW_TO: 'example.org' }, 'team@example.org', 'invalid ALLOW_TO'],
    ])('refuses %s before connecting, never falling back to TO', async (_, extra, to, error) => {
        const fake = server()
        expect(await failure(smtp.send({ ...message, to: { mail: to } }, { ...params, ...extra }, fake.ctx()))).toBe(error)
        expect(fake.connections).toHaveLength(0)
    })

    it('reports a malformed ALLOW_TO even when a message has no recipients of its own', async () => {
        const fake = server()
        expect(await failure(smtp.send(message, { ...params, ALLOW_TO: '*@example.org,' }, fake.ctx()))).toBe('invalid ALLOW_TO')
    })

    it('does not connect when the attempt was aborted before it started', async () => {
        const fake = server()
        const controller = new AbortController()
        controller.abort(new DOMException('timeout', 'TimeoutError'))
        const error = await smtp.send(message, params, fake.ctx(controller.signal)).catch((e: unknown) => e)
        expect((error as DOMException).name).toBe('TimeoutError')
        expect(fake.connections).toHaveLength(0)
    })

    it.each([
        ['TO', 'not an address'],
        ['FROM', 'a@example.com, b@example.com'],
        ['TO', 'you@typo@example.com'],
        ['TO', 'ops@例え.jp'],
        ['PORT', 'smtp'],
        ['PORT', '70000'],
    ])('rejects a malformed %s before connecting', async (param, value) => {
        const fake = server()
        expect(await failure(smtp.send(message, { ...params, [param]: value }, fake.ctx()))).toBe(`invalid ${param}`)
        expect(fake.connections).toHaveLength(0)
    })
})
