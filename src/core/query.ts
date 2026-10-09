export type Routing = { channels: string[]; fallback: string[] } | { error: string }

export function parseChannels(url: URL, known: readonly string[]): Routing {
    const channels = list(url.searchParams.get('channels'))
    const fallback = list(url.searchParams.get('fallback'))
    if (channels.length === 0) return { error: 'channels is required' }
    for (const name of [...channels, ...fallback]) {
        if (!known.includes(name)) return { error: `unknown channel '${name}'` }
    }
    const both = channels.find((name) => fallback.includes(name))
    if (both) return { error: `'${both}' is in both channels and fallback` }
    return { channels, fallback }
}

function list(value: string | null): string[] {
    const names = (value ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    return [...new Set(names)]
}
