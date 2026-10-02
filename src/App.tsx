import { lazy, Suspense, type ChangeEvent, useEffect, useRef, useState } from 'react'
import { defaultContainer } from './data/defaults'
import { createTemplateCsv, estimateAdditionalQuantity, explainPlacementIssue, normalizeCargo } from './optimizer/engine'
import { mapCargoGrid } from './lib/importCargo'
import { supabase } from './lib/supabase'
import type { CargoSpec, ContainerSpec, LoadingProject, OptimizationResult, Placement } from './types'
import './App.css'

const Container3D = lazy(() => import('./components/Container3D').then((module) => ({ default: module.Container3D })))
const navigationItems = [
  { label: 'Tổng quan', target: '#dashboard', short: 'TQ' },
  { label: 'Container', target: '#container', short: 'CT' },
  { label: 'Hàng hóa', target: '#cargo', short: 'HH' },
  { label: '3D Loading', target: '#visualization', short: '3D' },
  { label: 'Kết quả', target: '#results', short: 'KQ' },
  { label: 'Tổng hợp mã hàng', target: '#cargo-summary', short: 'TH' },
  { label: 'Xuất báo cáo', target: '#reports', short: 'BC' },
] as const

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

function explainPlan(plan: OptimizationResult | null): string {
  if (!plan) {
    return 'Thêm hàng hóa hoặc nhập bảng dữ liệu để hệ thống tính phương án xếp thực tế.'
  }

  const unloadedText = plan.unloaded.length > 0
    ? ` ${plan.unloaded.length} kiện chưa xếp do giới hạn tải trọng hoặc vị trí.`
    : ' Toàn bộ số lượng đã nhập đều được xếp.'
  return `Kế hoạch có ${plan.totalContainers} container, xếp ${plan.loaded.length} kiện, sử dụng ${plan.volumeUtilization.toFixed(2)}% thể tích và ${plan.payloadUtilization.toFixed(1)}% tải trọng.${unloadedText}`
}

async function persistProjectSnapshot(
  projectId: string,
  userId: string,
  container: ContainerSpec,
  cargo: CargoSpec[],
  plan: OptimizationResult | null,
): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối cơ sở dữ liệu.'
  try {
    const { error } = await supabase
      .from('loading_projects')
      .update({ container, cargo, plan })
      .eq('id', projectId)
      .eq('owner_id', userId)
    return error?.message ?? null
  } catch (error) {
    return error instanceof Error ? error.message : 'Lỗi kết nối cơ sở dữ liệu.'
  }
}

