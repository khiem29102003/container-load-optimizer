import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { estimateAdditionalQuantity, findPlacement, getRotationOptions, runOptimizer, validatePlacement } from './engine'

function createCubeCargo(id: string, sku: string, quantity: number) {
  return {
    id,
    sku,
    name: `Cargo ${sku}`,
    length: 50,
    width: 50,
    height: 50,
    weight: 1,
    quantity,
    fragile: false,
    stackable: true,
    maxStackWeight: 20,
    maxLayers: 2,
    noRotate: true,
    allowedRotations: [],
    thisSideUp: false,
    floorOnly: false,
    priority: 1,
    group: 'general',
    unloadSequence: 1,
    clearance: 0,
    temperatureGroup: 'normal',
    notes: '',
  }
}

describe('optimizer engine', () => {
  it('returns a valid rotation for non-rotated items', () => {
    assert.equal(getRotationOptions({ length: 100, width: 60, height: 40, noRotate: true, allowedRotations: [], thisSideUp: false }).length, 1)
  })

  it('accepts a simple placement inside a container', () => {
    const result = validatePlacement(
      { length: 100, width: 60, height: 40, weight: 10, fragile: false, stackable: true, maxStackWeight: 200, maxLayers: 5, floorOnly: false, noRotate: false, allowedRotations: [], thisSideUp: false },
      { length: 200, width: 120, height: 100, payload: 5000, tareWeight: 500, maxGrossWeight: 5500 },
      0,
      0,
      0,
      [100, 60, 40],
      [],
    )

    assert.equal(result.valid, true)
  })

  it('detects boundary violations', () => {
    const result = validatePlacement(
      { length: 100, width: 60, height: 40, weight: 10, fragile: false, stackable: true, maxStackWeight: 200, maxLayers: 5, floorOnly: false, noRotate: false, allowedRotations: [], thisSideUp: false },
      { length: 200, width: 120, height: 100, payload: 5000, tareWeight: 500, maxGrossWeight: 5500 },
      200,
      0,
      0,
      [100, 60, 40],
      [],
    )

    assert.equal(result.valid, false)
    assert.ok(result.reasons.includes('boundary'))
  })

  it('finds a valid candidate position for a box', () => {
    const placement = findPlacement(
      { id: 'box-1', sku: 'SKU-1', name: 'Box 1', length: 100, width: 60, height: 40, weight: 12, quantity: 1, fragile: false, stackable: true, maxStackWeight: 500, maxLayers: 3, noRotate: false, allowedRotations: [], thisSideUp: false, floorOnly: false, priority: 1, group: 'A', unloadSequence: 1, clearance: 0, temperatureGroup: 'normal', notes: '' },
      { id: 'c1', name: 'Container', length: 200, width: 120, height: 100, payload: 5000, tareWeight: 500, maxGrossWeight: 5500, doorWidth: 100, doorHeight: 100, clearance: 10 },
      [],
    )

    assert.ok(placement !== null)
  })

  it('mixes SKUs to fill the first container before opening another', () => {
    const result = runOptimizer(
      { id: 'c1', name: 'Container', length: 100, width: 100, height: 100, payload: 20, tareWeight: 0, maxGrossWeight: 20, doorWidth: 100, doorHeight: 100, clearance: 0 },
      [createCubeCargo('a', 'SKU-A', 4), createCubeCargo('b', 'SKU-B', 5)],
    )

    assert.equal(result.loaded.length, 9)
    assert.equal(result.totalContainers, 2)
    assert.deepEqual(new Set(result.containers[0].placements.map((item) => item.sku)), new Set(['SKU-A', 'SKU-B']))
    assert.equal(result.containers[0].placements.length, 8)
  })

  it('keeps considering positions across the container as candidate count grows', () => {
    const result = runOptimizer(
      { id: 'c1', name: 'Container', length: 1000, width: 1000, height: 1000, payload: 100, tareWeight: 0, maxGrossWeight: 100, doorWidth: 1000, doorHeight: 1000, clearance: 0 },
      [createCubeCargo('a', 'SKU-A', 40)],
    )

    assert.equal(result.loaded.length, 40)
    assert.equal(result.totalContainers, 1)
  })

  it('estimates added SKU quantity using both free volume and remaining payload', () => {
    const estimate = estimateAdditionalQuantity(
      { length: 50, width: 50, height: 50, weight: 1 },
      { id: 'c1', name: 'Container', length: 100, width: 100, height: 100, payload: 10, tareWeight: 1, maxGrossWeight: 8, doorWidth: 100, doorHeight: 100, clearance: 0 },
      [{ id: 'loaded', itemId: 'loaded', sku: 'SKU-LOADED', name: 'Loaded', x: 0, y: 0, z: 0, length: 50, width: 50, height: 50, weight: 5, rotation: [50, 50, 50], orientationKey: '50x50x50', group: 'general', unloadSequence: 1, containerIndex: 1 }],
    )

    assert.equal(estimate, 2)
  })
})
