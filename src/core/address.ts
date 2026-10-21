// One '@' between runs of printable ASCII that hold nothing delimiting a mailbox. An SMTP envelope without
// SMTPUTF8 carries ASCII only, so an internationalised domain goes in its xn-- form
const PART = String.raw`(?:(?![<>",@])[!-~])+`
const ADDRESS = new RegExp(`^${PART}@${PART}$`)
const MAILBOX = new RegExp(String.raw`^(.*?)\s*<(${PART}@${PART})>$`)
const DOMAIN = new RegExp(`^\\*@${PART}$`)

export interface Mailbox {
    name: string
    address: string
}

// A comma-separated list of 'address' or 'name <address>', a name holding a comma in double quotes.
// Undefined when any entry is malformed
export function parseAddresses(value: string): Mailbox[] | undefined {
    const mailboxes: Mailbox[] = []
    for (const item of split(value)) {
        const trimmed = item.trim()
        if (ADDRESS.test(trimmed)) {
            mailboxes.push({ name: '', address: trimmed })
            continue
        }
        const [, raw, address] = MAILBOX.exec(trimmed) ?? []
        const name = raw === undefined ? undefined : unquote(raw)
        if (name === undefined || address === undefined) return undefined
        mailboxes.push({ name, address })
    }
    return mailboxes
}

// A comma-separated list of '*', '*@domain' or an address, compared without case. Undefined when any
// pattern is malformed. '*@domain' covers that domain only, not its subdomains
export function parseAllowlist(value: string): ((address: string) => boolean) | undefined {
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
