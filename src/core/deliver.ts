import type { Channel } from './channels'
import { RateLimited } from './http'
import type { Message } from './message'

// The subset of Cloudflare's sockets API that smtp uses, so its connect() fits as is
export interface Connection {
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    startTls(): Connection
    close(): Promise<void>
}

export type Connect = (
    address: { hostname: string; port: number },
    options: { secureTransport: 'on' | 'starttls'; allowHalfOpen: boolean },
) => Connection

export interface SendContext {
    fetch: typeof fetch
    connect: Connect
    now: () => number
    signal: AbortSignal
    channel: string
}

export interface Outbound {
    type: string
    params: readonly string[]
    optional?: readonly string[]
    recipients?: (value: string, params: Record<string, string>) => string | undefined
    send(message: Message, params: Record<string, string>, ctx: SendContext): Promise<void>
}

export interface Deps {
    channels: Map<string, Channel>
    fetch: typeof fetch
    connect: Connect
    now: () => number
    sleep: (ms: number) => Promise<void>
    timeoutMs?: number
}

export interface Outcome {
    ok: boolean
    delivered: string[]
    failed: { channel: string; error: string }[]
}

const TIMEOUT_MS = 5000
const MAX_WAIT_MS = 2000

export async function deliver(message: Message, channels: string[], fallback: string[], deps: Deps): Promise<Outcome> {
    const delivered: string[] = []
    const failed: Outcome['failed'] = []

    const errors = await Promise.all(channels.map((channel) => attempt(message, channel, deps)))
    channels.forEach((channel, i) => {
        const error = errors[i]
        if (error === undefined) delivered.push(channel)
        else failed.push({ channel, error })
    })

    if (delivered.length === 0) {
        for (const channel of fallback) {
            const error = await attempt(message, channel, deps)
            if (error === undefined) {
                delivered.push(channel)
                break
            }
            failed.push({ channel, error })
        }
    }

    return { ok: delivered.length > 0, delivered, failed }
}

async function attempt(message: Message, name: string, deps: Deps): Promise<string | undefined> {
    const channel = deps.channels.get(name)
    if (!channel) return 'unknown channel'
    const { adapter, params, missing } = channel
    if (!adapter) return `unknown type '${channel.type}'`
    if (missing.length > 0) return `missing ${missing.join(', ')}`
    for (let retried = false; ; retried = true) {
        try {
            await withTimeout(
                (signal) => adapter.send(message, params, { fetch: deps.fetch, connect: deps.connect, now: deps.now, signal, channel: name }),
                deps.timeoutMs ?? TIMEOUT_MS,
            )
            return undefined
        } catch (error) {
            if (error instanceof RateLimited && !retried && error.retryAfterMs <= MAX_WAIT_MS) {
                await deps.sleep(error.retryAfterMs)
                continue
            }
            return reason(error)
        }
    }
}

// Races the work instead of trusting the adapter to honour the signal
async function withTimeout(work: (signal: AbortSignal) => Promise<void>, ms: number): Promise<void> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new DOMException('timeout', 'TimeoutError')
            controller.abort(error)
            reject(error)
        }, ms)
    })
    try {
        await Promise.race([work(controller.signal), timeout])
    } finally {
        clearTimeout(timer)
    }
}

function reason(error: unknown): string {
    if (error instanceof RateLimited) return 'rate limited'
    if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout'
    if (error instanceof Error) return error.message
    return 'failed'
}
