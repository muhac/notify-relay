import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppDeps } from '../app'
import { connector } from './node/connect'
import { listener } from './node/listener'

// Express's request as the Functions Framework hands it over: whichever of its parsers took the body read
// it to the end and kept the bytes in rawBody; a body none of them took is still on the stream
export interface FrameworkRequest extends IncomingMessage {
    rawBody?: Buffer
}

// The framework builds its Express app after loading this module, and Express shows the client the stack
// of an error, such as a body that does not parse, unless NODE_ENV is production
process.env.NODE_ENV ??= 'production'

export function gcp(env: object, deps: AppDeps): (req: FrameworkRequest, res: ServerResponse) => Promise<void> {
    const serve = listener(env, deps)
    return (req, res) => serve(req, res, req.rawBody)
}

export const relay = gcp(process.env, {
    fetch: (input, init) => fetch(input, init),
    connect: connector(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
