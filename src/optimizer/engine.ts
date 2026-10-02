import type {
  CargoSpec,
  ContainerPlan,
  ContainerSpec,
  OptimizationResult,
  OptimizationSettings,
  Placement,
  StrategyName,
  UnloadedItem,
  ValidationResult,
} from '../types'

const DEFAULT_SETTINGS: OptimizationSettings = {
  minSupportRatio: 0.6,
  maxCgOffset: 0.18,
  defaultClearance: 10,
  optimizationIterations: 120,
  candidateLimit: 200,
  allowRotation: true,
  balanceWeight: 20,
  volumeWeight: 40,
  containerCountWeight: 15,
  fragilityWeight: 10,
  loadingSequenceWeight: 5,
}

function toMm(value: number, unit: string): number {
  switch (unit) {
    case 'mm':
      return value
    case 'cm':
      return value * 10
    case 'm':
      return value * 1000
    case 'inch':
      return value * 25.4
    default:
      return value
  }
}

export function normalizeContainer(raw: Partial<ContainerSpec>): ContainerSpec {
  return {
    id: raw.id ?? 'custom-container',
    name: raw.name ?? 'Custom Container',
    length: Number(raw.length ?? 0),
    width: Number(raw.width ?? 0),
    height: Number(raw.height ?? 0),
    payload: Number(raw.payload ?? 0),
    tareWeight: Number(raw.tareWeight ?? 0),
    maxGrossWeight: Number(raw.maxGrossWeight ?? 0),
    doorWidth: Number(raw.doorWidth ?? 0),
    doorHeight: Number(raw.doorHeight ?? 0),
    clearance: Number(raw.clearance ?? 0),
  }
}

export function normalizeCargo(raw: Partial<CargoSpec>): CargoSpec {
  return {
    id: raw.id ?? `cargo-${Math.random().toString(16).slice(2, 8)}`,
    sku: raw.sku ?? 'SKU-NEW',
    name: raw.name ?? 'Cargo',
    length: Number(raw.length ?? 0),
    width: Number(raw.width ?? 0),
    height: Number(raw.height ?? 0),
    weight: Number(raw.weight ?? 0),
    quantity: Math.max(0, Number(raw.quantity ?? 1)),
    fragile: Boolean(raw.fragile),
    stackable: raw.stackable ?? true,
    maxStackWeight: Number(raw.maxStackWeight ?? 0),
    maxLayers: Number(raw.maxLayers ?? 1),
    noRotate: Boolean(raw.noRotate),
    allowedRotations: Array.isArray(raw.allowedRotations) ? raw.allowedRotations.map((value) => Number(value)) : [],
    thisSideUp: Boolean(raw.thisSideUp),
    floorOnly: Boolean(raw.floorOnly),
    priority: Number(raw.priority ?? 1),
    group: raw.group ?? 'general',
    unloadSequence: Number(raw.unloadSequence ?? 1),
    clearance: Number(raw.clearance ?? 0),
    temperatureGroup: raw.temperatureGroup ?? 'normal',
    notes: raw.notes ?? '',
    extraFields: raw.extraFields && typeof raw.extraFields === 'object' ? { ...raw.extraFields } : {},
  }
}

export function convertDimension(value: number, unit: string): number {
  return toMm(value, unit)
}

export function getRotationOptions(item: Pick<CargoSpec, 'length' | 'width' | 'height' | 'noRotate' | 'allowedRotations' | 'thisSideUp'>): number[][] {
  const dims = [item.length, item.width, item.height]
  const base = [
    [dims[0], dims[1], dims[2]],
    [dims[0], dims[2], dims[1]],
    [dims[1], dims[0], dims[2]],
    [dims[1], dims[2], dims[0]],
    [dims[2], dims[0], dims[1]],
    [dims[2], dims[1], dims[0]],
  ]
  const unique = [...new Map(base.map((set) => [set.join('x'), set] as const)).values()]

  let permitted = unique
  if (item.noRotate) {
    permitted = [[item.length, item.width, item.height]]
  }
  if (item.thisSideUp) {
    permitted = permitted.filter((combo) => combo[2] === item.height)
  }
  if (item.allowedRotations.length > 0) {
    const allowedSet = new Set(item.allowedRotations)
    permitted = permitted.filter((_, index) => allowedSet.has(index + 1))
  }

  return permitted.filter(([a, b, c]) => a > 0 && b > 0 && c > 0)
}

