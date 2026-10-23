import { connect } from 'cloudflare:sockets'
import { handle } from '../app'

export default {
    async fetch(request, env, _ctx): Promise<Response> {
        return handle(request, env, {
            fetch: (input, init) => fetch(input, init),
            connect,
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        })
    },
} satisfies ExportedHandler<Env>
