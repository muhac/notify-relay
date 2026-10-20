import type { Outbound } from '../core/deliver'
import { gmail } from './gmail'
import { loki } from './loki'
import { smtp } from './smtp'

export const adapters: Record<string, Outbound> = Object.fromEntries(
    [loki, gmail, smtp].map((adapter) => [adapter.type, adapter]),
)
