# notify-relay

A stateless notification relay on Cloudflare Workers. Senders POST a message; the relay authenticates
them, validates the message and delivers it to the channels named in the URL, within the same request.
There is no queue, no database and no history.

- **Delivers, never stores.** Anything stateful (deduplication, grouping, acknowledgement, escalation,
  dead-man's switches) belongs upstream or in a service built for it, e.g. your alerting system.
- **The sender picks the channels.** They are part of the URL. The relay has no routing rules and no
  default channel.
- **The sender owns the content.** Channels put each field in its slot and add nothing; the relay never
  joins, converts or strips text. A sender writing for a constrained channel controls every character
  that arrives.
- **Adapters on both sides.** Inbound adapters turn a sender's native payload into one message format;
  outbound adapters turn that message into a channel's API call. The core knows neither.
- **Not a pager.** If something must wake you up, send it to a paging service directly. A relay outage
  should cost you routine messages, not an incident.

```text
inbound adapters          message           outbound adapters
/webhook  ──→  Message  ──→  deliver  ──→  loki, smtp, gmail
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
| `text` | no | Plain text |
| `rich` | no | Formatted text in the channel's own markup: HTML for `smtp` and `gmail`, Markdown where a channel renders it |
| `level` | no | `low`, `normal` (default), `high` or `critical`. How loudly each channel notifies, never which channels |
| `url` | no | A link back to the source; https only |
| `key` | no | On channels that support it, a new message with the same key replaces the previous one |
| `group` | no | Display grouping |
| `to` | no | Recipients by channel name, e.g. `{"mail": "ops@example.com"}`; see [Recipients](#recipients) |

`title`, `text` and `rich` are the content. A channel that renders markup shows `rich` when it is given,
the others show `text`; the relay neither checks that the two agree nor derives one from the other.
`level`, `url`, `key` and `group` are metadata, used by the channels that have a place for them and
ignored by the rest; each channel type below says which it uses. `to` is checked as
[Recipients](#recipients) describes. An empty `text`, `rich`, `key` or `group` counts as left out.

Unknown fields are a 400, so a misspelled field fails at the sender instead of being dropped. Bodies over
64 KB are a 413.

### Recipients

A channel delivers to its configured recipients (`TO` on mail channels) unless `to` names others for it:

```json
{"title": "invoice paid", "to": {"mail": "Jane <jane@example.com>"}}
```

Each entry must name a channel in `channels` or `fallback`, of a type that takes recipients (`smtp`,
`gmail`), written in that type's syntax and admitted by the channel's `ALLOW_TO`; otherwise the request is
a 400 and nothing is delivered. A channel without an entry, a fallback included, uses its own recipients.
Any sender token can reach whoever `ALLOW_TO` admits, so keep it narrow.

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
configured, every configured channel has a known type and all of that type's required parameters, and at
least one source token exists; 503 otherwise, without saying what is missing. Channel types nobody
configured are not checked. Deploys do not check settings (see [Configuration](#configuration)), so point
an external probe here.

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
CHANNEL_<NAME>_<PARAM>  one per parameter of that type; optional ones may be left out
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
low-cardinality fields (`job="notify-relay"`, `source`, `level`); every other field is in the line's JSON
as sent. Handy as a first channel: a line you can query is a positive signal that delivery works, and it
doubles as a record of everything sent.

| Parameter | Keep as | Meaning |
|---|---|---|
| `URL` | variable | e.g. `https://logs-prod-000.grafana.net/loki/api/v1/push` |
| `USER` | variable | Basic auth user (the Loki instance ID on Grafana Cloud) |
| `TOKEN` | secret | Basic auth password; on Grafana Cloud, an access policy token with `logs:write` only |

### `smtp`

Submits an email to an SMTP server, a mailbox provider's or a sending service's. `title` is the subject,
`text` the plain-text body (the title again when there is none), and `rich`, when given, the HTML
alternative. `url`, `key`, `group` and `level` are not used: a link belongs in the content.

Each message opens its own connection and authenticates with `AUTH PLAIN` over TLS: implicit on port 465,
`STARTTLS` on any other. A server that refuses `STARTTLS` fails the delivery.

| Parameter | Keep as | Meaning |
|---|---|---|
| `HOST` | variable | The submission server, e.g. `smtp.example.com` |
| `PORT` | variable, optional | Defaults to 587. Workers cannot connect to port 25 |
| `USER` | variable or secret | The SMTP user name |
| `PASSWORD` | secret | Its password |
| `FROM` | variable | The sender; the server must let `USER` send as it |
| `TO` | variable or secret | The recipients unless `to` names others for this channel |
| `ALLOW_TO` | variable, optional | Recipients a message may name in `to`: `*`, `*@example.com` (not its subdomains) or addresses, comma-separated. Without it, none |

`TO` and recipients in `to` are one address or several, comma-separated, and `FROM` exactly one; each is
`address` or `Name <address>`, with a name holding a comma in double quotes. Names may be in any script;
addresses are ASCII, so an internationalised domain goes in its `xn--` form. A rejected SMTP step fails
delivery as e.g. `SMTP 535 on AUTH`, without the server's text, which can quote an address.

With a mailbox provider, send from an account of its own: an app password usually opens the whole
mailbox over IMAP too, not only sending.

### `gmail`

Sends an email through the Gmail API, as the Google account that granted the refresh token. The mail is
the one `smtp` sends. Each message first exchanges the refresh token for an access token; nothing is
cached.

| Parameter | Keep as | Meaning |
|---|---|---|
| `CLIENT_ID` | variable | OAuth client of type *Desktop app* |
| `CLIENT_SECRET` | secret | That client's secret |
| `REFRESH_TOKEN` | secret | Granted with the `https://www.googleapis.com/auth/gmail.send` scope only |
| `TO` | variable or secret | The recipients unless `to` names others for this channel |
| `FROM` | variable, optional | The sender's name, as `Name <address>`. Without it, Gmail uses the account's own name |
| `ALLOW_TO` | variable, optional | Which recipients a message may name in `to`. Without it, none |

`TO`, `FROM` and `ALLOW_TO` work as for `smtp`. The `FROM` address must be the account's own or one of its
verified *Send mail as* aliases.

Getting the refresh token, once:

- Use a dedicated Google account for sending, so a runaway sender hits its daily limit, not yours.
- In Google Cloud, enable the Gmail API, add `gmail.send` under the OAuth consent screen's data access,
  and **publish the app to production**: in testing, refresh tokens expire after 7 days. An unverified app
  works for its owner; the consent screen shows a warning.
- Run the authorization-code flow with a loopback redirect (`http://127.0.0.1:<port>`),
  `access_type=offline` and `prompt=consent`, then exchange the code for the refresh token.

The token stays valid until the grant is revoked, the account's password changes, or it goes unused for
six months. A dead token fails delivery with `refresh token revoked or expired (invalid_grant)`;
`/healthz` cannot see it, since the parameters are still set.

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

TypeScript, with no runtime dependencies: only APIs available in Workers (`fetch`, `crypto.subtle`, TCP
sockets from `cloudflare:sockets`). The toolchain (wrangler, vitest with Cloudflare's plugin, typescript)
is development-only. Node 24.

```bash
npm ci
npm test            # vitest, inside the Workers runtime (Miniflare)
npm run typecheck   # wrangler types, then tsc over src and test
npm run build       # wrangler deploy --dry-run: bundles without deploying or credentials
npm run dev         # a local Worker
```

`worker-configuration.d.ts` is generated by `wrangler types` and not committed, since it changes with
every wrangler release. Outbound adapters get `fetch` and `connect` passed in, so tests assert on what a
fake `fetch` or a scripted fake server receives instead of mocking globals.

`npm run test:live` sends through real channels instead: a Loki push that it then reads back, and mail
to one SMTP server over 587 and 465, which passes once the server accepts it. It needs `LIVE_LOKI_URL`,
`LIVE_LOKI_USER` and `LIVE_LOKI_TOKEN` (`logs:write` and `logs:read`), and `LIVE_SMTP_HOST`,
`LIVE_SMTP_USER`, `LIVE_SMTP_PASSWORD` and `LIVE_SMTP_ADDRESS` (sender and recipient both). The
[Live](.github/workflows/live.yml) workflow runs it on `main`, weekly and by hand.

### Adding an adapter

- Inbound: implement `Inbound` (`parse(body) → Draft[]`, throwing `BadRequest` on invalid input) and map
  a path to it in `src/app.ts`.
- Outbound: implement `Outbound` (`type`, `params`, `send(message, params, ctx)`) and register it in
  `src/outbound/index.ts`. `send` gets the channel's own parameters, never the environment; `params` is
  what a channel of the type must configure and what `/healthz` checks; `optional` lists the ones it may
  configure, passed when set and never checked. A type that takes recipients implements
  `recipients(value, params)`, returning why it refuses an entry of `to`, and reads its own entry as
  `message.to?.[ctx.channel]`. `TYPE` is reserved.

### Contract

The message format only grows: new optional fields are fine, changing or removing fields is not. A
format that needs an incompatible change gets a new endpoint instead.

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
