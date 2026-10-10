import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'

const REQUIRES = ['LOKI_PUSH_URL', 'LOKI_USER', 'LOKI_TOKEN'] as const

// Labels carry only low-cardinality fields; key, url and the text go into the log line
export const loki: Outbound = {
    name: 'loki',
    requires: REQUIRES,
    async send(message, { fetch, env, now, signal }) {
        const url = setting(env, 'LOKI_PUSH_URL')
        const user = setting(env, 'LOKI_USER')
        const token = setting(env, 'LOKI_TOKEN')
        const { source, level, ...fields } = message
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Basic ${btoa(`${user}:${token}`)}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                streams: [
                    {
                        stream: { job: 'notify-relay', source, level },
                        values: [[(BigInt(now()) * 1_000_000n).toString(), JSON.stringify(fields)]],
                    },
                ],
            }),
            signal,
        })
        await expectOk(response)
    },
}

function setting(env: Env, name: (typeof REQUIRES)[number]): string {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
}
