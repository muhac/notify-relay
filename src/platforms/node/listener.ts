import type { IncomingMessage, ServerResponse } from 'node:http'
import { type AppDeps, handle } from '../../app'
import { ORIGIN } from '../origin'
import { fromNode } from './readable'

// `read` is a body a framework in front has already read off the request, which leaves nothing to stream
export function listener(env: object, deps: AppDeps): (req: IncomingMessage, res: ServerResponse, read?: Uint8Array) => Promise<void> {
    return async (req, res, read) => {
        const method = req.method ?? 'GET'
        const bodied = method !== 'GET' && method !== 'HEAD'
        const source = bodied && read === undefined ? fromNode(req, () => {}) : undefined
        let response: Response
        try {
            response = await handle(toRequest(req, method, bodied ? (read ?? source?.stream) : undefined), env, deps)
        } catch (error) {
            console.error(error)
            response = new Response(null, { status: 500 })
        }
        res.statusCode = response.status
        for (const [name, value] of response.headers) res.setHeader(name, value)
        res.end(new Uint8Array(await response.arrayBuffer()))
        // Node drains an unread body only if nothing ever listened to it, and a paused one stalls the connection
        source?.detach()
        req.resume()
    }
}

function toRequest(req: IncomingMessage, method: string, body: Uint8Array | ReadableStream<Uint8Array> | undefined): Request {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
        for (const item of [value ?? []].flat()) headers.append(name, item)
    }
    return new Request(new URL(req.url ?? '/', ORIGIN), { method, headers, ...(body && { body, duplex: 'half' }) })
}
