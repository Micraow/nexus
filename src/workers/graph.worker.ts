import { buildGraph, type GraphInput } from '@/services/graph'
import type { GraphSnapshot } from '@/types/domain'

export interface GraphWorkerRequest extends GraphInput {
  key: string
}

export interface GraphWorkerResponse {
  key: string
  snapshot: GraphSnapshot
}

self.onmessage = (event: MessageEvent<GraphWorkerRequest>) => {
  const { key, ...input } = event.data
  const response: GraphWorkerResponse = { key, snapshot: buildGraph(input) }
  ;(self as unknown as Worker).postMessage(response)
}
