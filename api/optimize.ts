import type { IncomingMessage, ServerResponse } from 'node:http'
import { optimizeOwnedProject } from '../src/server/optimizeProject'

interface OptimizeRequest extends IncomingMessage {
  body?: unknown
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

export default async function handler(request: OptimizeRequest, response: ServerResponse) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    sendJson(response, 405, { error: 'Method not allowed.' })
    return
  }

  const authorization = request.headers.authorization
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) {
    sendJson(response, 401, { error: 'Authentication required.' })
    return
  }

  let body = request.body
  try {
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8'))
    if (typeof body === 'string') body = JSON.parse(body)
  } catch {
    sendJson(response, 400, { error: 'Invalid JSON request.' })
    return
  }

  const projectId = body && typeof body === 'object' ? (body as { projectId?: unknown }).projectId : null
  if (typeof projectId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    sendJson(response, 400, { error: 'A valid project ID is required.' })
    return
  }

  try {
    const result = await optimizeOwnedProject(projectId, token)
    sendJson(response, result.status, result.body)
  } catch {
    sendJson(response, 500, { error: 'Optimization service is temporarily unavailable.' })
  }
}