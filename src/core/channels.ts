import type { Outbound } from './deliver'

const TYPE_KEY = /^CHANNEL_(.+)_TYPE$/

export interface Channel {
    name: string
    type: string
    adapter?: Outbound
    params: Record<string, string>
    missing: string[]
}

// CHANNEL_<NAME>_TYPE declares a channel; its parameters are CHANNEL_<NAME>_<PARAM> for each parameter
// its type declares, read by exact name, so CHANNEL_HOME_LAB_TYPE is the channel home-lab
export function resolveChannels(env: object, adapters: Record<string, Outbound>): Map<string, Channel> {
    const values = env as Record<string, unknown>
    const channels = new Map<string, Channel>()
    for (const [key, type] of Object.entries(values)) {
        const id = TYPE_KEY.exec(key)?.[1]
        if (id === undefined || typeof type !== 'string') continue
        const name = id.toLowerCase().replaceAll('_', '-')
        const adapter = adapters[type]
        const params: Record<string, string> = {}
        const missing: string[] = []
        const read = (param: string) => {
            const value = values[`CHANNEL_${id}_${param}`]
            if (typeof value === 'string' && value !== '') params[param] = value
            return param in params
        }
        for (const param of adapter?.params ?? []) if (!read(param)) missing.push(param)
        for (const param of adapter?.optional ?? []) read(param)
        channels.set(name, adapter ? { name, type, adapter, params, missing } : { name, type, params, missing })
    }
    return channels
}

export function param(params: Record<string, string>, name: string): string {
    const value = params[name]
    if (value === undefined) throw new Error(`missing ${name}`)
    return value
}
