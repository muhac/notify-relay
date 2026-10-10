import type { Channel } from './channels'
import { RateLimited } from './http'
import type { Message } from './message'

export interface SendContext {
    fetch: typeof fetch
    now: () => number
    signal: AbortSignal
}

// A channel type. Each configured channel of this type hands send() its own parameters
export interface Outbound {
    type: string
    // Read from CHANNEL_<NAME>_<PARAM>; deploys do not check them, /healthz reports any missing
    params: readonly string[]
    send(message: Message, params: Record<string, string>, ctx: SendContext): Promise<void>
}

export interface Deps {
    channels: Map<string, Channel>
    fetch: typeof fetch
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

// undefined on success, otherwise the reason it failed
async function attempt(message: Message, name: string, deps: Deps): Promise<string | undefined> {
    const channel = deps.channels.get(name)
    if (!channel) return 'unknown channel'
    const { adapter, params, missing } = channel
    if (!adapter) return `unknown type '${channel.type}'`
    if (missing.length > 0) return `missing ${missing.join(', ')}`
    for (let retried = false; ; retried = true) {
        try {
            await withTimeout(
                (signal) => adapter.send(message, params, { fetch: deps.fetch, now: deps.now, signal }),
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

// Does not rely on the adapter passing the signal on to fetch: when time is up, the attempt has failed
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
