import type { CargoSpec, ContainerSpec, Placement } from '../types'

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
    allowedRotations: Array.isArray(raw.allowedRotations) ? raw.allowedRotations.map(Number) : [],
    thisSideUp: Boolean(raw.thisSideUp),
    floorOnly: Boolean(raw.floorOnly),
    priority: Number(raw.priority ?? 1),
    group: raw.group ?? 'general',
    unloadSequence: Number(raw.unloadSequence ?? 1),
    clearance: Number(raw.clearance ?? 0),
    temperatureGroup: raw.temperatureGroup ?? 'normal',
    notes: raw.notes ?? '',
  }
}

export function estimateAdditionalQuantity(
  cargo: Pick<CargoSpec, 'length' | 'width' | 'height' | 'weight'>,
  container: ContainerSpec,
  placements: Placement[],
): number {
  const cargoVolume = cargo.length * cargo.width * cargo.height
  const containerVolume = container.length * container.width * container.height
  if (cargoVolume <= 0 || containerVolume <= 0) return 0

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

export function createTemplateCsv(): string {
  return [
    'SKU',
    'Name',
    'Length (mm)',
    'Width (mm)',
    'Height (mm)',
    'Weight (kg)',
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
  ].join(',')
}