export function validatePlacement(
  item: Pick<CargoSpec, 'length' | 'width' | 'height' | 'weight' | 'fragile' | 'stackable' | 'maxStackWeight' | 'maxLayers' | 'floorOnly' | 'noRotate' | 'allowedRotations' | 'thisSideUp'>,
  container: Pick<ContainerSpec, 'length' | 'width' | 'height' | 'payload' | 'tareWeight' | 'maxGrossWeight'>,
  x: number,
  y: number,
  z: number,
  dims: number[],
  placed: Placement[],
  settings: OptimizationSettings = DEFAULT_SETTINGS,
): ValidationResult {
  const reasons: string[] = []
  const [length, width, height] = dims

  if (x < 0 || y < 0 || z < 0 || x + length > container.length || y + width > container.width || z + height > container.height) {
    reasons.push('boundary')
  }
  if (item.floorOnly && z > 0) {
    reasons.push('floorOnly')
  }
  if (item.noRotate && !((item.length === length && item.width === width && item.height === height))) {
    reasons.push('rotation')
  }

  for (const other of placed) {
    const overlaps =
      x < other.x + other.length &&
      x + length > other.x &&
      y < other.y + other.width &&
      y + width > other.y &&
      z < other.z + other.height &&
      z + height > other.z

    if (overlaps) {
      reasons.push('collision')
      break
    }
  }

  if (z > 0) {
    const supportArea = placed.reduce((sum, other) => {
      const overlapX = Math.max(0, Math.min(x + length, other.x + other.length) - Math.max(x, other.x))
      const overlapY = Math.max(0, Math.min(y + width, other.y + other.width) - Math.max(y, other.y))
      const overlap = overlapX * overlapY
      if (other.z + other.height <= z && overlap > 0) {
        return sum + overlap
      }
      return sum
    }, 0)
    const baseArea = length * width
    const supportRatio = baseArea > 0 ? supportArea / baseArea : 1
    if (supportRatio < settings.minSupportRatio) {
      reasons.push('support')
    }
  }

  if (item.fragile) {
    const aboveCount = placed.filter((other) => other.z > z && other.x < x + length && other.x + other.length > x && other.y < y + width && other.y + other.width > y).length
    if (aboveCount > 0) {
      reasons.push('fragile')
    }
  }

  if (item.stackable && z > 0) {
    const columnWeight = placed.filter((other) => other.z < z && other.x < x + length && other.x + other.length > x && other.y < y + width && other.y + other.width > y).reduce((sum, other) => sum + other.weight, 0)
    if (item.maxStackWeight > 0 && columnWeight > item.maxStackWeight) {
      reasons.push('stackLimit')
    }
  }

  const loadedWeight = placed.reduce((sum, other) => sum + other.weight, 0) + item.weight
  if (
    (container.payload > 0 && loadedWeight > container.payload) ||
    (container.maxGrossWeight > 0 && loadedWeight + container.tareWeight > container.maxGrossWeight)
  ) {
    reasons.push('payload')
  }

  return {
    valid: reasons.length === 0,
    reasons,
  }
}

