import { connect as plainConnect, isIP, type Socket } from 'node:net'
import { type ConnectionOptions, connect as tlsConnect } from 'node:tls'
import type { Connect, Connection } from '../../core/deliver'
import { fromNode } from './readable'

// `tls` is for tests, which trust a certificate of their own; the relay keeps Node's CAs
export function connector(tls: ConnectionOptions = {}): Connect {
    return ({ hostname, port }, { secureTransport, allowHalfOpen }) => {
        const secure = (socket?: Socket) =>
            tlsConnect({
                ...tls,
                host: hostname,
                port,
                ...(isIP(hostname) === 0 && { servername: hostname }),
                ...(socket && { socket }),
            })
        if (secureTransport === 'on') return wrap(secure())
        const plain = plainConnect({ host: hostname, port, allowHalfOpen })
        return wrap(plain, () => wrap(secure(plain)))
    }
}

function wrap(socket: Socket, upgrade?: () => Connection): Connection {
    const source = fromNode(socket, () => void socket.destroy(), failure)
    return {
        readable: source.stream,
        writable: new WritableStream<Uint8Array>({
            write: (chunk) =>
                new Promise<void>((resolve, reject) => void socket.write(chunk, (error) => (error ? reject(failure(error)) : resolve()))),
            close: () => new Promise<void>((resolve) => void socket.end(resolve)),
            abort: () => void socket.destroy(),
        }),
        startTls() {
            if (!upgrade) throw new Error('startTls needs secureTransport starttls')
            // Plaintext still in flight is dropped with the old listeners; TLS reports errors from here on
            source.detach()
            socket.on('error', () => {})
            return upgrade()
        },
        close: () =>
            new Promise<void>((resolve) => {
                if (socket.closed) return resolve()
                socket.once('close', () => resolve())
                socket.destroy()
            }),
    }
}

// Node's messages name the host and address, which a failed delivery would pass on to the sender
function failure(error: NodeJS.ErrnoException): Error {
    return new Error(error.code ? `connection failed (${error.code})` : 'connection failed')
}
