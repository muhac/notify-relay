import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { addressing, base64, mime, utf8 } from './mail'

// Submission with AUTH PLAIN, one connection per message: the relay keeps no state. Port 465 is encrypted
// from the first byte, any other upgrades with STARTTLS. The message is the one gmail sends, plus the Date
// and Message-ID that Gmail would have added
export const smtp: Outbound = {
    type: 'smtp',
    params: ['HOST', 'USER', 'PASSWORD', 'FROM', 'TO'],
    optional: ['PORT'],
    async send(message, params, { connect, now, signal }) {
        const { headers, from, to } = addressing(param(params, 'TO'), param(params, 'FROM'))
        const port = Number(params.PORT ?? '587')
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT')
        const domain = from!.slice(from!.lastIndexOf('@') + 1)
        const date = new Date(now()).toUTCString().replace('GMT', '+0000')
        const data = mime([...headers, `Date: ${date}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`], message)
        const login = base64(utf8(`\0${param(params, 'USER')}\0${param(params, 'PASSWORD')}`))

        const implicit = port === 465
        let socket = connect(
            { hostname: param(params, 'HOST'), port },
            { secureTransport: implicit ? 'on' : 'starttls', allowHalfOpen: false },
        )
        const close = () => void socket.close().catch(() => {})
        signal.addEventListener('abort', close, { once: true })
        try {
            let session = new Session(socket)
            await session.step(undefined, 'greeting')
            if (!implicit) {
                await session.step(`EHLO ${domain}`, 'EHLO')
                await session.step('STARTTLS', 'STARTTLS')
                // A new session drops whatever arrived in plaintext after the 220, so nothing injected before
                // the handshake is read as a reply
                session.release()
                socket = socket.startTls()
                session = new Session(socket)
            }
            await session.step(`EHLO ${domain}`, 'EHLO')
            await session.step(`AUTH PLAIN ${login}`, 'AUTH')
            await session.step(`MAIL FROM:<${from}>`, 'MAIL FROM')
            for (const address of to) await session.step(`RCPT TO:<${address}>`, 'RCPT TO')
            await session.step('DATA', 'DATA', 3)
            // Every line is a header, a boundary or base64, and none of them can start with '.', so the data
            // needs no dot-stuffing
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

    // Sends a line, if any, and fails unless the reply's code is in the expected class. The error names the
    // step and the code, never the server's text, which can quote an address
    async step(line: string | undefined, step: string, expected = 2): Promise<void> {
        if (line !== undefined) await this.send(line)
        const code = await this.reply()
        if (Math.floor(code / 100) !== expected) throw new Error(`SMTP ${code} on ${step}`)
    }

    async send(line: string): Promise<void> {
        await this.writer.write(encoder.encode(`${line}\r\n`))
    }

    release(): void {
        this.reader.releaseLock()
        this.writer.releaseLock()
    }

    // A reply is one or more lines; every line but the last has a '-' right after the code
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
