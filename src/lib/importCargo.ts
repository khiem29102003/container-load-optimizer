import { normalizeCargo } from '../optimizer/engine'
import type { CargoSpec } from '../types'

type SpreadsheetRow = Record<string, unknown>

interface CellValue {
  header: string
  value: unknown
}

export interface CargoImportResult {
  items: CargoSpec[]
  warnings: string[]
  headers: string[]
}

const headerAliases = {
  sku: ['sku', 'mahang', 'mahanghoa', 'masanpham', 'masp', 'itemcode', 'productcode', 'code'],
  name: ['name', 'ten', 'tenhang', 'tenhanghoa', 'tensanpham', 'itemname', 'productname', 'description'],
  length: ['length', 'dai', 'chieudai', 'l'],
  width: ['width', 'rong', 'chieurong', 'w'],
  height: ['height', 'cao', 'chieucao', 'h'],
  weight: ['weight', 'trongluong', 'khoiluong', 'kg'],
  quantity: ['quantity', 'qty', 'soluong', 'sl'],
  dimensions: ['dimensions', 'dimension', 'kichthuoc', 'quycach', 'size', 'specification'],
  fragile: ['fragile', 'devo', 'hangdevo'],
  stackable: ['stackable', 'duocchong', 'xeptang'],
  maxStackWeight: ['maxstackweight', 'taichongtoida', 'trongluongchongtoida'],
  maxLayers: ['maxlayers', 'sotangtoida', 'soloptoida'],
  noRotate: ['norotate', 'khongxoay'],
  thisSideUp: ['thissideup', 'dungchieunay', 'matnaylen'],
  floorOnly: ['flooronly', 'chixepduoi'],
  priority: ['priority', 'uutien'],
  group: ['group', 'nhom'],
  unloadSequence: ['unloadsequence', 'thutudo', 'thutugiao'],
  clearance: ['clearance', 'khoangho', 'dohokythuat'],
  temperatureGroup: ['temperaturegroup', 'nhomnhietdo'],
  notes: ['notes', 'ghichu'],
} as const

function normalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function findCell(row: SpreadsheetRow, aliases: readonly string[]): CellValue | undefined {
  const entries = Object.entries(row).map(([header, value]) => ({
    header,
    key: normalizeHeader(header),
    value,
  }))

  const exact = entries.find((entry) => aliases.includes(entry.key))
  const shortDimension = entries.find((entry) =>
    aliases.some((alias) => alias.length === 1 && new RegExp(`^${alias}(?:mm|cm|m)?$`).test(entry.key)),
  )
  const match = exact ?? shortDimension ?? entries.find((entry) => aliases.some((alias) => alias.length > 1 && entry.key.startsWith(alias)))
  return match ? { header: match.header, value: match.value } : undefined
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null

  let numericText = value.trim().replace(/[\s']/g, '')
  const commaIndex = numericText.lastIndexOf(',')
  const dotIndex = numericText.lastIndexOf('.')
  if (commaIndex >= 0 && dotIndex >= 0) {
    numericText = commaIndex > dotIndex
      ? numericText.replace(/\./g, '').replace(',', '.')
      : numericText.replace(/,/g, '')
  } else if (commaIndex >= 0 || dotIndex >= 0) {
    const separator = commaIndex >= 0 ? ',' : '.'
    const chunks = numericText.split(separator)
    if (chunks.length > 2 && chunks.slice(1).every((chunk) => chunk.length === 3)) {
      numericText = chunks.join('')
    } else if (chunks.length === 2 && chunks[1].length === 3 && chunks[0].length <= 3) {
      numericText = chunks.join('')
    } else if (separator === ',') {
      numericText = numericText.replace(',', '.')
    }
  }

  const match = numericText.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function dimensionScale(header: string, value: unknown): number {
  const normalizedHeader = normalizeHeader(header)
  const unitText = `${normalizedHeader}${normalizeHeader(String(value ?? ''))}`
  if (unitText.includes('inch') || unitText.endsWith('in')) return 25.4
  if (unitText.includes('mm') || unitText.includes('millimeter')) return 1
  if (unitText.includes('cm') || unitText.includes('centimeter')) return 10
  if (normalizedHeader.endsWith('m') && !normalizedHeader.endsWith('mm') && !normalizedHeader.endsWith('cm')) return 1000
  if (unitText.includes('meter') || /(?:^|\d)m(?:$|[^a-z])/i.test(String(value ?? ''))) return 1000
  return 1
}

function readDimension(row: SpreadsheetRow, field: 'length' | 'width' | 'height', compositeValues: number[]): number | null {
  const cell = findCell(row, headerAliases[field])
  if (cell) {
    const value = toNumber(cell.value)
    return value === null ? null : value * dimensionScale(cell.header, cell.value)
  }

  const composite = findCell(row, headerAliases.dimensions)
  if (!composite) return null
  const compositeScale = dimensionScale(composite.header, composite.value)
  const dimensionIndex = field === 'length' ? 0 : field === 'width' ? 1 : 2
  const dimension = compositeValues[dimensionIndex]
  return Number.isFinite(dimension) ? dimension * compositeScale : null
}

function parseCompositeDimensions(value: unknown): number[] {
  if (typeof value !== 'string') return []
  return (value.match(/\d+(?:[.,]\d+)?/g) ?? [])
    .slice(0, 3)
    .map((part) => Number(part.replace(',', '.')))
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const normalized = normalizeHeader(String(value ?? ''))
  if (['true', 'yes', 'y', '1', 'co', 'dung'].includes(normalized)) return true
  if (['false', 'no', 'n', '0', 'khong', 'sai'].includes(normalized)) return false
  return fallback
}

export function mapCargoRows(rows: SpreadsheetRow[]): CargoImportResult {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 30)
  const items: CargoSpec[] = []
  const warnings: string[] = []

  rows.forEach((row, index) => {
    if (Object.values(row).every((value) => value === null || value === undefined || String(value).trim() === '')) return

    const compositeCell = findCell(row, headerAliases.dimensions)
    const compositeValues = parseCompositeDimensions(compositeCell?.value)
    const length = readDimension(row, 'length', compositeValues)
    const width = readDimension(row, 'width', compositeValues)
    const height = readDimension(row, 'height', compositeValues)

    if (!length || !width || !height || length < 0 || width < 0 || height < 0) {
      warnings.push(`Dòng ${index + 2}: thiếu hoặc sai cột kích thước Dài/Rộng/Cao (hoặc Quy cách dạng D×R×C); đã bỏ qua.`)
      return
    }

    const skuCell = findCell(row, headerAliases.sku)
    const nameCell = findCell(row, headerAliases.name)
    const sku = String(skuCell?.value ?? `SKU-${index + 1}`).trim()
    const name = String(nameCell?.value ?? sku).trim()
    const weightCell = findCell(row, headerAliases.weight)
    const quantityCell = findCell(row, headerAliases.quantity)
    const weight = weightCell ? toNumber(weightCell.value) : 0
    const quantity = quantityCell ? toNumber(quantityCell.value) : 1
    if (weightCell && weight === null) warnings.push(`Dòng ${index + 2}: trọng lượng không hợp lệ, đặt bằng 0.`)
    if (quantityCell && quantity === null) warnings.push(`Dòng ${index + 2}: số lượng không hợp lệ, đặt bằng 1.`)

    const fragileCell = findCell(row, headerAliases.fragile)
    const stackableCell = findCell(row, headerAliases.stackable)
    items.push(normalizeCargo({
      id: `import-${index + 1}`,
      sku,
      name,
      length,
      width,
      height,
      weight: Math.max(0, weight ?? 0),
      quantity: Math.max(0, quantity ?? 1),
      fragile: fragileCell ? parseBoolean(fragileCell.value, false) : false,
      stackable: stackableCell ? parseBoolean(stackableCell.value, true) : true,
      maxStackWeight: toNumber(findCell(row, headerAliases.maxStackWeight)?.value) ?? 0,
      maxLayers: toNumber(findCell(row, headerAliases.maxLayers)?.value) ?? 1,
      noRotate: parseBoolean(findCell(row, headerAliases.noRotate)?.value, false),
      thisSideUp: parseBoolean(findCell(row, headerAliases.thisSideUp)?.value, false),
      floorOnly: parseBoolean(findCell(row, headerAliases.floorOnly)?.value, false),
      priority: toNumber(findCell(row, headerAliases.priority)?.value) ?? 1,
      group: String(findCell(row, headerAliases.group)?.value ?? 'general'),
      unloadSequence: toNumber(findCell(row, headerAliases.unloadSequence)?.value) ?? 1,
      clearance: toNumber(findCell(row, headerAliases.clearance)?.value) ?? 0,
      temperatureGroup: String(findCell(row, headerAliases.temperatureGroup)?.value ?? 'normal'),
      notes: String(findCell(row, headerAliases.notes)?.value ?? ''),
    }))
  })

  return { items, warnings, headers }
}

export function mapCargoGrid(grid: unknown[][]): CargoImportResult {
  let best: CargoImportResult = { items: [], warnings: [], headers: [] }
  const recognizedAliases = Object.values(headerAliases).flat()

  for (let headerIndex = 0; headerIndex < Math.min(grid.length, 20); headerIndex += 1) {
    const rawHeaders = grid[headerIndex]
    if (!rawHeaders) continue
    const headers = rawHeaders.map((value, index) => String(value ?? '').trim() || `Column ${index + 1}`)
    const normalizedHeaders = headers.map(normalizeHeader)
    const recognizedCount = normalizedHeaders.filter((header) =>
      recognizedAliases.some((alias) => header === alias || header.startsWith(alias)),
    ).length
    if (recognizedCount < 2) continue

    const rows = grid.slice(headerIndex + 1).map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values?.[index] ?? ''])),
    )
    const candidate = mapCargoRows(rows)
    if (candidate.items.length > best.items.length) best = candidate
  }

  return best
}