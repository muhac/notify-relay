import type { HttpRequest, HttpResponseInit } from '@azure/functions'
import { type AppDeps, handle } from '../../app'
import { ORIGIN } from '../origin'

export function azure(env: object, deps: AppDeps): (request: HttpRequest) => Promise<HttpResponseInit> {
    return async (request) => {
        let response: Response
        try {
            response = await handle(toRequest(request), env, deps)
        } catch (error) {
            console.error(error)
            response = new Response(null, { status: 500 })
        }
        return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: response.body && new Uint8Array(await response.arrayBuffer()),
        }
    }
}

function toRequest(request: HttpRequest): Request {
    const { pathname, search } = new URL(request.url)
    const bodied = request.body && request.method !== 'GET' && request.method !== 'HEAD'
    return new Request(new URL(pathname + search, ORIGIN), {
        method: request.method,
        headers: request.headers,
        ...(bodied && { body: request.body, duplex: 'half' }),
    })
}
