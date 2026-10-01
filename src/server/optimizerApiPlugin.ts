import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { optimizeOwnedProject, type OptimizerEnvironment } from './optimizeProject.ts'

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

export function optimizerApiPlugin(environment: OptimizerEnvironment): Plugin {
  return {
    name: 'optimizer-api-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/optimize', (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST')
          sendJson(response, 405, { error: 'Method not allowed.' })
          return
        }

        const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
        if (!token) {
          sendJson(response, 401, { error: 'Authentication required.' })
          return
        }

        let bodyText = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (tooLarge) return
          bodyText += chunk
          if (bodyText.length > 16_384) tooLarge = true
        })
        request.on('end', () => {
          if (tooLarge) {
            sendJson(response, 413, { error: 'Request body is too large.' })
            return
          }
          void (async () => {
            try {
              const body = JSON.parse(bodyText) as { projectId?: unknown }
              if (typeof body.projectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.projectId)) {
                sendJson(response, 400, { error: 'A valid project ID is required.' })
                return
              }
              const result = await optimizeOwnedProject(body.projectId, token, environment)
              sendJson(response, result.status, result.body)
            } catch {
              sendJson(response, 400, { error: 'Invalid request or optimization failure.' })
            }
          })()
        })
      })
    },
  }
}