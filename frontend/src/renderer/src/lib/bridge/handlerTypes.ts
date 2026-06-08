// Shared contract for inbound bridge handler maps.
//
// Each inbound message type maps to a handler that receives exactly that
// type's validated payload. Domain handler modules export a
// `BridgeInboundHandlers<subset>` keyed by the types they own; the dispatcher
// merges them and asserts the merged map covers the full union, so the
// compiler enforces exhaustive coverage instead of a hand-maintained switch.

import type { BridgeInboundMap, BridgeInboundType } from '@shared/bridge-protocol'

export type BridgeInboundHandler<K extends BridgeInboundType> = (payload: BridgeInboundMap[K]) => void

export type BridgeInboundHandlers<K extends BridgeInboundType = BridgeInboundType> = {
  [T in K]: BridgeInboundHandler<T>
}
