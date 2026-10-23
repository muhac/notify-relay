import { createServer, type Server } from 'node:net'
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connection } from '../../src/core/deliver'
import { connector } from '../../src/platforms/node/connect'
import { certificate } from './certificate'

const { key, cert } = certificate()
const trusted = connector({ ca: cert })
const servers: Server[] = []

afterEach(() => {
    for (const server of servers.splice(0)) server.close()
})

async function listen(server: Server): Promise<number> {
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as { port: number }).port
}

// Answers each line with 'echo <line>', as plain text until STARTTLS and over TLS after it
function lineServer() {
    const plain: string[] = []
    const encrypted: string[] = []
    const server = createServer((socket) => {
        socket.write('220 hello\r\n')
        socket.on('data', (chunk) => {
            const line = String(chunk).trim()
            plain.push(line)
            if (line !== 'STARTTLS') return void socket.write(`echo ${line}\r\n`)
            socket.removeAllListeners('data')
            socket.write('220 go ahead\r\n')
            const tls = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key, cert }) })
            tls.on('error', () => {})
            tls.on('data', (data) => {
                encrypted.push(String(data).trim())
                tls.write(`echo ${String(data).trim()}\r\n`)
            })
        })
    })
    return { server, plain, encrypted }
}

function tlsServer() {
    const received: string[] = []
    const server = createTlsServer({ key, cert }, (socket) => {
        socket.on('data', (data) => {
            received.push(String(data).trim())
            socket.write(`echo ${String(data).trim()}\r\n`)
        })
    })
    return { server, received }
}

async function line(connection: Connection): Promise<string> {
    const reader = connection.readable.getReader()
    try {
        const { value, done } = await reader.read()
        if (done) return '<closed>'
        return new TextDecoder().decode(value).trim()
    } finally {
        reader.releaseLock()
    }
}

async function write(connection: Connection, text: string): Promise<void> {
    const writer = connection.writable.getWriter()
    try {
        await writer.write(new TextEncoder().encode(`${text}\r\n`))
    } finally {
        writer.releaseLock()
    }
}

async function failure(connection: Connection): Promise<string> {
    try {
        await line(connection)
    } catch (error) {
        return (error as Error).message
    }
    throw new Error('read did not fail')
}

