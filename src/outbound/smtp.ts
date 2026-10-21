import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { addressing, base64, mime, recipients, refuseRecipients, utf8 } from './mail'

export const smtp: Outbound = {
    type: 'smtp',
    params: ['HOST', 'USER', 'PASSWORD', 'FROM', 'TO'],
    optional: ['PORT', 'ALLOW_TO'],
    recipients: refuseRecipients,
    async send(message, params, { connect, now, signal, channel }) {
        const { headers, from, to } = addressing(recipients(params, message.to?.[channel]), param(params, 'FROM'))
        const port = Number(params.PORT ?? '587')
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT')
        const domain = from!.slice(from!.lastIndexOf('@') + 1)
        const date = new Date(now()).toUTCString().replace('GMT', '+0000')
        const data = mime([...headers, `Date: ${date}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`], message)
        const login = base64(utf8(`\0${param(params, 'USER')}\0${param(params, 'PASSWORD')}`))

        const implicit = port === 465
        signal.throwIfAborted()
        let socket = connect(
            { hostname: param(params, 'HOST'), port },
            { secureTransport: implicit ? 'on' : 'starttls', allowHalfOpen: false },
        )
        const close = () => void socket.close().catch(() => {})
        signal.addEventListener('abort', close, { once: true })
        try {
            let session = new Session(socket)
            await session.step(undefined, 'greeting', [220])
            if (!implicit) {
                await session.step(`EHLO ${domain}`, 'EHLO')
                await session.step('STARTTLS', 'STARTTLS', [220])
                // A new session drops plaintext sent after the 220, which an attacker could inject
                session.release()
                socket = socket.startTls()
                session = new Session(socket)
            }
            await session.step(`EHLO ${domain}`, 'EHLO')
            await session.step(`AUTH PLAIN ${login}`, 'AUTH', [235])
            await session.step(`MAIL FROM:<${from}>`, 'MAIL FROM')
            for (const address of to) await session.step(`RCPT TO:<${address}>`, 'RCPT TO', [250, 251])
            await session.step('DATA', 'DATA', [354])
            // No dot-stuffing: no header, boundary or base64 line can start with '.'
            await session.step(`${data}\r\n.`, 'DATA')
            await session.send('QUIT').catch(() => {})
        } finally {
            signal.removeEventListener('abort', close)
            close()
        }
    },
}

const encoder = new TextEncoder()

class Session {
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>
    private readonly decoder = new TextDecoder()
    private buffer = ''

    constructor(socket: Socket) {
        this.reader = socket.readable.getReader()
        this.writer = socket.writable.getWriter()
    }

    async step(line: string | undefined, step: string, accepted = [250]): Promise<void> {
        if (line !== undefined) await this.send(line)
        const code = await this.reply()
        if (!accepted.includes(code)) throw new Error(`SMTP ${code} on ${step}`)
    }

    async send(line: string): Promise<void> {
        await this.writer.write(encoder.encode(`${line}\r\n`))
    }

    release(): void {
        this.reader.releaseLock()
        this.writer.releaseLock()
    }

    private async reply(): Promise<number> {
        for (;;) {
            for (let end; (end = this.buffer.indexOf('\r\n')) >= 0; ) {
                const line = this.buffer.slice(0, end)
                this.buffer = this.buffer.slice(end + 2)
                const code = /^(\d{3})([ -]|$)/.exec(line)
                if (!code) throw new Error('SMTP malformed reply')
                if (code[2] !== '-') return Number(code[1])
            }
            const { value, done } = await this.reader.read()
            if (done) throw new Error('SMTP connection closed')
            this.buffer += this.decoder.decode(value, { stream: true })
        }
    }
}
