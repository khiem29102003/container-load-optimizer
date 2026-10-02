export type StrategyName =
  | 'largest-volume'
  | 'largest-base'
  | 'largest-weight'
  | 'largest-height'
  | 'density'
  | 'delivery'
  | 'hybrid'

export interface ContainerSpec {
  id: string
  name: string
  length: number
  width: number
  height: number
  payload: number
  tareWeight: number
  maxGrossWeight: number
  doorWidth: number
  doorHeight: number
  clearance: number
}

export interface CargoSpec {
  id: string
  sku: string
  name: string
  length: number
  width: number
  height: number
  weight: number
  quantity: number
  fragile: boolean
  stackable: boolean
  maxStackWeight: number
  maxLayers: number
  noRotate: boolean
  allowedRotations: number[]
  thisSideUp: boolean
  floorOnly: boolean
  priority: number
  group: string
  unloadSequence: number
  clearance: number
  temperatureGroup: string
  notes: string
  extraFields?: Record<string, unknown>
}

export interface Placement {
  id: string
  itemId: string
  sku: string
  name: string
  x: number
  y: number
  z: number
  length: number
  width: number
  height: number
  weight: number
  rotation: number[]
  orientationKey: string
  group: string
  unloadSequence: number
  containerIndex: number
}

export interface ValidationResult {
  valid: boolean
  reasons: string[]
  supportRatio?: number
}

export interface ContainerPlan {
  index: number
  container: ContainerSpec
  placements: Placement[]
  utilization: number
  usedVolume: number
  totalWeight: number
  centerOfGravity: { x: number; y: number; z: number }
}

export interface UnloadedItem {
  sku: string
  reason: string
  suggested: string
}

export interface OptimizationSettings {
  minSupportRatio: number
  maxCgOffset: number
  defaultClearance: number
  optimizationIterations: number
  candidateLimit: number
  allowRotation: boolean
  balanceWeight: number
  volumeWeight: number
  containerCountWeight: number
  fragilityWeight: number
  loadingSequenceWeight: number
}

export interface OptimizationResult {
  containers: ContainerPlan[]
  loaded: Placement[]
  unloaded: UnloadedItem[]
  warnings: string[]
  score: number
  volumeUtilization: number
  payloadUtilization: number
  totalCargoWeight: number
  usedVolume: number
  unusedVolume: number
  totalContainers: number
  strategy: StrategyName
  logs: string[]
  centerOfGravity: { x: number; y: number; z: number }
  bestSolution?: string
}

export interface LoadingProject {
  id: string
  owner_id: string
  name: string
  container: ContainerSpec
  cargo: CargoSpec[]
  plan: OptimizationResult | null
  created_at: string
  updated_at: string
}
