import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'

// Labels carry only low-cardinality fields; key, url and the text go into the log line
export const loki: Outbound = {
    type: 'loki',
    params: ['URL', 'USER', 'TOKEN'],
    async send(message, params, { fetch, now, signal }) {
        const { source, level, ...fields } = message
        const response = await fetch(param(params, 'URL'), {
            method: 'POST',
            headers: {
                authorization: `Basic ${btoa(`${param(params, 'USER')}:${param(params, 'TOKEN')}`)}`,
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