describe('node connect', () => {
    it('speaks TLS from the start when secureTransport is on, checking the certificate', async () => {
        const { server, received } = tlsServer()
        const port = await listen(server)
        const connection = trusted({ hostname: 'localhost', port }, { secureTransport: 'on', allowHalfOpen: false })

        await write(connection, 'EHLO relay')
        expect(await line(connection)).toBe('echo EHLO relay')
        expect(received).toEqual(['EHLO relay'])
        await connection.close()
    })

    it('upgrades a plain connection with startTls, sending nothing after it in the clear', async () => {
        const { server, plain, encrypted } = lineServer()
        const port = await listen(server)
        const connection = trusted({ hostname: 'localhost', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        expect(await line(connection)).toBe('220 hello')
        await write(connection, 'STARTTLS')
        expect(await line(connection)).toBe('220 go ahead')
        const secure = connection.startTls()
        await write(secure, 'AUTH PLAIN secret')
        expect(await line(secure)).toBe('echo AUTH PLAIN secret')

        expect(plain).toEqual(['STARTTLS'])
        expect(encrypted).toEqual(['AUTH PLAIN secret'])
        await secure.close()
    })

    it('drops plaintext that arrives with the STARTTLS reply', async () => {
        const server = createServer((socket) => {
            socket.write('220 hello\r\n')
            socket.once('data', () => {
                socket.write('220 go ahead\r\n250 injected\r\n')
                const tls = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key, cert }) })
                tls.on('error', () => {})
                tls.on('data', () => tls.write('250 over tls\r\n'))
            })
        })
        const port = await listen(server)
        const connection = trusted({ hostname: 'localhost', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        await line(connection)
        await write(connection, 'STARTTLS')
        await line(connection)
        const secure = connection.startTls()
        await write(secure, 'EHLO relay')
        expect(await line(secure)).toBe('250 over tls')
        await secure.close()
    })

    it('refuses a certificate it does not trust, naming no host', async () => {
        const { server } = tlsServer()
        const port = await listen(server)
        const connection = connector()({ hostname: 'localhost', port }, { secureTransport: 'on', allowHalfOpen: false })

        const message = await failure(connection)
        expect(message).toMatch(/^connection failed \([A-Z0-9_]+\)$/)
        expect(message).not.toContain('localhost')
    })

    it('refuses a certificate for another host', async () => {
        const { server } = tlsServer()
        const port = await listen(server)
        const connection = trusted({ hostname: '127.0.0.1', port }, { secureTransport: 'on', allowHalfOpen: false })

        expect(await failure(connection)).toBe('connection failed (ERR_TLS_CERT_ALTNAME_INVALID)')
    })

    it('checks the certificate after startTls as well', async () => {
        const { server } = lineServer()
        const port = await listen(server)
        const connection = connector()({ hostname: 'localhost', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        await line(connection)
        await write(connection, 'STARTTLS')
        await line(connection)
        expect(await failure(connection.startTls())).toMatch(/^connection failed \([A-Z0-9_]+\)$/)
    })

    it('fails a refused connection by its code, without the address', async () => {
        const port = await listen(createServer())
        servers.pop()!.close()
        await new Promise((resolve) => setTimeout(resolve, 10))
        const connection = trusted({ hostname: '127.0.0.1', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        expect(await failure(connection)).toBe('connection failed (ECONNREFUSED)')
    })

    it('fails the upgrade when the server keeps talking plaintext', async () => {
        const server = createServer((socket) => {
            socket.write('220 hello\r\n')
            socket.once('data', () => {
                socket.write('220 go ahead\r\n')
                setTimeout(() => socket.end('250 still plain\r\n'), 20)
            })
        })
        const port = await listen(server)
        const connection = trusted({ hostname: 'localhost', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        await line(connection)
        await write(connection, 'STARTTLS')
        await line(connection)
        expect(await failure(connection.startTls())).toMatch(/^connection failed \([A-Z0-9_]+\)$/)
    })

    it('ends the readable when the server closes after the upgrade', async () => {
        const server = createServer((socket) => {
            socket.write('220 hello\r\n')
            socket.once('data', () => {
                socket.write('220 go ahead\r\n')
                const tls = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key, cert }) })
                tls.on('error', () => {})
                tls.once('data', () => tls.end('221 bye\r\n'))
            })
        })
        const port = await listen(server)
        const connection = trusted({ hostname: 'localhost', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        await line(connection)
        await write(connection, 'STARTTLS')
        await line(connection)
        const secure = connection.startTls()
        await write(secure, 'QUIT')
        expect(await line(secure)).toBe('221 bye')
        expect(await line(secure)).toBe('<closed>')
    })

    it('ends the readable when the server closes', async () => {
        const server = createServer((socket) => socket.end('221 bye\r\n'))
        const port = await listen(server)
        const connection = trusted({ hostname: '127.0.0.1', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        expect(await line(connection)).toBe('221 bye')
        expect(await line(connection)).toBe('<closed>')
    })

    it('closes the socket, and closing twice is harmless', async () => {
        let closed!: () => void
        const gone = new Promise<void>((resolve) => (closed = resolve))
        const server = createServer((socket) => {
            socket.on('error', () => {})
            socket.on('close', () => closed())
            socket.write('220 hello\r\n')
        })
        const port = await listen(server)
        const connection = trusted({ hostname: '127.0.0.1', port }, { secureTransport: 'starttls', allowHalfOpen: false })

        await line(connection)
        await connection.close()
        await connection.close()
        await gone
    })

    it('refuses startTls on a connection that was TLS from the start', async () => {
        const { server } = tlsServer()
        const port = await listen(server)
        const connection = trusted({ hostname: 'localhost', port }, { secureTransport: 'on', allowHalfOpen: false })

        expect(() => connection.startTls()).toThrow('startTls needs secureTransport starttls')
        await connection.close()
    })
})
