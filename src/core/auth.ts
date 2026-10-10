const PREFIX = 'TOKEN_'

export function constantTimeEqual(a: string, b: string): boolean {
    const x = new TextEncoder().encode(a)
    const y = new TextEncoder().encode(b)
    let diff = x.length ^ y.length
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
    }
    return diff === 0
}

export function hasSources(env: object): boolean {
    return Object.entries(env).some(([name, value]) => name.startsWith(PREFIX) && typeof value === 'string' && value.trim())
}

// The source comes only from the token: a token in TOKEN_LAPTOP_MAC belongs to laptop-mac. Every token is
// compared, with no early return
export function authenticate(header: string | null, env: object): string | undefined {
    const presented = /^Bearer (\S+)$/i.exec(header ?? '')?.[1]
    if (!presented) return undefined
    let source: string | undefined
    for (const [name, value] of Object.entries(env)) {
        if (!name.startsWith(PREFIX) || typeof value !== 'string') continue
        for (const token of value.split(/\s+/)) {
            if (token && constantTimeEqual(presented, token) && !source) {
                source = name.slice(PREFIX.length).toLowerCase().replaceAll('_', '-')
            }
        }
    }
    return source
}
