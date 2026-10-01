import { runOptimizer } from './engine'
import type { CargoSpec, ContainerSpec, OptimizationResult, OptimizationSettings } from '../types'

interface OptimizationRequest {
  requestId: number
  container: ContainerSpec
  cargo: CargoSpec[]
  settings: Partial<OptimizationSettings>
}

self.onmessage = (event: MessageEvent<OptimizationRequest>) => {
  const { requestId, container, cargo, settings } = event.data
  const result: OptimizationResult = runOptimizer(container, cargo, settings)
  self.postMessage({ requestId, result })
}