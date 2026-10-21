import { param } from '../core/channels'
import type { Message } from '../core/message'

// Every part is base64, whose alphabet has no '_', so a fixed boundary can never occur in the content
const BOUNDARY = '_notify-relay_'
// RFC 2047 holds a line with encoded-words to 76 characters. Each word gets a line of its own, and 39 bytes
// of UTF-8 make a 64-character word, which fits after the longest prefix, 'Subject: '
const WORD_BYTES = 39
// One '@' between runs of printable ASCII that hold nothing delimiting a mailbox. An SMTP envelope without
// SMTPUTF8 carries ASCII only, so an internationalised domain goes in its xn-- form
const PART = String.raw`(?:(?![<>",@])[!-~])+`
const ADDRESS = new RegExp(`^${PART}@${PART}$`)
const MAILBOX = new RegExp(String.raw`^(.*?)\s*<(${PART}@${PART})>$`)
const DOMAIN = new RegExp(`^\\*@${PART}$`)

export interface Addressing {
    headers: string[]
    from: string | undefined
    to: string[]
}

// Why a channel refuses the recipients a message names for it, or undefined. A malformed ALLOW_TO refuses
// nothing here: only the operator can fix it, so delivery reports it instead
export function refuseRecipients(value: string, params: Record<string, string>): string | undefined {
    const mailboxes = parseAddresses(value)
    if (mailboxes === undefined) return 'must be one or more email addresses'
    if (params.ALLOW_TO === undefined) return 'custom recipients not enabled'
    const allowed = parseAllowlist(params.ALLOW_TO)
    if (allowed !== undefined && !mailboxes.every((mailbox) => allowed(mailbox.address))) return 'recipient not allowed'
    return undefined
}

// The recipients a message names for this channel, when it names any, otherwise TO. Never TO in their
// place: the mail would reach someone it was not meant for
export function recipients(params: Record<string, string>, named: string | undefined): string {
    if (params.ALLOW_TO !== undefined && parseAllowlist(params.ALLOW_TO) === undefined) throw new Error('invalid ALLOW_TO')
    if (named === undefined) return param(params, 'TO')
    const refused = refuseRecipients(named, params)
    if (refused !== undefined) throw new Error(refused)
    return named
}

// TO is one address or more and FROM exactly one; returns their headers and the bare addresses. The error
// never holds the value, which may be a secret
export function addressing(to: string, from: string | undefined): Addressing {
    const recipients = mailboxes(to, 'TO')
    const sender = from === undefined ? undefined : mailboxes(from, 'FROM')
    if (sender !== undefined && sender.length !== 1) throw new Error('invalid FROM')
    const headers = [`To: ${recipients.map((mailbox) => mailbox.header).join(',\r\n ')}`]
    if (sender?.[0]) headers.unshift(`From: ${sender[0].header}`)
    return { headers, from: sender?.[0]?.address, to: recipients.map((mailbox) => mailbox.address) }
}

// title is the subject; text, or the title when there is none, the plain body; rich the HTML alternative
export function mime(headers: string[], message: Message): string {
    const head = [...headers, `Subject: ${words(message.title)}`, 'MIME-Version: 1.0']
    const plain = part('text/plain', message.text || message.title)
    if (message.rich === undefined) return [...head, plain].join('\r\n')
    return [
        ...head,
        `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
        '',
        `--${BOUNDARY}`,
        plain,
        `--${BOUNDARY}`,
        part('text/html', message.rich),
        `--${BOUNDARY}--`,
    ].join('\r\n')
}

export function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

export function base64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}

function part(type: string, content: string): string {
    return [
        `Content-Type: ${type}; charset=UTF-8`,
        'Content-Transfer-Encoding: base64',
        '',
        (base64(utf8(content)).match(/.{1,76}/g) ?? []).join('\r\n'),
    ].join('\r\n')
}

function mailboxes(value: string, param: string): { header: string; address: string }[] {
    const parsed = parseAddresses(value)
    if (parsed === undefined) throw new Error(`invalid ${param}`)
    return parsed.map(({ name, address }) => {
        if (name === '') return { header: address, address }
        if (/^[\x20-\x7e]*$/.test(name)) return { header: `"${name.replace(/[\\"]/g, '\\$&')}" <${address}>`, address }
        return { header: `${words(name)}\r\n <${address}>`, address }
    })
}

// A comma-separated list of 'address' or 'name <address>', a name holding a comma in double quotes.
// Undefined when any entry is malformed
function parseAddresses(value: string): { name: string; address: string }[] | undefined {
    const parsed: { name: string; address: string }[] = []
    for (const item of split(value)) {
        const trimmed = item.trim()
        if (ADDRESS.test(trimmed)) {
            parsed.push({ name: '', address: trimmed })
            continue
        }
        const [, raw, address] = MAILBOX.exec(trimmed) ?? []
        const name = raw === undefined ? undefined : unquote(raw)
        if (name === undefined || address === undefined) return undefined
        parsed.push({ name, address })
    }
    return parsed
}

// A comma-separated list of '*', '*@domain' or an address, compared without case. Undefined when any
// pattern is malformed. '*@domain' covers that domain only, not its subdomains
function parseAllowlist(value: string): ((address: string) => boolean) | undefined {
    const patterns = value.split(',').map((pattern) => pattern.trim().toLowerCase())
    if (!patterns.every((pattern) => pattern === '*' || DOMAIN.test(pattern) || ADDRESS.test(pattern))) return undefined
    return (address) => {
        const lower = address.toLowerCase()
        const domain = `*${lower.slice(lower.lastIndexOf('@'))}`
        return patterns.some((pattern) => pattern === '*' || pattern === lower || pattern === domain)
    }
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
