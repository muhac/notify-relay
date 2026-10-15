export const LEVELS = ['low', 'normal', 'high', 'critical'] as const

export type Level = (typeof LEVELS)[number]

export interface Message {
    source: string
    title: string
    text?: string
    rich?: string
    level: Level
    url?: string
    key?: string
    group?: string
}

export type Draft = Omit<Message, 'source'>

export interface Inbound {
    parse(body: unknown): Draft[]
}
