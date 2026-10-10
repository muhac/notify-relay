import { authenticate, hasSources } from './core/auth'
import { type Channel, resolveChannels } from './core/channels'
import { deliver, type Outcome } from './core/deliver'
import { BadRequest } from './core/http'
import type { Inbound } from './core/message'
import { parseChannels } from './core/query'
import { webhook } from './inbound/webhook'
import { adapters } from './outbound'

export interface AppDeps {
    fetch: typeof fetch
    now: () => number
    sleep: (ms: number) => Promise<void>
}

const MAX_BODY_BYTES = 64 * 1024

const inbounds: Record<string, Inbound> = { '/webhook': webhook }

// The order matters: the token is checked before the query or body, so an unauthenticated caller
// learns nothing from validation and never has its body read
export async function handle(request: Request, env: Env, deps: AppDeps): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
        if (request.method !== 'GET') return methodNotAllowed('GET')
        return ready(resolveChannels(env, adapters), env) ? new Response('ok') : new Response('not ready', { status: 503 })
    }

    const inbound = inbounds[url.pathname]
    if (!inbound) return new Response(null, { status: 404 })
    if (request.method !== 'POST') return methodNotAllowed('POST')

    const source = authenticate(request.headers.get('authorization'), env)
    if (!source) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } })

    const channels = resolveChannels(env, adapters)
    const routing = parseChannels(url, [...channels.keys()])
    if ('error' in routing) return badRequest(routing.error)

    const raw = await readBody(request)
    if (raw === undefined) return new Response(null, { status: 413 })

    let drafts
    try {
        drafts = inbound.parse(parseJson(raw))
    } catch (error) {
        if (error instanceof BadRequest) return badRequest(error.message)
        throw error
    }
    if (drafts.length === 0) return new Response(null, { status: 204 })

    const outcomes: Outcome[] = []
    for (const draft of drafts) {
        outcomes.push(await deliver({ ...draft, source }, routing.channels, routing.fallback, { ...deps, channels }))
    }
    return Response.json(
        { messages: outcomes.map(({ delivered, failed }) => ({ delivered, failed })) },
        { status: outcomes.every((outcome) => outcome.ok) ? 200 : 502 },
    )
}

// Ready when at least one channel is configured, every configured channel has a known type and all
// its parameters, and some source can authenticate. Says nothing more: /healthz is unauthenticated
function ready(channels: Map<string, Channel>, env: Env): boolean {
    const configured = [...channels.values()]
    const complete = configured.every((channel) => channel.adapter !== undefined && channel.missing.length === 0)
    return configured.length > 0 && complete && hasSources(env)
}

// Counts while reading and stops past the limit: Content-Length is not trusted, and an oversized
// body is never held in memory
async function readBody(request: Request): Promise<string | undefined> {
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return undefined
    if (!request.body) return ''
    const reader = request.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    let text = ''
    for (;;) {
        const { done, value } = await reader.read()
        if (done) return text + decoder.decode()
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
            await reader.cancel()
            return undefined
        }
        text += decoder.decode(value, { stream: true })
    }
}

function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw)
    } catch {
        throw new BadRequest('body must be valid JSON')
    }
}

function badRequest(error: string): Response {
    return Response.json({ error }, { status: 400 })
}

function methodNotAllowed(allow: string): Response {
    return new Response(null, { status: 405, headers: { allow } })
}
