import type { Outbound } from '../core/deliver'
import { loki } from './loki'

export const outbounds: Record<string, Outbound> = Object.fromEntries([loki].map((outbound) => [outbound.name, outbound]))
