import type { Outbound } from '../core/deliver'
import { loki } from './loki'

export const adapters: Record<string, Outbound> = Object.fromEntries([loki].map((adapter) => [adapter.type, adapter]))
