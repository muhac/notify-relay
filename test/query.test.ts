import { describe, expect, it } from 'vitest'
import { parseChannels } from '../src/core/query'

const known = ['loki', 'discord', 'bark'] as const

function parse(search: string) {
    return parseChannels(new URL(`https://notify.example/webhook${search}`), known)
}

describe('parseChannels', () => {
    it('reads the primary group and the optional fallback', () => {
        expect(parse('?channels=loki')).toEqual({ channels: ['loki'], fallback: [] })
        expect(parse('?channels=loki,discord&fallback=bark')).toEqual({
            channels: ['loki', 'discord'],
            fallback: ['bark'],
        })
    })

    it('ignores blanks and repeats', () => {
        expect(parse('?channels=%20loki%20,,loki')).toEqual({ channels: ['loki'], fallback: [] })
    })

    it('requires a primary group', () => {
        expect(parse('')).toEqual({ error: 'channels is required' })
        expect(parse('?channels=')).toEqual({ error: 'channels is required' })
        expect(parse('?fallback=loki')).toEqual({ error: 'channels is required' })
    })

    it('rejects unknown channels', () => {
        expect(parse('?channels=pager')).toEqual({ error: "unknown channel 'pager'" })
        expect(parse('?channels=loki&fallback=pager')).toEqual({ error: "unknown channel 'pager'" })
    })

    it('rejects a channel in both groups', () => {
        expect(parse('?channels=loki&fallback=loki')).toEqual({ error: "'loki' is in both channels and fallback" })
    })
})
