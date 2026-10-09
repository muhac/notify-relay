import { BadRequest } from '../core/http'
import { LEVELS, type Draft, type Inbound, type Level } from '../core/message'

const FIELDS = new Set(['title', 'body', 'level', 'url', 'key', 'group'])

export const webhook: Inbound = {
    parse(body) {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new BadRequest('body must be a JSON object')
        }
        const input = body as Record<string, unknown>
        for (const field of Object.keys(input)) {
            if (!FIELDS.has(field)) throw new BadRequest(`unknown field '${field}'`)
        }

        const draft: Draft = { title: title(input.title), level: level(input.level) }
        const text = optionalString(input, 'body')
        if (text !== undefined) draft.body = text
        if (input.url !== undefined) draft.url = https(input.url)
        const key = optionalString(input, 'key')
        if (key !== undefined) draft.key = key
        const group = optionalString(input, 'group')
        if (group !== undefined) draft.group = group
        return [draft]
    },
}

function title(value: unknown): string {
    if (value === undefined) throw new BadRequest('title is required')
    if (typeof value !== 'string') throw new BadRequest('title must be a string')
    if (value.trim() === '') throw new BadRequest('title is required')
    if (/[\r\n]/.test(value)) throw new BadRequest('title must be one line')
    return value
}

function level(value: unknown): Level {
    if (value === undefined) return 'normal'
    const found = LEVELS.find((known) => known === value)
    if (!found) throw new BadRequest(`level must be one of ${LEVELS.join(', ')}`)
    return found
}

function https(value: unknown): string {
    if (typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:') return value
    throw new BadRequest('url must be https')
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
    const value = input[field]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new BadRequest(`${field} must be a string`)
    return value
}
