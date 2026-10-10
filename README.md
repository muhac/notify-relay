# notify-relay

A stateless notification relay on Cloudflare Workers. Senders POST a message; the relay authenticates
them, validates the message and delivers it to the channels named in the URL, within the same request.
There is no queue, no database and no history.

- **Delivers, never stores.** Anything stateful (deduplication, grouping, acknowledgement, escalation,
  dead-man's switches) belongs upstream or in a service built for it, e.g. your alerting system.
- **The sender picks the channels.** They are part of the URL. The relay has no routing rules and no
  default channel.
- **Adapters on both sides.** Inbound adapters turn a sender's native payload into one message format;
  outbound adapters turn that message into a channel's API call. The core knows neither.
- **Not a pager.** If something must wake you up, send it to a paging service directly. A relay outage
  should cost you routine messages, not an incident.

```text
inbound adapters          message           outbound adapters
/webhook  ──→  Message  ──→  deliver  ──→  loki
```

## API

```http
POST /webhook?channels=loki HTTP/1.1
Authorization: Bearer nr_...
Content-Type: application/json

{"title": "deploy done", "level": "low"}
```

The URL says where to deliver and the body says what the message is. Every inbound endpoint works this
way; for an adapter that translates a third-party payload, the body is that payload unchanged.

| Query | Required | Meaning |
|---|---|---|
| `channels` | yes | Primary group: names of configured channels, comma-separated, delivered in parallel |
| `fallback` | no | Tried in order, only when the whole primary group failed, until one succeeds |

A channel that is not configured, a channel in both groups or a missing `channels` is a 400. Channel
names are the deployment's own (see [Channels](#channels)), not channel types.

`/webhook` takes the relay's own format:

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | One line |
| `body` | no | Plain text; channels that cannot fit it truncate |
| `level` | no | `low`, `normal` (default), `high` or `critical`. How loudly each channel notifies, never which channels |
| `url` | no | A link back to the source; https only |
| `key` | no | On channels that support it, a new message with the same key replaces the previous one |
| `group` | no | Display grouping |

Unknown fields are a 400, so a misspelled field fails at the sender instead of being dropped. Bodies over
64 KB are a 413.

### Responses

| Status | Meaning |
|---|---|
| 200 | At least one primary channel succeeded, or the primary group failed and a fallback succeeded |
| 204 | The inbound adapter produced no message (e.g. an empty alert group) |
| 400, 401, 404, 405, 413 | The request is wrong; retrying will not help |
| 502 | Every channel failed; retry |

200 and 502 list the outcome per channel, without any secret:

```json
{"messages": [{"delivered": ["loki"], "failed": [{"channel": "bark", "error": "timeout"}]}]}
```

A 400 body is `{"error": "<reason>"}`. A 401 has no body, only `WWW-Authenticate: Bearer`. Delivery is
at-least-once: an occasional duplicate is preferred to a silent loss, and `key` lets channels collapse
duplicates.

Each channel attempt times out after 5 seconds, enforced by the relay rather than left to the adapter.
A 429 whose `Retry-After` is a number of seconds no greater than 2 is retried once within the request.
A missing `Retry-After`, an HTTP date or a longer wait counts as a failure rather than blocking the
request; the caller retries.

### Health

`GET /healthz` needs no token and calls no channel. It answers 200 when at least one channel is
configured, every configured channel has a known type and all of that type's parameters, and at least
one source token exists; 503 otherwise, without saying what is missing. Channel types nobody configured
are not checked. Deploys do not check settings (see [Configuration](#configuration)), so point an
external probe here.

## Authentication

`Authorization: Bearer <token>`, one token per sender, stored as a Worker secret named
`TOKEN_<SOURCE>`. A token in `TOKEN_GITHUB` authenticates the source `github` (lowercase, `_` becomes
`-`). The source comes only from the token, never from the request, and adding a sender means adding a
secret, not changing code.

- A secret may hold several tokens separated by spaces, so a rotation can overlap.
- Tokens are compared in constant time against every candidate. Failures are a bare 401.
- Tokens are never accepted in the query string, which ends up in logs.

Generate a token with the `nr_` prefix, which makes it easy for secret scanners to recognise:

```bash
printf 'nr_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
```

## Channels

A *channel type* is code (`loki`); a *channel* is a configured instance of one, named by the deployment.
A deployment can configure several channels of the same type and none of another. Each channel is a set
of Worker bindings:

```text
CHANNEL_<NAME>_TYPE     the type, e.g. loki; declares the channel
CHANNEL_<NAME>_<PARAM>  one per parameter of that type
```

The channel's name is `<NAME>` in lowercase with `_` turned into `-`, so `CHANNEL_HOME_LAB_TYPE` declares
`home-lab`, used as `?channels=home-lab`. Parameters are looked up by their exact names. To the Worker a
variable and a secret are the same binding; keep the sensitive parameters as secrets.

```text
CHANNEL_LOGS_TYPE=loki                  # variable
CHANNEL_LOGS_URL=https://logs-prod-000.grafana.net/loki/api/v1/push
CHANNEL_LOGS_USER=123456
CHANNEL_LOGS_TOKEN=...                  # secret
CHANNEL_ARCHIVE_TYPE=loki               # a second channel of the same type
...
```

### `loki`

Pushes each message as one log line to Loki's `/loki/api/v1/push` with basic auth. Labels hold only
low-cardinality fields (`job="notify-relay"`, `source`, `level`); the rest of the message is the line's
JSON. Handy as a first channel: a line you can query is a positive signal that delivery works, and it
doubles as a record of everything sent.

| Parameter | Keep as | Meaning |
|---|---|---|
| `URL` | variable | e.g. `https://logs-prod-000.grafana.net/loki/api/v1/push` |
| `USER` | variable | Basic auth user (the Loki instance ID on Grafana Cloud) |
| `TOKEN` | secret | Basic auth password; on Grafana Cloud, an access policy token with `logs:write` only |

## Configuration

`wrangler.jsonc` holds nothing deployment-specific. Variables are passed at deploy time and secrets are
set on the Worker:

```bash
npm ci
npx wrangler deploy --var CHANNEL_LOGS_TYPE:loki --var CHANNEL_LOGS_URL:https://... --var CHANNEL_LOGS_USER:123456
npx wrangler secret put CHANNEL_LOGS_TOKEN
npx wrangler secret put TOKEN_GITHUB
```

- wrangler removes variables a deploy does not mention, so pass every `--var` on every deploy (or keep
  them in a config of your own).
- Secrets cannot be set on a Worker that does not exist yet, which is why none are listed under
  `secrets.required`: the first deploy succeeds, then `/healthz` stays 503 until the secrets are in.
- `workers_dev` and preview URLs are off and no routes are declared. Attach a custom domain yourself
  (dashboard, Terraform, or `routes` in your own config); deploys then leave it alone.

## Development

TypeScript, with no runtime dependencies: only Web APIs available in Workers (`fetch`, `crypto.subtle`).
The toolchain (wrangler, vitest with Cloudflare's plugin, typescript) is development-only. Node 24.

```bash
npm ci
npm test            # vitest, inside the Workers runtime (Miniflare)
npm run typecheck   # wrangler types, then tsc over src and test
npm run build       # wrangler deploy --dry-run: bundles without deploying or credentials
npm run dev         # a local Worker
```

`worker-configuration.d.ts` is generated by `wrangler types` and not committed, since it changes with
every wrangler release. Outbound adapters get `fetch` passed in, so tests assert on the requests a fake
`fetch` receives instead of mocking globals.

### Adding an adapter

- Inbound: implement `Inbound` (`parse(body) → Draft[]`, throwing `BadRequest` on invalid input) and map
  a path to it in `src/app.ts`.
- Outbound: implement `Outbound` (`type`, `params`, `send(message, params, ctx)`) and register it in
  `src/outbound/index.ts`. `send` gets the channel's own parameters, never the environment; `params` is
  what a channel of the type must configure and what `/healthz` checks. `TYPE` is reserved.

### Contract

The message format only grows: new optional fields are fine, changing or removing fields is not. A
format that needs an incompatible change gets a new endpoint instead.

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