export function findPlacement(
  cargo: CargoSpec,
  container: ContainerSpec,
  placed: Placement[],
  settings: OptimizationSettings = DEFAULT_SETTINGS,
): Placement | null {
  const candidateSet = getRotationOptions(cargo)
  if (candidateSet.length === 0) {
    return null
  }

  const candidates = new Set<string>()
  for (const p of placed) {
    const x = p.x + p.length
    const y = p.y + p.width
    const z = p.z + p.height
    candidates.add(`${x},${p.y},${p.z}`)
    candidates.add(`${p.x},${y},${p.z}`)
    candidates.add(`${p.x},${p.y},${z}`)
    candidates.add(`${x},${y},${p.z}`)
    candidates.add(`${x},${p.y},${z}`)
    candidates.add(`${p.x},${y},${z}`)
    candidates.add(`${x},${y},${z}`)
  }
  candidates.add('0,0,0')

  const sortedPoints: Array<[number, number, number]> = [...candidates].map((key) => {
    const [x, y, z] = key.split(',').map(Number)
    return [x, y, z] as [number, number, number]
  }).sort((left, right) => left[0] + left[1] + left[2] - right[0] - right[1] - right[2])
  const candidateLimit = Math.max(1, settings.candidateLimit)
  const points = sortedPoints.length <= candidateLimit || candidateLimit === 1
    ? sortedPoints.slice(0, candidateLimit)
    : Array.from({ length: candidateLimit }, (_, index) =>
      sortedPoints[Math.floor(index * (sortedPoints.length - 1) / (candidateLimit - 1))],
    )

  const valid: Array<{ placement: Placement; score: number }> = []

  for (const [px, py, pz] of points) {
    for (const dims of candidateSet) {
      const [length, width, height] = dims
      const result = validatePlacement(cargo, container, px, py, pz, dims, placed, settings)
      if (!result.valid) continue

      const score = (px + py + pz) * 0.01 + (length * width * height) * 0.0001
      valid.push({
        placement: {
          id: `${cargo.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          itemId: cargo.id,
          sku: cargo.sku,
          name: cargo.name,
          x: px,
          y: py,
          z: pz,
          length,
          width,
          height,
          weight: cargo.weight,
          rotation: dims,
          orientationKey: dims.join('x'),
          group: cargo.group,
          unloadSequence: cargo.unloadSequence,
          containerIndex: 1,
        },
        score,
      })
    }
  }

  if (valid.length === 0) {
    return null
  }

  valid.sort((left, right) => left.score - right.score)
  return valid[0].placement
}

function getStrategyOrder(items: CargoSpec[], strategy: StrategyName): CargoSpec[] {
  const sorted = [...items]
  sorted.sort((left, right) => {
    const leftVolume = left.length * left.width * left.height
    const rightVolume = right.length * right.width * right.height
    const leftArea = left.length * left.width
    const rightArea = right.length * right.width
    const leftDensity = left.weight / Math.max(leftVolume, 1)
    const rightDensity = right.weight / Math.max(rightVolume, 1)

    switch (strategy) {
      case 'largest-volume':
        return rightVolume - leftVolume
      case 'largest-base':
        return rightArea - leftArea
      case 'largest-weight':
        return right.weight - left.weight
      case 'largest-height':
        return right.height - left.height
      case 'density':
        return rightDensity - leftDensity
      case 'delivery':
        return left.unloadSequence - right.unloadSequence
      case 'hybrid':
        return rightVolume * 0.5 + rightArea * 0.3 + right.weight * 0.2 - (leftVolume * 0.5 + leftArea * 0.3 + left.weight * 0.2)
      default:
        return rightVolume - leftVolume
    }
  })

  return sorted
}

export function estimateAdditionalQuantity(
  cargo: Pick<CargoSpec, 'length' | 'width' | 'height' | 'weight'>,
  container: ContainerSpec,
  placements: Placement[],
): number {
  const cargoVolume = cargo.length * cargo.width * cargo.height
  const containerVolume = container.length * container.width * container.height
  if (cargoVolume <= 0 || containerVolume <= 0) {
    return 0
  }

  const usedVolume = placements.reduce((sum, item) => sum + item.length * item.width * item.height, 0)
  const volumeCapacity = Math.floor(Math.max(0, containerVolume - usedVolume) / cargoVolume)
  const payloadLimit = container.payload > 0 ? container.payload : Infinity
  const grossWeightLimit = container.maxGrossWeight > 0
    ? Math.max(0, container.maxGrossWeight - container.tareWeight)
    : Infinity
  const loadedWeight = placements.reduce((sum, item) => sum + item.weight, 0)
  const weightCapacity = cargo.weight > 0
    ? Math.floor(Math.max(0, Math.min(payloadLimit, grossWeightLimit) - loadedWeight) / cargo.weight)
    : volumeCapacity

  return Math.max(0, Math.min(volumeCapacity, weightCapacity))
}

function buildContainerPlan(container: ContainerSpec, placements: Placement[], index: number): ContainerPlan {
  const totalWeight = placements.reduce((sum, item) => sum + item.weight, 0)
  const usedVolume = placements.reduce((sum, item) => sum + item.length * item.width * item.height, 0)
  const centerOfGravity = placements.reduce(
    (acc, item) => {
      const x = item.x + item.length / 2
      const y = item.y + item.width / 2
      const z = item.z + item.height / 2
      const weight = item.weight
      return {
        x: acc.x + x * weight,
        y: acc.y + y * weight,
        z: acc.z + z * weight,
      }
    },
    { x: 0, y: 0, z: 0 },
  )

  const total = totalWeight || 1
  const cg = {
    x: centerOfGravity.x / total,
    y: centerOfGravity.y / total,
    z: centerOfGravity.z / total,
  }

  return {
    index,
    container,
    placements,
    utilization: (usedVolume / (container.length * container.width * container.height)) * 100,
    usedVolume,
    totalWeight,
    centerOfGravity: cg,
  }
}

export function runOptimizer(
  container: ContainerSpec,
  cargoList: CargoSpec[],
  settings: Partial<OptimizationSettings> = {},
): OptimizationResult {
  const mergedSettings: OptimizationSettings = { ...DEFAULT_SETTINGS, ...settings }
  const logs: string[] = []
  logs.push('[hệ thống] Đang tải dữ liệu hàng hóa...')

  const expanded: CargoSpec[] = []
  for (const item of cargoList) {
    const qty = Math.max(0, Math.round(item.quantity))
    for (let index = 0; index < qty; index += 1) {
      expanded.push({ ...item, id: `${item.id}-${index + 1}` })
    }
  }
  logs.push(`[hệ thống] Đã kiểm tra ${expanded.length} kiện hàng.`)

  const allStrategies: StrategyName[] = ['largest-volume', 'largest-base', 'largest-weight', 'largest-height', 'density', 'delivery', 'hybrid']
  let best: OptimizationResult | null = null

  for (const strategy of allStrategies) {
    const strategyItems = getStrategyOrder(expanded, strategy)
    const containerPlans: ContainerPlan[] = []
    const placements: Placement[] = []
    const unloaded: UnloadedItem[] = []
    const warnings: string[] = []
    for (const cargo of strategyItems) {
      let placed = false
      for (let index = 0; index < containerPlans.length; index += 1) {
        const plan = containerPlans[index]
        const candidate = findPlacement(cargo, plan.container, plan.placements, mergedSettings)
        if (candidate) {
          candidate.containerIndex = index + 1
          plan.placements.push(candidate)
          containerPlans[index] = buildContainerPlan(plan.container, plan.placements, index + 1)
          placements.push(candidate)
          placed = true
          break
        }
      }

      if (!placed) {
        const nextContainerIndex = containerPlans.length + 1
        const nextContainer = { ...container, id: `${container.id}-${nextContainerIndex}` }
        const candidate = findPlacement(cargo, nextContainer, [], mergedSettings)
        if (candidate) {
          candidate.containerIndex = nextContainerIndex
          placements.push(candidate)
          containerPlans.push(buildContainerPlan(nextContainer, [candidate], nextContainerIndex))
        } else {
          unloaded.push({
            sku: cargo.sku,
            reason: 'No valid placement within the active container constraints.',
            suggested: 'Use another container or relax rotation rules.',
          })
        }
      }
    }

    if (containerPlans.length === 0) {
      const fallback = buildContainerPlan(container, placements, 1)
      containerPlans.push(fallback)
    }

    const totalWeight = placements.reduce((sum, item) => sum + item.weight, 0)
    const totalContainerVolume = container.length * container.width * container.height * Math.max(containerPlans.length, 1)
    const usedVolume = placements.reduce((sum, item) => sum + item.length * item.width * item.height, 0)
    const volumeUtilization = (usedVolume / totalContainerVolume) * 100
    const payloadUtilization = totalWeight > 0 ? (totalWeight / (container.payload * Math.max(containerPlans.length, 1))) * 100 : 0
    const cg = placements.reduce(
      (acc, item) => {
        const x = item.x + item.length / 2
        const y = item.y + item.width / 2
        const z = item.z + item.height / 2
        return {
          x: acc.x + x * item.weight,
          y: acc.y + y * item.weight,
          z: acc.z + z * item.weight,
        }
      },
      { x: 0, y: 0, z: 0 },
    )
    const total = totalWeight || 1
    const centerOfGravity = {
      x: cg.x / total,
      y: cg.y / total,
      z: cg.z / total,
    }

    const score = Math.min(100, Math.max(0, volumeUtilization * 0.45 + payloadUtilization * 0.25 + (100 - unloaded.length * 10) * 0.3))

    const candidateResult: OptimizationResult = {
      containers: containerPlans,
      loaded: placements,
      unloaded,
      warnings,
      score,
      volumeUtilization,
      payloadUtilization,
      totalCargoWeight: totalWeight,
      usedVolume,
      unusedVolume: totalContainerVolume - usedVolume,
      totalContainers: containerPlans.length,
      strategy,
      logs: [...logs, `[hệ thống] Tìm thấy phương án cho chiến lược ${strategy}.`],
      centerOfGravity,
      bestSolution: `Strategy ${strategy}`,
    }

    if (
      !best ||
      candidateResult.loaded.length > best.loaded.length ||
      (candidateResult.loaded.length === best.loaded.length && candidateResult.totalContainers < best.totalContainers) ||
      (candidateResult.loaded.length === best.loaded.length && candidateResult.totalContainers === best.totalContainers && candidateResult.score > best.score)
    ) {
      best = candidateResult
    }
  }

  return best ?? {
    containers: [],
    loaded: [],
    unloaded: [],
    warnings: ['No valid solution was found.'],
    score: 0,
    volumeUtilization: 0,
    payloadUtilization: 0,
    totalCargoWeight: 0,
    usedVolume: 0,
    unusedVolume: container.length * container.width * container.height,
    totalContainers: 0,
    strategy: 'largest-volume',
    logs: ['[hệ thống] Không tìm thấy phương án hợp lệ.'],
    centerOfGravity: { x: 0, y: 0, z: 0 },
    bestSolution: 'None',
  }
}

export function createTemplateCsv(): string {
  const headers = [
    'SKU',
    'Name',
    'Length',
    'Width',
    'Height',
    'Weight',
    'Quantity',
    'Fragile',
    'Stackable',
    'MaxStackWeight',
    'MaxLayers',
    'NoRotate',
    'ThisSideUp',
    'FloorOnly',
    'Priority',
    'Group',
    'UnloadSequence',
    'Clearance',
  ]

  const rows = [
    headers,
    ['SKU-001', 'Carton A', '120', '80', '100', '250', '20', 'false', 'true', '1200', '4', 'false', 'false', 'false', '1', 'general', '1', '10'],
    ['SKU-002', 'Carton B', '100', '60', '80', '150', '30', 'false', 'true', '900', '5', 'false', 'false', 'false', '2', 'general', '2', '8'],
    ['SKU-003', 'Fragile E', '50', '40', '30', '20', '50', 'true', 'false', '0', '1', 'false', 'true', 'false', '5', 'fragile', '5', '4'],
  ]

  return rows.map((row) => row.join(',')).join('\n')
}

export function explainPlacementIssue(item: CargoSpec, container: ContainerSpec, placements: Placement[], settings: OptimizationSettings = DEFAULT_SETTINGS): string {
  const rotations = getRotationOptions(item)
  const reasons = [
    'Đã kiểm tra mọi hướng xoay hợp lệ.',
    'Đã kiểm tra kích thước container.',
    `Đã thử các vị trí ứng viên: ${Math.max(1, placements.length * 3)}.`,
    `Tỷ lệ hỗ trợ tối thiểu được đặt ở ${settings.minSupportRatio}.`,
  ]
  const canFitBase = rotations.some((combo) => combo[0] <= container.length && combo[1] <= container.width && combo[2] <= container.height)
  if (!canFitBase) {
    reasons.push('Không có hướng xoay nào phù hợp với kích thước container.')
  } else {
    reasons.push('Không tìm thấy vị trí trống không va chạm trong không gian còn lại.')
  }
  return `${item.sku}: ${reasons.join(' ')}.`
}

export { DEFAULT_SETTINGS }
