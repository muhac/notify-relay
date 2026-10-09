import { handle } from './app'

export default {
    async fetch(request, env, _ctx): Promise<Response> {
        return handle(request, env, {
            fetch: (input, init) => fetch(input, init),
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        })
    },
} satisfies ExportedHandler<Env>
