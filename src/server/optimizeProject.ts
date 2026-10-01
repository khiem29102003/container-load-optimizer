import { createClient } from '@supabase/supabase-js'
import { runOptimizer } from '../optimizer/engine.ts'
import type { CargoSpec, ContainerSpec, OptimizationResult, LoadingProject } from '../types.ts'

export interface OptimizeProjectResponse {
  status: number
  body: { plan?: OptimizationResult; error?: string }
}

export interface OptimizerEnvironment {
  supabaseUrl?: string
  publishableKey?: string
}

function isValidContainer(value: unknown): value is ContainerSpec {
  if (!value || typeof value !== 'object') return false
  const container = value as Partial<ContainerSpec>
  const dimensionsValid = [container.length, container.width, container.height].every((dimension) =>
    typeof dimension === 'number' && Number.isFinite(dimension) && dimension > 0 && dimension <= 100_000,
  )
  const limitsValid = [container.payload, container.tareWeight, container.maxGrossWeight, container.doorWidth, container.doorHeight, container.clearance].every((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000_000,
  )
  return dimensionsValid && limitsValid
}

function validateCargo(value: unknown): value is CargoSpec[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false

  let itemCount = 0
  for (const valueItem of value) {
    if (!valueItem || typeof valueItem !== 'object') return false
    const item = valueItem as Partial<CargoSpec>
    if (typeof item.sku !== 'string' || !item.sku.trim() || typeof item.name !== 'string' || !item.name.trim()) return false
    if (![item.length, item.width, item.height].every((dimension) =>
      typeof dimension === 'number' && Number.isFinite(dimension) && dimension > 0 && dimension <= 100_000,
    )) return false
    if (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight < 0 || item.weight > 10_000_000) return false
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity < 0 || item.quantity > 300) return false

    itemCount += Math.round(item.quantity)
    if (itemCount > 300) return false
  }
  return true
}

export async function optimizeOwnedProject(
  projectId: string,
  accessToken: string,
  environment: OptimizerEnvironment = {},
): Promise<OptimizeProjectResponse> {
  const supabaseUrl = environment.supabaseUrl ?? process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const publishableKey = environment.publishableKey ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !publishableKey) {
    return { status: 500, body: { error: 'Supabase server configuration is missing.' } }
  }

  const client = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })

  const { data: userData, error: authError } = await client.auth.getUser(accessToken)
  if (authError || !userData.user) {
    return { status: 401, body: { error: 'Your session is invalid or expired. Please sign in again.' } }
  }

  const { data, error: projectError } = await client
    .from('loading_projects')
    .select('id, owner_id, container, cargo')
    .eq('id', projectId)
    .eq('owner_id', userData.user.id)
    .maybeSingle()

  if (projectError) return { status: 500, body: { error: 'Could not load the project for optimization.' } }
  if (!data) return { status: 404, body: { error: 'Project not found.' } }

  const project = data as unknown as Pick<LoadingProject, 'container' | 'cargo'>
  if (!isValidContainer(project.container) || !validateCargo(project.cargo)) {
    return { status: 400, body: { error: 'Project dimensions or cargo count are invalid. Maximum workload is 100 SKUs and 300 units.' } }
  }

  let plan: OptimizationResult
  try {
    plan = runOptimizer(project.container, project.cargo)
  } catch {
    return { status: 422, body: { error: 'The optimizer could not build a plan for this cargo.' } }
  }

  const { error: saveError } = await client
    .from('loading_projects')
    .update({ plan })
    .eq('id', projectId)
    .eq('owner_id', userData.user.id)

  if (saveError) return { status: 500, body: { error: 'The plan was calculated but could not be saved.' } }
  return { status: 200, body: { plan } }
}