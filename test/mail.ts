// Decoders for the mail the relay builds, shared by the tests of every mail channel type

export function utf8(base64: string): string {
    const binary = atob(base64.replaceAll('-', '+').replaceAll('_', '/').replace(/\s+/g, ''))
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

type Part = { headers: Record<string, string>; content: string }

function part(section: string): Part {
    const [head, ...rest] = section.split('\r\n\r\n')
    const headers = Object.fromEntries(
        head!.replace(/\r\n(?=[ \t])/g, '').split('\r\n').map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 2)]),
    )
    const content = rest.join('\r\n\r\n')
    return { headers, content: headers['content-transfer-encoding'] === 'base64' ? utf8(content) : content }
}

// Splits an RFC 5322 message into its raw header lines, its unfolded headers and its text parts
export function parseMail(text: string) {
    const mail = part(text)
    const boundary = /boundary="([^"]+)"/.exec(mail.headers['content-type'] ?? '')?.[1]
    const parts = boundary
        ? mail.content
              .split(`--${boundary}`)
              .slice(1, -1)
              .map((section) => part(section.replace(/^\r\n/, '').replace(/\r\n$/, '')))
        : [mail]
    return { lines: text.slice(0, text.indexOf('\r\n\r\n')).split('\r\n'), headers: mail.headers, parts }
}

// Decodes each encoded-word on its own and drops the whitespace between adjacent ones, as RFC 2047 says
export const decode = (header: string) =>
    header.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_, word: string) => utf8(word))
