import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapCargoGrid, mapCargoRows, mapCargoSheets } from '../lib/importCargo'
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

  it('maps Vietnamese cargo headers and converts centimeter dimensions to millimeters', () => {
    const result = mapCargoRows([{
      'Mã hàng': 'GC-01',
      'Tên hàng': 'Thùng giấy',
      'Dài (cm)': 10,
      'Rộng (cm)': 20,
      'Cao (cm)': 30,
      'Trọng lượng (kg)': 5,
      'Số lượng': 7,
    }])

    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].sku, 'GC-01')
    assert.equal(result.items[0].length, 100)
    assert.equal(result.items[0].width, 200)
    assert.equal(result.items[0].height, 300)
    assert.equal(result.items[0].quantity, 7)
  })

  it('finds the cargo header below a title row and parses composite dimensions', () => {
    const result = mapCargoGrid([
      ['QUY CÁCH - GC'],
      ['Mã hàng', 'Tên', 'Quy cách (mm)', 'SL'],
      ['GC-02', 'Pallet', '1200 x 800 x 1000', 3],
    ])

    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].sku, 'GC-02')
    assert.equal(result.items[0].length, 1200)
    assert.equal(result.items[0].width, 800)
    assert.equal(result.items[0].height, 1000)
    assert.equal(result.items[0].quantity, 3)
  })

  it('maps L/W/H columns and parses formatted metric values', () => {
    const result = mapCargoRows([{
      SKU: 'GC-03',
      Name: 'Crate',
      'L (mm)': '1.200',
      'W (mm)': '800',
      'H (mm)': '600',
      Qty: '1,5',
    }])

    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].length, 1200)
    assert.equal(result.items[0].width, 800)
    assert.equal(result.items[0].height, 600)
    assert.equal(result.items[0].quantity, 1.5)
  })

  it('converts meter-based dimension headers to millimeters', () => {
    const result = mapCargoRows([{
      'Mã hàng': 'GC-04',
      'Dài (m)': 1.2,
      'Rộng (m)': 2.4,
      'Cao (m)': 2.5,
    }])

    assert.equal(result.items[0].length, 1200)
    assert.equal(result.items[0].width, 2400)
    assert.equal(result.items[0].height, 2500)
  })

  it('preserves added columns as metadata without losing cargo rows', () => {
    const result = mapCargoRows([{
      SKU: 'GC-05',
      Name: 'Box',
      Length: 100,
      Width: 80,
      Height: 60,
      Quantity: 4,
      'Màu sắc': 'Xanh',
      'Mã lô bổ sung': 'LOT-2026-04',
    }])

    assert.equal(result.items.length, 1)
    assert.deepEqual(result.items[0].extraFields, {
      'Màu sắc': 'Xanh',
      'Mã lô bổ sung': 'LOT-2026-04',
    })
  })

  it('merges valid cargo rows from multiple workbook sheets', () => {
    const result = mapCargoSheets([
      { name: 'Hàng A', grid: [['SKU', 'Length', 'Width', 'Height'], ['A-01', 100, 80, 60]] },
      { name: 'Hàng B', grid: [['SKU', 'Length', 'Width', 'Height'], ['B-01', 120, 90, 70]] },
    ])

    assert.equal(result.items.length, 2)
    assert.deepEqual(result.items.map((item) => item.sku), ['A-01', 'B-01'])
    assert.equal(new Set(result.items.map((item) => item.id)).size, 2)
    assert.deepEqual(result.sheetNames, ['Hàng A', 'Hàng B'])
  })

  it('reports invalid cargo rows from sheets that cannot produce a placement', () => {
    const result = mapCargoSheets([
      { name: 'Hàng hợp lệ', grid: [['SKU', 'Length', 'Width', 'Height'], ['A-01', 100, 80, 60]] },
      { name: 'Thiếu quy cách', grid: [['SKU', 'Name', 'Quantity'], ['B-01', 'Box', 2]] },
    ])

    assert.equal(result.items.length, 1)
    assert.ok(result.warnings.some((warning) => warning.includes('Thiếu quy cách')))
    assert.ok(result.warnings.some((warning) => warning.includes('Dài/Rộng/Cao')))
  })
})
