import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import { Container3D } from './components/Container3D'
import { demoCargo, demoContainer } from './data/demo'
import { createTemplateCsv, estimateAdditionalQuantity, explainPlacementIssue, normalizeCargo } from './optimizer/engine'
import type { CargoSpec, ContainerSpec, OptimizationResult, Placement } from './types'
import './App.css'

const defaultSettings = {
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

function generateAiAnswer(question: string, plan: OptimizationResult | null): string {
  if (!plan) {
    return 'Hệ thống đang chờ chu kỳ tối ưu tiếp theo. Tải container và dữ liệu hàng hóa để nhận giải thích thời gian thực.'
  }

  const lower = question.toLowerCase()

  if (lower.includes('why') && (lower.includes('utilization') || lower.includes('space') || lower.includes('dung tích') || lower.includes('thể tích'))) {
    return `Kế hoạch hiện tại đang sử dụng ${plan.volumeUtilization.toFixed(1)}% thể tích container. Phần lớn hao hụt đến từ khoảng trống còn lại và cách phối trộn hàng hóa. Bộ tối ưu ưu tiên vị trí hợp lệ trước, nên các khoảng rỗng vẫn tồn tại khi kích thước kiện còn lại không khớp với không gian còn trống mà không vi phạm hỗ trợ, va chạm hoặc xếp chồng.`
  }

  if (lower.includes('waste') || lower.includes('space') || lower.includes('lãng phí') || lower.includes('rỗng')) {
    return `Thể tích chưa sử dụng hiện là ${plan.unusedVolume.toFixed(0)} mm³. Lỗ hổng lớn nhất xảy ra khi kích thước hàng còn lại không khớp với các khối rỗng còn lại sau lớp xếp trước.`
  }

  if (lower.includes('rotate') || lower.includes('rotation') || lower.includes('xoay')) {
    return `Tùy chọn xoay đã được kích hoạt trong lần chạy này, nhưng phương án vẫn hợp lệ vì bộ tối ưu kiểm tra mọi hướng đặt hợp pháp và chỉ chấp nhận vị trí thỏa mãn ranh giới, hỗ trợ, va chạm và xếp chồng.`
  }

  if (lower.includes('container') && (lower.includes('reduce') || lower.includes('giảm') || lower.includes('3') || lower.includes('2'))) {
    return `Kế hoạch hiện tại đang sử dụng ${plan.totalContainers} container. Cách cải thiện tốt nhất là giảm các nhóm hàng nhỏ hoặc rời rạc nhất và chạy lại tối ưu với ưu tiên thể tích cao hơn.`
  }

  return `Dựa trên kế hoạch hiện tại, bộ tối ưu báo cáo ${plan.totalContainers} container, ${plan.loaded.length} kiện hàng đã xếp, và mức sử dụng thể tích ${plan.volumeUtilization.toFixed(1)}%. Ràng buộc lớn nhất hiện là hình học không gian trống còn lại và cấu trúc hàng hóa, không chỉ riêng giới hạn trọng lượng.`
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const [container, setContainer] = useState<ContainerSpec>(demoContainer)
  const [cargo, setCargo] = useState<CargoSpec[]>(demoCargo)
  const [plan, setPlan] = useState<OptimizationResult | null>(null)
  const [logs, setLogs] = useState<string[]>(['[hệ thống] Sẵn sàng cho chạy demo.'])
  const [question, setQuestion] = useState('Vì sao mức sử dụng thể tích container hiện đang bị giới hạn?')
  const [aiAnswer, setAiAnswer] = useState('Bộ tối ưu đang phân tích thực tế cấu trúc hàng hóa để giải thích khoảng trống và giới hạn dung tích.')
  const [selectedPlacement, setSelectedPlacement] = useState<Placement | null>(null)
  const [view, setView] = useState<'front' | 'top'>('front')

  const totalCargoWeight = cargo.reduce((sum, item) => sum + item.weight * item.quantity, 0)
  const requestedItemCount = cargo.reduce((sum, item) => sum + Math.max(0, Math.round(item.quantity)), 0)

  useEffect(() => {
    const worker = new Worker(new URL('./optimizer/optimizer.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<{ requestId: number; result: OptimizationResult }>) => {
      if (event.data.requestId !== requestIdRef.current) {
        return
      }
      const result = event.data.result
      setPlan(result)
      setLogs(result.logs)
      setSelectedPlacement(result.loaded[0] ?? null)
    }
    worker.onerror = () => setLogs(['[hệ thống] Không thể chạy bộ tối ưu. Vui lòng thử lại.'])

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    const isComplete =
      container.length > 0 && container.width > 0 && container.height > 0 &&
      cargo.length > 0 && cargo.every((item) =>
        item.sku.trim() && item.name.trim() && item.length > 0 && item.width > 0 && item.height > 0 &&
        item.weight >= 0 && item.quantity >= 0,
      )

    if (!isComplete) {
      return
    }

    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      const worker = workerRef.current
      if (!worker) {
        return
      }
      setPlan(null)
      setSelectedPlacement(null)
      setLogs(['[hệ thống] Đang tối ưu dữ liệu hiện tại...'])
      worker.postMessage({ requestId, container, cargo, settings: defaultSettings })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [container, cargo])

  const loadedBySku = new Map<string, number>()
  for (const placement of plan?.loaded ?? []) {
    loadedBySku.set(placement.sku, (loadedBySku.get(placement.sku) ?? 0) + 1)
  }
  const primaryContainerPlacements = plan?.containers[0]?.placements ?? []
  const cargoSummary = cargo.reduce<Array<{ id: string; sku: string; name: string; requested: number; length: number; width: number; height: number; weight: number }>>((summary, item) => {
    const existing = summary.find((entry) => entry.sku === item.sku)
    if (existing) {
      existing.requested += Math.max(0, Math.round(item.quantity))
    } else {
      summary.push({
        id: item.id,
        sku: item.sku,
        name: item.name,
        requested: Math.max(0, Math.round(item.quantity)),
        length: item.length,
        width: item.width,
        height: item.height,
        weight: item.weight,
      })
    }
    return summary
  }, [])

  const handleOptimize = () => {
    const worker = workerRef.current
    if (!worker) {
      return
    }
    const requestId = ++requestIdRef.current
    setPlan(null)
    setSelectedPlacement(null)
    setLogs(['[hệ thống] Đang tối ưu dữ liệu hiện tại...'])
    worker.postMessage({ requestId, container, cargo, settings: defaultSettings })
  }

  const handleLoadDemo = () => {
    setContainer({ ...demoContainer })
    setCargo(demoCargo.map((item) => ({ ...item })))
    setPlan(null)
  }

  const handleReset = () => {
    requestIdRef.current += 1
    setPlan(null)
    setLogs(['[hệ thống] Sẵn sàng cho chạy demo.'])
    setSelectedPlacement(null)
  }

  const addRecommendedQuantity = (itemId: string, amount: number) => {
    if (amount <= 0) {
      return
    }
    setPlan(null)
    setCargo((current) => current.map((item) =>
      item.id === itemId ? { ...item, quantity: item.quantity + amount } : item,
    ))
  }

  const handleContainerChange = (field: keyof ContainerSpec, value: string) => {
    const parsed = Number(value)
    setPlan(null)
    setContainer((current) => ({
      ...current,
      [field]: Number.isFinite(parsed) ? parsed : current[field],
    }))
  }

  const updateCargoRow = (index: number, field: keyof CargoSpec, value: string | boolean) => {
    setPlan(null)
    setCargo((current) =>
      current.map((item, itemIndex) => {
        if (itemIndex !== index) {
          return item
        }

        const next = { ...item }

        if (field === 'fragile' || field === 'stackable' || field === 'noRotate' || field === 'thisSideUp' || field === 'floorOnly') {
          next[field] = Boolean(value)
          return next
        }

        if (field === 'allowedRotations') {
          return { ...item, allowedRotations: Array.isArray(value) ? value : [] }
        }

        switch (field) {
          case 'length':
          case 'width':
          case 'height':
          case 'weight':
          case 'quantity':
          case 'maxStackWeight':
          case 'maxLayers':
          case 'priority':
          case 'unloadSequence':
          case 'clearance': {
            const numeric = Number(value)
            next[field] = Number.isFinite(numeric) ? numeric : item[field]
            return next
          }
          case 'id':
          case 'sku':
          case 'name':
          case 'group':
          case 'temperatureGroup':
          case 'notes':
            next[field] = String(value)
            return next
          default:
            return next
        }
      }),
    )
  }

  const addCargoRow = () => {
    const newRow: CargoSpec = normalizeCargo({
      id: `cargo-${cargo.length + 1}`,
      sku: `SKU-${cargo.length + 1}`,
      name: `New Cargo ${cargo.length + 1}`,
      length: 100,
      width: 60,
      height: 50,
      weight: 25,
      quantity: 1,
      fragile: false,
      stackable: true,
      maxStackWeight: 500,
      maxLayers: 3,
      noRotate: false,
      allowedRotations: [],
      thisSideUp: false,
      floorOnly: false,
      priority: 1,
      group: 'general',
      unloadSequence: 1,
      clearance: 5,
      temperatureGroup: 'normal',
      notes: '',
    })
    setPlan(null)
    setCargo((current) => [...current, newRow])
  }

  const removeCargoRow = (index: number) => {
    setPlan(null)
    setCargo((current) => current.filter((_, rowIndex) => rowIndex !== index))
  }

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const arrayBuffer = await file.arrayBuffer()
    const workbook = XLSX.read(arrayBuffer, { type: 'array' })
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })

    const data = rows.map((row, index) =>
      normalizeCargo({
        id: `import-${index + 1}`,
        sku: String(row.sku ?? row.SKU ?? `SKU-${index + 1}`),
        name: String(row.name ?? row.Name ?? `Imported Cargo ${index + 1}`),
        length: Number(row.length ?? row.L ?? row.dai ?? row['Length'] ?? 0),
        width: Number(row.width ?? row.W ?? row.rong ?? row['Width'] ?? 0),
        height: Number(row.height ?? row.H ?? row.cao ?? row['Height'] ?? 0),
        weight: Number(row.weight ?? row.kg ?? row['Weight'] ?? row['kg'] ?? 0),
        quantity: Number(row.quantity ?? row.qty ?? row['Quantity'] ?? row['Qty'] ?? 1),
        fragile: String(row.fragile ?? row.Fragile ?? 'false').toLowerCase() === 'true',
        stackable: String(row.stackable ?? row.Stackable ?? 'true').toLowerCase() !== 'false',
        maxStackWeight: Number(row.maxstackweight ?? row.MaxStackWeight ?? 0),
        maxLayers: Number(row.maxlayers ?? row.MaxLayers ?? 1),
        noRotate: String(row.norotate ?? row.NoRotate ?? 'false').toLowerCase() === 'true',
        thisSideUp: String(row.thissideup ?? row.ThisSideUp ?? 'false').toLowerCase() === 'true',
        floorOnly: String(row.flooronly ?? row.FloorOnly ?? 'false').toLowerCase() === 'true',
        priority: Number(row.priority ?? row.Priority ?? 1),
        group: String(row.group ?? row.Group ?? 'general'),
        unloadSequence: Number(row.unloadsequence ?? row.UnloadSequence ?? 1),
        clearance: Number(row.clearance ?? row.Clearance ?? 0),
        temperatureGroup: String(row.temperaturegroup ?? row.TemperatureGroup ?? 'normal'),
        notes: String(row.notes ?? row.Notes ?? ''),
      }),
    )

    if (data.length > 0) {
      setPlan(null)
      setCargo(data)
    }
    event.target.value = ''
  }

  const handleAskAi = () => {
    setAiAnswer(generateAiAnswer(question, plan))
  }

  const downloadBlob = (content: string, fileName: string, type: string) => {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportJson = () => {
    downloadBlob(JSON.stringify({ container, cargo }, null, 2), 'loading-plan.json', 'application/json')
  }

  const exportCsv = () => {
    const csv = cargo
      .map((item) => `${item.sku},${item.name},${item.length},${item.width},${item.height},${item.weight},${item.quantity}`)
      .join('\n')
    downloadBlob(csv, 'loading-plan.csv', 'text/csv;charset=utf-8;')
  }

  const exportPdf = () => {
    const pdf = new jsPDF()
    pdf.setFontSize(18)
    pdf.text('Container Load Optimizer AI', 14, 18)
    pdf.setFontSize(11)
    pdf.text(`Container: ${container.name}`, 14, 30)
    pdf.text(`Tỷ lệ thể tích: ${plan ? plan.volumeUtilization.toFixed(1) : '0.0'}%`, 14, 38)
    pdf.text(`Số kiện đã xếp: ${plan ? plan.loaded.length : 0}`, 14, 46)
    pdf.text(`Tổng trọng lượng: ${plan ? plan.totalCargoWeight.toFixed(0) : totalCargoWeight.toFixed(0)} kg`, 14, 54)
    pdf.text('Ghi chú: Kế hoạch xếp hàng là đề xuất tối ưu. Việc xếp hàng cuối cùng cần được kiểm tra lại theo điều kiện hàng hóa thực tế và quy định vận chuyển.', 14, 70, { maxWidth: 180 })
    pdf.save('loading-plan.pdf')
  }

  const downloadTemplate = () => {
    downloadBlob(createTemplateCsv(), 'container-load-template.csv', 'text/csv;charset=utf-8;')
  }

  const resultCards = [
    { label: 'Container đã dùng', value: plan ? `${plan.totalContainers}` : '0', accent: 'cyan' },
    { label: 'Tỷ lệ thể tích', value: plan ? `${plan.volumeUtilization.toFixed(2)}%` : '0.00%' },
    { label: 'Tỷ lệ tải trọng', value: plan ? `${plan.payloadUtilization.toFixed(1)}%` : '0.0%' },
    { label: 'Điểm tối ưu', value: plan ? `${plan.score.toFixed(1)}/100` : '0/100' },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">CL</div>
          <div>
            <p className="eyebrow">AI LOGISTICS</p>
            <h2>Container Load Optimizer</h2>
          </div>
        </div>

        <nav className="nav">
          {['Bảng điều khiển', 'Container', 'Hàng hóa', 'Tối ưu', '3D Loading', 'Báo cáo', 'Nhập / Xuất', 'Cài đặt'].map((item) => (
            <button key={item} type="button" className="nav-item">
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">TỐI ƯU 3D THÔNG MINH</p>
            <h1>Container Load Optimizer AI</h1>
          </div>
          <div className="actions">
            <button type="button" className="primary" onClick={handleLoadDemo}>🚀 CHẠY DEMO TỐI ƯU</button>
            <button type="button" className="secondary" onClick={() => fileInputRef.current?.click()}>Nhập Excel/CSV</button>
            <button type="button" className="secondary" onClick={handleOptimize}>Tối ưu</button>
            <button type="button" className="ghost" onClick={handleReset}>Đặt lại</button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleImport} />
          </div>
        </header>

        <section className="stats-row">
          {resultCards.map((card) => (
            <div key={card.label} className="stat-card">
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </div>
          ))}
        </section>

        <section className="workspace-grid">
          <div className="panel panel-lg">
            <div className="panel-header">
              <h3>Thông tin Container</h3>
            </div>
            <div className="form-grid">
              <label>
                Loại container
                <select value={container.name} onChange={(event) => {
                  setPlan(null)
                  setContainer((current) => ({ ...current, name: event.target.value }))
                }}>
                  <option value="20ft GP">20ft GP</option>
                  <option value="40ft GP">40ft GP</option>
                  <option value="40ft HC">40ft HC</option>
                  <option value="45ft HC">45ft HC</option>
                  <option value="Custom">Tùy chỉnh</option>
                </select>
              </label>
              <label>
                Chiều dài (mm)
                <input type="number" value={container.length} onChange={(event) => handleContainerChange('length', event.target.value)} />
              </label>
              <label>
                Chiều rộng (mm)
                <input type="number" value={container.width} onChange={(event) => handleContainerChange('width', event.target.value)} />
              </label>
              <label>
                Chiều cao (mm)
                <input type="number" value={container.height} onChange={(event) => handleContainerChange('height', event.target.value)} />
              </label>
              <label>
                Tải trọng tối đa (kg)
                <input type="number" value={container.payload} onChange={(event) => handleContainerChange('payload', event.target.value)} />
              </label>
              <label>
                Trọng lượng tổng cho phép (kg)
                <input type="number" value={container.maxGrossWeight} onChange={(event) => handleContainerChange('maxGrossWeight', event.target.value)} />
              </label>
              <label>
                Bề rộng cửa (mm)
                <input type="number" value={container.doorWidth} onChange={(event) => handleContainerChange('doorWidth', event.target.value)} />
              </label>
              <label>
                Chiều cao cửa (mm)
                <input type="number" value={container.doorHeight} onChange={(event) => handleContainerChange('doorHeight', event.target.value)} />
              </label>
            </div>
          </div>

          <div className="panel panel-lg">
            <div className="panel-header split-header">
              <h3>Dữ liệu hàng hóa</h3>
              <div className="inline-actions">
                <button type="button" className="secondary" onClick={downloadTemplate}>Tải mẫu Excel</button>
                <button type="button" className="secondary" onClick={addCargoRow}>Thêm dòng</button>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Tên</th>
                    <th>L</th>
                    <th>W</th>
                    <th>H</th>
                    <th>Trọng lượng</th>
                    <th>SL</th>
                    <th>Dễ vỡ</th>
                    <th>Xếp chồng</th>
                    <th>Xóa</th>
                  </tr>
                </thead>
                <tbody>
                  {cargo.map((item, index) => (
                    <tr key={`${item.id}-${index}`}>
                      <td><input value={item.sku} onChange={(event) => updateCargoRow(index, 'sku', event.target.value)} /></td>
                      <td><input value={item.name} onChange={(event) => updateCargoRow(index, 'name', event.target.value)} /></td>
                      <td><input type="number" value={item.length} onChange={(event) => updateCargoRow(index, 'length', event.target.value)} /></td>
                      <td><input type="number" value={item.width} onChange={(event) => updateCargoRow(index, 'width', event.target.value)} /></td>
                      <td><input type="number" value={item.height} onChange={(event) => updateCargoRow(index, 'height', event.target.value)} /></td>
                      <td><input type="number" value={item.weight} onChange={(event) => updateCargoRow(index, 'weight', event.target.value)} /></td>
                      <td><input type="number" value={item.quantity} onChange={(event) => updateCargoRow(index, 'quantity', event.target.value)} /></td>
                      <td><input type="checkbox" checked={item.fragile} onChange={(event) => updateCargoRow(index, 'fragile', event.target.checked)} /></td>
                      <td><input type="checkbox" checked={item.stackable} onChange={(event) => updateCargoRow(index, 'stackable', event.target.checked)} /></td>
                      <td><button type="button" className="icon-button" onClick={() => removeCargoRow(index)}>x</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="analysis-grid">
          <div className="panel viewer-panel">
            <div className="panel-header split-header">
              <h3>Trực quan 3D</h3>
              <div className="inline-actions">
                <button type="button" className="secondary" onClick={() => setView('front')} aria-pressed={view === 'front'}>Mặt trước</button>
                <button type="button" className="secondary" onClick={() => setView('top')} aria-pressed={view === 'top'}>Mặt trên</button>
              </div>
            </div>
            <div className="viewer">
              {plan ? (
                <Container3D container={container} placements={plan.loaded.filter((item) => item.containerIndex === 1)} view={view} />
              ) : (
                <div className="empty-state">Tải dữ liệu demo hoặc chạy tối ưu để hiển thị kế hoạch 3D.</div>
              )}
            </div>
          </div>

          <div className="panel right-stack">
            <div className="panel-header">
              <h3>Trợ lý tối ưu AI</h3>
            </div>
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={4} />
            <button type="button" className="primary" onClick={handleAskAi}>Hỏi AI</button>
            <div className="ai-answer">{aiAnswer}</div>

            <div className="panel-header top-spacing">
              <h3>Nhật ký tối ưu</h3>
            </div>
            <ul className="log-list">
              {logs.slice(-8).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="result-grid">
          <div className="panel">
            <div className="panel-header">
              <h3>Kết quả tối ưu</h3>
            </div>
            {plan ? (
              <>
              <div className="result-summary">
                <div><span>Container đã dùng</span><strong>{plan.totalContainers}</strong></div>
                <div><span>Số kiện hàng</span><strong>{plan.loaded.length}</strong></div>
                <div><span>Tỷ lệ thể tích</span><strong>{plan.volumeUtilization.toFixed(2)}%</strong></div>
                <div><span>Tỷ lệ tải trọng</span><strong>{plan.payloadUtilization.toFixed(1)}%</strong></div>
                <div><span>Tổng trọng lượng</span><strong>{plan.totalCargoWeight.toFixed(0)} kg</strong></div>
                <div><span>Điểm tối ưu</span><strong>{plan.score.toFixed(1)}/100</strong></div>
              </div>
              <div className="table-wrap cargo-summary">
                <table>
                  <thead>
                    <tr><th>SKU</th><th>Tên hàng</th><th>Yêu cầu</th><th>Đã xếp</th><th>Còn lại</th><th>Thêm tối đa (CT1)</th><th></th></tr>
                  </thead>
                  <tbody>
                    {cargoSummary.map((item) => {
                      const loaded = loadedBySku.get(item.sku) ?? 0
                      const additional = estimateAdditionalQuantity(item, container, primaryContainerPlacements)
                      return (
                        <tr key={item.sku}>
                          <td>{item.sku}</td>
                          <td>{item.name}</td>
                          <td>{item.requested}</td>
                          <td>{loaded}</td>
                          <td>{Math.max(0, item.requested - loaded)}</td>
                          <td>{additional}</td>
                          <td><button type="button" className="secondary compact-button" disabled={additional === 0} onClick={() => addRecommendedQuantity(item.id, additional)}>Cộng SL</button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {plan.unloaded.length > 0 ? (
                <p className="packing-guidance">Còn {plan.unloaded.length} kiện chưa xếp do giới hạn kích thước, tải trọng hoặc vị trí. Xem danh sách hàng chưa xếp bên dưới.</p>
              ) : plan.volumeUtilization < 90 ? (
                <p className="packing-guidance">Đã xếp đủ {plan.loaded.length}/{requestedItemCount} kiện theo số lượng đã nhập. Cột “Thêm tối đa (CT1)” ước tính mức tối đa theo thể tích và tải trọng còn lại cho từng SKU riêng lẻ; chọn “Cộng SL” để kiểm tra bằng cách xếp thực tế. Nếu đã hết SKU, hãy thêm mã hàng khác để hệ thống phối trộn.</p>
              ) : null}
              </>
            ) : (
              <p className="empty-state small">Chưa có kế hoạch hợp lệ nào được tạo.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3>Vị trí đã chọn</h3>
            </div>
            {selectedPlacement ? (
              <div className="selected-placement">
                <strong>{selectedPlacement.sku}</strong>
                <p>{selectedPlacement.name}</p>
                <p>Kích thước: {selectedPlacement.length} × {selectedPlacement.width} × {selectedPlacement.height} mm</p>
                <p>Vị trí: x {selectedPlacement.x}, y {selectedPlacement.y}, z {selectedPlacement.z}</p>
                <p>Nhóm: {selectedPlacement.group}</p>
              </div>
            ) : (
              <p className="empty-state small">Chọn một kiện hàng từ kế hoạch để xem chi tiết.</p>
            )}
          </div>
        </section>

        <section className="panel bottom-panel">
          <div className="panel-header split-header">
            <h3>Hàng đã xếp</h3>
            <div className="inline-actions">
              <button type="button" className="secondary" onClick={exportCsv}>Xuất CSV</button>
              <button type="button" className="secondary" onClick={exportJson}>Xuất JSON</button>
              <button type="button" className="primary" onClick={exportPdf}>Xuất PDF</button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Thứ tự</th>
                <th>SKU</th>
                <th>Tên</th>
                <th>L</th>
                <th>W</th>
                <th>H</th>
                <th>Trọng lượng</th>
                <th>X</th>
                <th>Y</th>
                <th>Z</th>
              </tr>
            </thead>
            <tbody>
              {(plan?.loaded ?? []).map((item, index) => (
                <tr key={item.id} onClick={() => setSelectedPlacement(item)}>
                  <td>{index + 1}</td>
                  <td>{item.sku}</td>
                  <td>{item.name}</td>
                  <td>{item.length}</td>
                  <td>{item.width}</td>
                  <td>{item.height}</td>
                  <td>{item.weight}</td>
                  <td>{item.x}</td>
                  <td>{item.y}</td>
                  <td>{item.z}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel bottom-panel">
          <div className="panel-header">
            <h3>Vì sao một số kiện không thể xếp vào</h3>
          </div>
          <ul className="reason-list">
            {(plan?.unloaded ?? []).length > 0 ? (
              plan?.unloaded.map((item, index) => (
                <li key={`${item.sku}-${index}`}>
                  <strong>{item.sku}</strong>
                  <span>{item.reason}</span>
                  <small>{item.suggested}</small>
                </li>
              ))
            ) : (
              <li>Không có kiện nào bị bỏ lại trong lần tối ưu hiện tại.</li>
            )}
          </ul>
          {cargo[0] && (
            <p className="explanation">
              {explainPlacementIssue(cargo[0], container, plan?.loaded ?? [], defaultSettings)}
            </p>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
