import type { Outbound } from '../core/deliver'
import { gmail } from './gmail'
import { loki } from './loki'

export const adapters: Record<string, Outbound> = Object.fromEntries(
    [loki, gmail].map((adapter) => [adapter.type, adapter]),
)
