// Channel settings are typed here rather than through wrangler's `vars` or `secrets.required`: they
// belong to each deployment, not to this repo, and requiring secrets would make the first deploy of a
// new Worker fail, since secrets can only be set on a Worker that already exists. Any of them may be
// missing; /healthz reports it.
interface Env {
    LOKI_PUSH_URL?: string
    LOKI_USER?: string
    LOKI_TOKEN?: string
}
