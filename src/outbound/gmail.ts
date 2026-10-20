import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'
import type { Message } from '../core/message'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
// Every part is base64, whose alphabet has no '_', so a fixed boundary can never occur in the content
const BOUNDARY = '_notify-relay_'
// RFC 2047 holds a line with encoded-words to 76 characters. Each word gets a line of its own, and 39 bytes
// of UTF-8 make a 64-character word, which fits after the longest prefix, 'Subject: '
const WORD_BYTES = 39
const ADDRESS = /^[^\s<>",]+@[^\s<>",@]+$/
const MAILBOX = /^(.*?)\s*<([^\s<>",]+@[^\s<>",@]+)>$/

// Sends as the account that granted the refresh token, which only needs gmail.send. Each message mints
// its own access token: the relay keeps no state. Fields map one to one and nothing is added, so a
// sender writing for an email-to-SMS gateway controls every character that arrives
export const gmail: Outbound = {
    type: 'gmail',
    params: ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'TO'],
    optional: ['FROM'],
    async send(message, params, { fetch, signal }) {
        const addresses = [`To: ${mailboxes(param(params, 'TO'), 'TO').join(',\r\n ')}`]
        if (params.FROM !== undefined) {
            const from = mailboxes(params.FROM, 'FROM')
            if (from.length !== 1) throw new Error('invalid FROM')
            addresses.unshift(`From: ${from[0]}`)
        }

        const token = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: param(params, 'CLIENT_ID'),
                client_secret: param(params, 'CLIENT_SECRET'),
                refresh_token: param(params, 'REFRESH_TOKEN'),
                grant_type: 'refresh_token',
            }),
            signal,
        })
        if (!token.ok) {
            const error = await token.clone().json().then((body) => (body as { error?: unknown }).error, () => undefined)
            if (error === 'invalid_grant') throw new Error('refresh token revoked or expired (invalid_grant)')
            await expectOk(token)
        }
        const { access_token } = (await token.json()) as { access_token: string }

        const sent = await fetch(SEND_URL, {
            method: 'POST',
            headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ raw: base64(utf8(mime(addresses, message))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }),
            signal,
        })
        await expectOk(sent)
    },
}

function mime(addresses: string[], message: Message): string {
    const headers = [...addresses, `Subject: ${words(message.title)}`, 'MIME-Version: 1.0']
    const plain = part('text/plain', message.text || message.title)
    if (message.rich === undefined) return [...headers, plain].join('\r\n')
    return [
        ...headers,
        `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
        '',
        `--${BOUNDARY}`,
        plain,
        `--${BOUNDARY}`,
        part('text/html', message.rich),
        `--${BOUNDARY}--`,
    ].join('\r\n')
}

function part(type: string, content: string): string {
    return [
        `Content-Type: ${type}; charset=UTF-8`,
        'Content-Transfer-Encoding: base64',
        '',
        (base64(utf8(content)).match(/.{1,76}/g) ?? []).join('\r\n'),
    ].join('\r\n')
}

// A comma-separated list of 'address' or 'name <address>', with the name optionally quoted. The error never
// holds the value, which may be a secret
function mailboxes(value: string, param: string): string[] {
    return split(value).map((item) => {
        const trimmed = item.trim()
        if (ADDRESS.test(trimmed)) return trimmed
        const [, raw, address] = MAILBOX.exec(trimmed) ?? []
        const name = raw === undefined ? undefined : unquote(raw)
        if (name === undefined || address === undefined) throw new Error(`invalid ${param}`)
        if (name === '') return address
        if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/[\\"]/g, '\\$&')}" <${address}>`
        return `${words(name)}\r\n <${address}>`
    })
}

function split(value: string): string[] {
    const items: string[] = []
    let quoted = false
    let start = 0
    for (let i = 0; i < value.length; i++) {
        if (quoted && value[i] === '\\') i++
        else if (value[i] === '"') quoted = !quoted
        else if (!quoted && value[i] === ',') {
            items.push(value.slice(start, i))
            start = i + 1
        }
    }
    return [...items, value.slice(start)]
}

function unquote(name: string): string | undefined {
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(name)?.[1]
    if (quoted !== undefined) return quoted.replace(/\\(.)/g, '$1')
    return name.includes('"') ? undefined : name
}

function words(text: string): string {
    const chunks = ['']
    let size = 0
    for (const char of text) {
        const bytes = utf8(char).length
        if (size + bytes > WORD_BYTES) {
            chunks.push('')
            size = 0
        }
        chunks[chunks.length - 1] += char
        size += bytes
    }
    return chunks.map((chunk) => `=?UTF-8?B?${base64(utf8(chunk))}?=`).join('\r\n ')
}

function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

function base64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}