function App({ userId }: { userId: string }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const [projects, setProjects] = useState<LoadingProject[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [projectReady, setProjectReady] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [projectStatus, setProjectStatus] = useState('')
  const [importStatus, setImportStatus] = useState('')
  const [saveStatus, setSaveStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading')
  const [container, setContainer] = useState<ContainerSpec>(defaultContainer)
  const [cargo, setCargo] = useState<CargoSpec[]>([])
  const [plan, setPlan] = useState<OptimizationResult | null>(null)
  const [logs, setLogs] = useState<string[]>(['[hệ thống] Đang tải dự án của bạn.'])
  const [optimizationStatus, setOptimizationStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle')
  const [selectedPlacement, setSelectedPlacement] = useState<Placement | null>(null)
  const [view, setView] = useState<'front' | 'top'>('front')
  const [loadedPage, setLoadedPage] = useState(1)
  const [loadedPageSize, setLoadedPageSize] = useState(25)
  const [activeSection, setActiveSection] = useState('#dashboard')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const totalCargoWeight = cargo.reduce((sum, item) => sum + item.weight * item.quantity, 0)
  const requestedItemCount = cargo.reduce((sum, item) => sum + Math.max(0, Math.round(item.quantity)), 0)
  const loadedItems = plan?.loaded ?? []
  const loadedPageCount = Math.max(1, Math.ceil(loadedItems.length / loadedPageSize))
  const currentLoadedPage = Math.min(loadedPage, loadedPageCount)
  const firstLoadedIndex = (currentLoadedPage - 1) * loadedPageSize
  const visibleLoadedItems = loadedItems.slice(firstLoadedIndex, firstLoadedIndex + loadedPageSize)

  useEffect(() => {
    const sections = navigationItems
      .map(({ target }) => document.querySelector(target))
      .filter((section): section is Element => section !== null)
    const observer = new IntersectionObserver((entries) => {
      const visibleSection = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]
      if (visibleSection) setActiveSection(`#${visibleSection.target.id}`)
    }, { rootMargin: '-96px 0px -65% 0px', threshold: [0, 0.1, 0.25, 0.5] })

    sections.forEach((section) => observer.observe(section))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const client = supabase
    if (!client) return

    let active = true
    const loadProjects = async () => {
      try {
        const { data, error } = await client
          .from('loading_projects')
          .select('*')
          .eq('owner_id', userId)
          .order('updated_at', { ascending: false })

        if (!active) return
        if (error) {
          setProjectStatus(`Không tải được dữ liệu: ${error.message}`)
          setSaveStatus('error')
          return
        }

        let ownedProjects = (data ?? []) as unknown as LoadingProject[]
        if (ownedProjects.length === 0) {
          const { data: created, error: createError } = await client
            .from('loading_projects')
            .insert({ owner_id: userId, name: 'Dự án đầu tiên', container: defaultContainer, cargo: [], plan: null })
            .select('*')
            .single()

          if (!active) return
          if (createError || !created) {
            setProjectStatus(`Không tạo được dự án đầu tiên: ${createError?.message ?? 'Lỗi không xác định'}`)
            setSaveStatus('error')
            return
          }
          ownedProjects = [created as unknown as LoadingProject]
        }

        const firstProject = ownedProjects[0]
        setProjects(ownedProjects)
        setActiveProjectId(firstProject.id)
        setContainer(firstProject.container)
        setCargo(firstProject.cargo)
        setPlan(firstProject.plan)
        setSelectedPlacement(firstProject.plan?.loaded[0] ?? null)
        setProjectReady(true)
        setSaveStatus('saved')
      } catch (error) {
        if (!active) return
        setProjectStatus(`Không kết nối được database: ${error instanceof Error ? error.message : 'Lỗi mạng.'}`)
        setSaveStatus('error')
      }
    }

    void loadProjects()
    return () => { active = false }
  }, [loadAttempt, userId])

  useEffect(() => {
    const client = supabase
    if (!client || !projectReady || !activeProjectId) return

    const timer = window.setTimeout(() => {
      setSaveStatus('saving')
      void persistProjectSnapshot(activeProjectId, userId, container, cargo, plan).then((error) => {
        if (error) {
          setProjectStatus(`Không lưu được dữ liệu: ${error}`)
          setSaveStatus('error')
        } else {
          setProjectStatus('')
          setSaveStatus('saved')
        }
      })
        .catch((error: unknown) => {
          setProjectStatus(`Không lưu được dữ liệu: ${error instanceof Error ? error.message : 'Lỗi mạng.'}`)
          setSaveStatus('error')
        })
    }, 800)

    return () => window.clearTimeout(timer)
  }, [activeProjectId, cargo, container, plan, projectReady, userId])

  useEffect(() => {
    const worker = new Worker(new URL('./optimizer/optimizer.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<{ requestId: number; result: OptimizationResult }>) => {
      if (event.data.requestId !== requestIdRef.current) {
        return
      }
      const result = event.data.result
      setPlan(result)
      setOptimizationStatus('complete')
      setLoadedPage(1)
      setLogs(result.logs)
      setSelectedPlacement(result.loaded[0] ?? null)
    }
    worker.onerror = () => {
      setOptimizationStatus('error')
      setLogs(['[hệ thống] Không thể chạy bộ tối ưu. Vui lòng thử lại.'])
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!projectReady) return
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
      setOptimizationStatus('running')
      setSelectedPlacement(null)
      setLogs(['[hệ thống] Đang tối ưu dữ liệu hiện tại...'])
      worker.postMessage({ requestId, container, cargo, settings: defaultSettings })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [container, cargo, projectReady])

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
  const containerIndexes = plan?.containers.map((containerPlan) => containerPlan.index) ?? []
  const loadedByContainerAndSku = new Map<string, Map<number, number>>()
  for (const placement of plan?.loaded ?? []) {
    const containerCounts = loadedByContainerAndSku.get(placement.sku) ?? new Map<number, number>()
    containerCounts.set(placement.containerIndex, (containerCounts.get(placement.containerIndex) ?? 0) + 1)
    loadedByContainerAndSku.set(placement.sku, containerCounts)
  }
  const cargoLoadSummary = cargoSummary.map((item) => ({
    ...item,
    loaded: loadedBySku.get(item.sku) ?? 0,
    remaining: Math.max(0, item.requested - (loadedBySku.get(item.sku) ?? 0)),
    byContainer: containerIndexes.map((index) => loadedByContainerAndSku.get(item.sku)?.get(index) ?? 0),
  }))

  const handleOptimize = () => {
    if (cargo.length === 0) {
      setProjectStatus('Thêm ít nhất một dòng hàng hóa trước khi tối ưu.')
      return
    }
    setProjectStatus('')
    const worker = workerRef.current
    if (!worker) {
      return
    }
    const requestId = ++requestIdRef.current
    setPlan(null)
    setOptimizationStatus('running')
    setSelectedPlacement(null)
    setLogs(['[hệ thống] Đang tối ưu dữ liệu hiện tại...'])
    worker.postMessage({ requestId, container, cargo, settings: defaultSettings })
  }

  const handleProjectChange = async (projectId: string) => {
    const selected = projects.find((project) => project.id === projectId)
    if (!selected || selected.id === activeProjectId) return
    requestIdRef.current += 1
    setSaveStatus('saving')
    const saveError = await persistProjectSnapshot(activeProjectId, userId, container, cargo, plan)
    if (saveError) {
      setProjectStatus(`Không đổi được dự án vì dữ liệu hiện tại chưa lưu: ${saveError}`)
      setSaveStatus('error')
      return
    }
    setActiveProjectId(selected.id)
    setContainer(selected.container)
    setCargo(selected.cargo)
    setPlan(selected.plan)
    setLoadedPage(1)
    setSelectedPlacement(selected.plan?.loaded[0] ?? null)
    setProjectStatus('')
    setSaveStatus('saved')
  }

  const handleCreateProject = async () => {
    if (!supabase) return
    requestIdRef.current += 1
    setProjectStatus('')
    if (activeProjectId) {
      setSaveStatus('saving')
      const saveError = await persistProjectSnapshot(activeProjectId, userId, container, cargo, plan)
      if (saveError) {
        setProjectStatus(`Không tạo được dự án vì dữ liệu hiện tại chưa lưu: ${saveError}`)
        setSaveStatus('error')
        return
      }
    }
    const { data, error } = await supabase
      .from('loading_projects')
      .insert({ owner_id: userId, name: `Dự án ${projects.length + 1}`, container: defaultContainer, cargo: [], plan: null })
      .select('*')
      .single()

    if (error || !data) {
      setProjectStatus(`Không tạo được dự án: ${error?.message ?? 'Lỗi không xác định'}`)
      return
    }

    const created = data as unknown as LoadingProject
    setProjects((current) => [created, ...current])
    setActiveProjectId(created.id)
    setContainer(created.container)
    setCargo(created.cargo)
    setPlan(created.plan)
    setLoadedPage(1)
    setSelectedPlacement(null)
    setProjectStatus('')
    setSaveStatus('saved')
  }

  const handleSignOut = async () => {
    if (!supabase) return
    if (activeProjectId) {
      setSaveStatus('saving')
      const saveError = await persistProjectSnapshot(activeProjectId, userId, container, cargo, plan)
      if (saveError) {
        setProjectStatus(`Không đăng xuất được vì dữ liệu hiện tại chưa lưu: ${saveError}`)
        setSaveStatus('error')
        return
      }
    }
    const { error } = await supabase.auth.signOut()
    if (error) setProjectStatus(`Không đăng xuất được: ${error.message}`)
  }

  const handleRetryProjectLoad = () => {
    setProjectStatus('')
    setSaveStatus('loading')
    setLoadAttempt((current) => current + 1)
  }

  const handleReset = () => {
    requestIdRef.current += 1
    setPlan(null)
    setLogs(['[hệ thống] Đã xóa kế hoạch tối ưu.'])
    setSelectedPlacement(null)
  }

  const handleClearCargo = () => {
    if (cargo.length === 0 || !window.confirm('Xóa toàn bộ dòng hàng hóa khỏi dự án này?')) return
    requestIdRef.current += 1
    setSaveStatus('saving')
    setProjectStatus('')
    setCargo([])
    setPlan(null)
    setSelectedPlacement(null)
    setLogs(['[hệ thống] Đã xóa hàng hóa khỏi dự án.'])
  }

  const addRecommendedQuantity = (itemId: string, amount: number) => {
    if (amount <= 0) {
      return
    }
    setSaveStatus('saving')
    setPlan(null)
    setCargo((current) => current.map((item) =>
      item.id === itemId ? { ...item, quantity: item.quantity + amount } : item,
    ))
  }

  const handleContainerChange = (field: keyof ContainerSpec, value: string) => {
    const parsed = Number(value)
    setSaveStatus('saving')
    setPlan(null)
    setContainer((current) => ({
      ...current,
      [field]: Number.isFinite(parsed) ? parsed : current[field],
    }))
  }

  const updateCargoRow = (index: number, field: keyof CargoSpec, value: string | boolean) => {
    setSaveStatus('saving')
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
    setSaveStatus('saving')
    setPlan(null)
    setCargo((current) => [...current, newRow])
  }

  const removeCargoRow = (index: number) => {
    setSaveStatus('saving')
    setPlan(null)
    setCargo((current) => current.filter((_, rowIndex) => rowIndex !== index))
  }

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    setImportStatus('')

    if (file.size > 10 * 1024 * 1024) {
      setImportStatus('File quá lớn. Vui lòng chọn file dưới 10 MB.')
      event.target.value = ''
      return
    }

    try {
      const XLSX = await import('xlsx')
      const arrayBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      let bestSheet = ''
      let bestImport = { items: [] as CargoSpec[], warnings: [] as string[], headers: [] as string[] }
      for (const sheetName of workbook.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '' })
        const candidate = mapCargoGrid(rows)
        if (candidate.items.length > bestImport.items.length || (bestImport.headers.length === 0 && candidate.headers.length > 0)) {
          bestSheet = sheetName
          bestImport = candidate
        }
      }

      if (bestImport.items.length > 0) {
        setSaveStatus('saving')
        setPlan(null)
        setCargo(bestImport.items)
        setImportStatus(bestImport.warnings.length > 0
          ? `Đã nhập ${bestImport.items.length} dòng từ sheet “${bestSheet}”; bỏ qua ${bestImport.warnings.length} dòng. ${bestImport.warnings.slice(0, 2).join(' ')}`
          : `Đã nhập ${bestImport.items.length} dòng từ sheet “${bestSheet}”.`)
      } else {
        const detectedHeaders = bestImport.headers.length > 0 ? bestImport.headers.join(', ') : 'không nhận diện được tiêu đề cột'
        setImportStatus(`Không tìm thấy dòng hàng hóa hợp lệ. Cột đọc được: ${detectedHeaders}. Cần có Dài, Rộng, Cao hoặc Quy cách dạng D×R×C.`)
      }
    } catch (error) {
      setImportStatus(`Không đọc được file: ${error instanceof Error ? error.message : 'Định dạng không hợp lệ.'}`)
    } finally {
      event.target.value = ''
    }
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

  const exportPdf = async () => {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF()
    pdf.setFontSize(18)
    pdf.text('Container Load Optimizer', 14, 18)
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

  if (!projectReady) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <p className="eyebrow">DỮ LIỆU DỰ ÁN</p>
          <h1>{saveStatus === 'error' ? 'Không tải được dữ liệu' : 'Đang tải dự án...'}</h1>
          {projectStatus && <p className="auth-error" role="alert">{projectStatus}</p>}
          {saveStatus === 'error' && <button type="button" className="primary" onClick={handleRetryProjectLoad}>Thử kết nối lại</button>}
          <button type="button" className="auth-switch" onClick={() => void handleSignOut()}>Đăng xuất</button>
        </section>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark">CL</div>
          <div className="brand-copy">
            <p className="eyebrow">LOGISTICS OPERATIONS</p>
            <h2>Container Load Optimizer</h2>
          </div>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={!sidebarCollapsed}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          {sidebarCollapsed ? 'Mở menu' : 'Thu gọn'}
        </button>

        <nav className="nav">
          {navigationItems.map(({ label, target, short }) => (
            <a
              key={target}
              href={target}
              title={label}
              aria-label={label}
              aria-current={activeSection === target ? 'location' : undefined}
              className={`nav-item${activeSection === target ? ' nav-item-active' : ''}`}
              onClick={() => setActiveSection(target)}
            >
              <span className="nav-short" aria-hidden="true">{short}</span>
              <span className="nav-label">{label}</span>
            </a>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">TỐI ƯU 3D THÔNG MINH</p>
            <h1>Container Load Optimizer</h1>
          </div>
          <div className="actions">
            <label className="project-picker">Dự án
              <select value={activeProjectId} onChange={(event) => handleProjectChange(event.target.value)} disabled={!projectReady}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <button type="button" className="secondary" onClick={() => void handleCreateProject()} disabled={!projectReady}>Dự án mới</button>
            <span className={`save-status save-status-${saveStatus}`} role="status">
              {saveStatus === 'loading' ? 'Đang tải...' : saveStatus === 'saving' ? 'Đang lưu...' : saveStatus === 'error' ? 'Lỗi lưu' : 'Đã lưu'}
            </span>
            <button type="button" className="ghost" onClick={() => void handleSignOut()}>Đăng xuất</button>
            <button type="button" className="secondary" onClick={() => fileInputRef.current?.click()}>Nhập Excel/CSV</button>
            <button type="button" className="primary optimize-button" onClick={handleOptimize} disabled={cargo.length === 0 || optimizationStatus === 'running'}>
              {optimizationStatus === 'running' ? 'Đang tối ưu...' : 'Tối ưu'}
            </button>
            <button type="button" className="ghost" onClick={handleReset} disabled={!plan}>Xóa kế hoạch</button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleImport} />
          </div>
        </header>
        {projectStatus && <p className="project-message" role="alert">{projectStatus}</p>}
        {importStatus && <p className="import-message" role="status">{importStatus}</p>}
        {optimizationStatus === 'running' && (
          <div className="optimization-banner optimization-banner-running" role="status" aria-live="polite">
            <span className="optimization-spinner" aria-hidden="true" />
            <div className="optimization-copy">
              <strong>Đang tối ưu cách xếp hàng</strong>
              <span>Đang kiểm tra vị trí, hướng xoay, tải trọng và các ràng buộc của kiện hàng.</span>
            </div>
            <div className="optimization-progress-track" role="progressbar" aria-label="Đang tối ưu" aria-valuetext="Đang tính toán">
              <span />
            </div>
          </div>
        )}
        {optimizationStatus === 'complete' && plan && (
          <div className="optimization-banner optimization-banner-complete" role="status" aria-live="polite">
            <strong>Đã tối ưu xong</strong>
            <span>{plan.loaded.length} kiện được xếp trong {plan.totalContainers} container.</span>
          </div>
        )}
        {optimizationStatus === 'error' && (
          <div className="optimization-banner optimization-banner-error" role="alert">
            Không thể hoàn tất tối ưu. Kiểm tra dữ liệu hàng hóa rồi thử lại.
          </div>
        )}

        <section className="stats-row" id="dashboard">
          {resultCards.map((card) => (
            <div key={card.label} className="stat-card">
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </div>
          ))}
        </section>

        <section className="workspace-grid">
          <div className="panel panel-lg" id="container">
            <div className="panel-header">
              <h3>Thông tin Container</h3>
            </div>
            <div className="form-grid">
              <label>
                Loại container
                <select value={container.name} onChange={(event) => {
                  setSaveStatus('saving')
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

          <div className="panel panel-lg" id="cargo">
            <div className="panel-header split-header">
              <h3>Dữ liệu hàng hóa</h3>
              <div className="inline-actions">
                <button type="button" className="secondary" onClick={downloadTemplate}>Tải mẫu Excel</button>
                <button type="button" className="secondary" onClick={addCargoRow}>Thêm dòng</button>
                <button type="button" className="ghost" onClick={handleClearCargo} disabled={cargo.length === 0}>Xóa tất cả</button>
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
                  {cargo.length === 0 ? (
                    <tr><td colSpan={10} className="empty-table-cell">Chưa có hàng hóa. Thêm một dòng hoặc nhập file để bắt đầu.</td></tr>
                  ) : cargo.map((item, index) => (
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
          <div className="panel viewer-panel" id="visualization">
            <div className="panel-header split-header">
              <h3>Trực quan 3D</h3>
              <div className="inline-actions">
                <button type="button" className="secondary" onClick={() => setView('front')} aria-pressed={view === 'front'}>Mặt trước</button>
                <button type="button" className="secondary" onClick={() => setView('top')} aria-pressed={view === 'top'}>Mặt trên</button>
              </div>
            </div>
            <div className="viewer">
              {plan ? (
                <Suspense fallback={<div className="empty-state">Đang tải mô hình 3D...</div>}>
                  <Container3D container={container} placements={plan.loaded.filter((item) => item.containerIndex === 1)} view={view} />
                </Suspense>
              ) : (
                <div className="empty-state">Thêm hàng hóa rồi chọn “Tối ưu” để xem cách xếp trong container.</div>
              )}
            </div>
          </div>

          <div className="panel right-stack">
            <div className="panel-header">
              <h3>Phân tích kế hoạch</h3>
            </div>
            <div className="ai-answer">{explainPlan(plan)}</div>

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

        <section className="result-grid" id="results">
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

        <section className="panel bottom-panel" id="cargo-summary">
          <div className="panel-header">
            <h3>Tổng hợp số lượng theo mã hàng sau khi lên container</h3>
          </div>
          {!plan ? (
            <p className="empty-state small">Chạy tối ưu để xem số lượng đã xếp theo từng mã hàng và container.</p>
          ) : (
            <div className="table-wrap cargo-summary">
              <table>
                <thead>
                  <tr>
                    <th>Mã hàng</th>
                    <th>Tên hàng</th>
                    <th>Yêu cầu</th>
                    {containerIndexes.map((index) => <th key={index}>Container {index}</th>)}
                    <th>Tổng đã xếp</th>
                    <th>Còn lại</th>
                  </tr>
                </thead>
                <tbody>
                  {cargoLoadSummary.map((item) => (
                    <tr key={item.sku}>
                      <td>{item.sku}</td>
                      <td>{item.name}</td>
                      <td>{item.requested}</td>
                      {item.byContainer.map((quantity, index) => <td key={containerIndexes[index]}>{quantity}</td>)}
                      <td>{item.loaded}</td>
                      <td>{item.remaining}</td>
                    </tr>
                  ))}
                </tbody>
                {cargoLoadSummary.length > 0 && (
                  <tfoot>
                    <tr>
                      <th colSpan={3}>Tổng số kiện</th>
                      {containerIndexes.map((containerIndex) => (
                        <td key={containerIndex}>
                          {plan.loaded.filter((item) => item.containerIndex === containerIndex).length}
                        </td>
                      ))}
                      <td>{plan.loaded.length}</td>
                      <td>{Math.max(0, requestedItemCount - plan.loaded.length)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </section>

        <section className="panel bottom-panel" id="reports">
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
              {visibleLoadedItems.map((item, index) => (
                <tr key={item.id} onClick={() => setSelectedPlacement(item)}>
                  <td>{firstLoadedIndex + index + 1}</td>
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
          <div className="pagination-controls">
            <span className="pagination-count">
              {loadedItems.length === 0 ? '0 kiện' : `Hiển thị ${firstLoadedIndex + 1}–${Math.min(firstLoadedIndex + loadedPageSize, loadedItems.length)} / ${loadedItems.length} kiện`}
            </span>
            <label className="page-size-picker">Mỗi trang
              <select value={loadedPageSize} onChange={(event) => {
                setLoadedPageSize(Number(event.target.value))
                setLoadedPage(1)
              }}>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <div className="page-navigation">
              <button type="button" className="secondary" onClick={() => setLoadedPage(Math.max(1, currentLoadedPage - 1))} disabled={currentLoadedPage <= 1}>Trước</button>
              <span>Trang {currentLoadedPage} / {loadedPageCount}</span>
              <button type="button" className="secondary" onClick={() => setLoadedPage(Math.min(loadedPageCount, currentLoadedPage + 1))} disabled={currentLoadedPage >= loadedPageCount}>Sau</button>
            </div>
          </div>
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
