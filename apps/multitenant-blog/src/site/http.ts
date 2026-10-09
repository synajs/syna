import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Env } from 'synajs'
import type { RequestHeaders } from '../auth/principal.js'
import { UnsafePathError, assertNoSymlink } from '../data/filesystem/files.js'
import type { DomainTable } from './domains.js'
import { requestHost } from './domains.js'
import type { AppEntry } from './app-entry.js'
import { RequestEntry } from './entries.js'
import type { RequestFacts } from './inputs.js'
import type { SiteEnvironmentManager } from './manager.js'

export interface HttpServerOptions {
  readonly app: Env<typeof AppEntry['requires']>
  readonly domains: DomainTable
  /** Honour X-Forwarded-Host. Only enable behind a proxy you control. */
  readonly trustProxy?: boolean
  /**
   * An unknown host reloads the domain table before it is refused, so a tenant
   * saved after startup is served without a restart. Reloads are at most one
   * per this many milliseconds (default 1000): a flood of unknown hosts costs
   * one store scan per interval, not one per request.
   */
  readonly domainRefreshMinIntervalMs?: number
  /**
   * Receives every error the server turned into a 5xx. Clients only ever see a
   * status and a short generic phrase (plus an error code); details stay here.
   * Defaults to `console.error`.
   */
  readonly onError?: (error: unknown, context: HttpErrorContext) => void
}

export interface HttpErrorContext {
  readonly status: number
  readonly tenantId?: string
  readonly host?: string
  readonly path?: string
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' }

function statusForAcquireError(code: string | undefined): number {
  switch (code) {
    case 'SITE_CAPACITY':
    case 'SITE_MANAGER_CLOSED':
    case 'SITE_CREATION_BACKOFF':
      return 503
    case 'UNKNOWN_TENANT':
      return 404
    default:
      return 500
  }
}

/** Runs an async request handler so that no rejection can escape: the client always gets an answer. */
function guarded(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  report: (error: unknown, context: HttpErrorContext) => void,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    handler(request, response).catch((error: unknown) => {
      report(error, { status: 500, ...(request.url !== undefined ? { path: request.url } : {}) })
      if (!response.headersSent) response.writeHead(500, TEXT)
      response.end('Internal error')
    })
  }
}

export interface RunningServer {
  readonly server: Server
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

function lowerHeaders(request: IncomingMessage): RequestHeaders {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ')
  }
  return headers
}

async function listen(server: Server, port: number): Promise<RunningServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as AddressInfo
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

/**
 * Dynamic side of the matrix: host → tenant → leased SiteEnv → RequestEntry.
 * Unknown hosts never reach tenant data; the lease is released after the
 * request world is disposed.
 */
export async function startHttpServer(options: HttpServerOptions, port = 0): Promise<RunningServer> {
  const manager: SiteEnvironmentManager = await options.app.deps.sites.load()
  const trustProxy = options.trustProxy ?? false
  const domainRefreshMinIntervalMs = options.domainRefreshMinIntervalMs ?? 1_000
  const report = options.onError ?? ((error, context) => { console.error(`[hyla-mini http] ${context.status} ${context.tenantId ?? '-'} ${context.path ?? '-'}:`, error) })

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const headers = lowerHeaders(request)
    const host = requestHost(headers, trustProxy)
    let tenantId = host ? options.domains.resolve(host) : undefined
    if (host && tenantId === undefined) {
      // Possibly a tenant saved after the table was loaded: reload (rate-limited)
      // and look again. A failed reload keeps the previous table and answers 404.
      try {
        if (await options.domains.refreshIfStale(domainRefreshMinIntervalMs)) tenantId = options.domains.resolve(host)
      }
      catch (error) {
        report(error, { status: 404, host })
      }
    }
    if (!host || !tenantId) {
      response.writeHead(404, TEXT)
      response.end(`Unknown host ${host ?? '(missing)'}`)
      return
    }
    // Node accepts request targets the WHATWG parser rejects (absolute-form with a
    // bad authority, invalid percent-encoding): they are the client's problem.
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${host}`)
    }
    catch {
      response.writeHead(400, TEXT)
      response.end('Bad request')
      return
    }
    let lease
    try {
      lease = await manager.acquire(tenantId, 'request')
    }
    catch (error) {
      const code = (error as { code?: string }).code
      const status = statusForAcquireError(code)
      if (status >= 500) report(error, { status, tenantId, host, path: url.pathname })
      response.writeHead(status, { ...TEXT, 'retry-after': '1' })
      response.end(status === 503 ? `Service unavailable (${code})` : status === 404 ? 'Unknown tenant' : 'Internal error')
      return
    }
    try {
      const authenticator = await lease.env.deps.auth.load()
      const principal = await authenticator.authenticate(headers)
      const facts: RequestFacts = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        host,
        headers,
        principal,
        target: 'http',
      }
      const result = await lease.env.run(RequestEntry, { request: facts }, async ({ handler }) => (await handler.load()).handle())
      response.writeHead(result.status, {
        ...result.headers,
        'x-hyla-tenant': tenantId,
        'x-hyla-config-revision': String(lease.configRevision),
      })
      response.end(request.method === 'HEAD' ? undefined : result.body)
    }
    catch (error) {
      report(error, { status: 500, tenantId, host, path: url.pathname })
      if (!response.headersSent) response.writeHead(500, TEXT)
      response.end('Internal error')
    }
    finally {
      lease.release()
    }
  }

  const server = createServer(guarded(handle, report))
  return listen(server, port)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/**
 * Serves a static build directory so the static side of the matrix can be read
 * back over HTTP. The root is resolved once; below it nothing may be a symbolic
 * link (a planted link would publish files outside the build), and the file
 * finally read must still resolve inside the root.
 */
export async function startStaticServer(rootDir: string, port = 0): Promise<RunningServer> {
  const root = await realpath(path.resolve(rootDir))
  const report = (error: unknown, context: HttpErrorContext): void => { console.error(`[hyla-mini static] ${context.status} ${context.path ?? '-'}:`, error) }
  const server = createServer(guarded(async (request, response) => {
      let relative: string
      try {
        const url = new URL(request.url ?? '/', 'http://static')
        relative = decodeURIComponent(url.pathname)
      }
      catch {
        response.writeHead(400, TEXT)
        response.end('Bad request')
        return
      }
      if (relative.endsWith('/')) relative += 'index.html'
      // Dot-files (the build manifest among them) are never published.
      if (relative.split('/').some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
        response.writeHead(404, TEXT)
        response.end('Not found')
        return
      }
      const target = path.resolve(root, `.${relative}`)
      if (!target.startsWith(root + path.sep) && target !== root) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      try {
        let file = target
        await assertNoSymlink(root, file)
        const info = await stat(file).catch(() => undefined)
        if (info?.isDirectory()) {
          file = path.join(file, 'index.html')
          await assertNoSymlink(root, file)
        }
        const real = await realpath(file)
        if (real !== root && !real.startsWith(root + path.sep)) throw new UnsafePathError(`${file} resolves outside ${root}`)
        const content = await readFile(real)
        response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
        response.end(content)
      }
      catch {
        response.writeHead(404, TEXT)
        response.end('Not found')
      }
  }, report))
  return listen(server, port)
}
