/**
 * MCP Center — settings-driven MCP server manager, node half.
 *
 * A self-contained MCP client that connects to external servers over either
 * transport and registers their tools directly on `ctx.tools`:
 *
 *   - Streamable HTTP: JSON-RPC 2.0 over POST (Content-Type:
 *     application/json), with `Mcp-Session-Id` session continuity and JSON or
 *     SSE response bodies. Auth is optional: no headers at all (no-auth),
 *     a static Bearer token, or arbitrary custom headers.
 *   - stdio: spawn a local command (npx / uvx / python / ...) and speak
 *     JSON-RPC over its stdin/stdout (newline-delimited).
 *
 * Server configs live in `~/.dsh/mcp-center.json` (the same document the
 * Settings page edits through the same-origin JSON API mounted at
 * `/mcp-center/api/*`), so saving IS the wire — no settings-service RPC and
 * no external MCP SDK dependency. Tools appear as `mcp__<serverName>__<raw>`.
 *
 * The transport is implemented here instead of delegating to
 * `@deepseek-ai/dsh-mcp-client` so the plugin carries no peer-dependency chain
 * into the profile: it needs only `tools` and (when the web GUI is mounted)
 * `webServer`.
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the tools service's Context merge (ctx.tools) and the
// registry's tool definition contract for the direct-registration path.
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the webServer service's Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'

/** State file: server configs (no secrets beyond user-supplied tokens). */
const DEFAULT_STATE_PATH = join(homedir(), '.dsh', 'mcp-center.json')
const API_PREFIX = '/mcp-center/api'

// The package's own manifest is the single source of the client version reported
// in the MCP handshake, so it cannot drift from what is published (the relative
// path resolves from both `src/` and the bundled `lib/`).
const { version: VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Public tool-name namespace prefix, matching the dsh-mcp-client convention. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

interface ServerConfig {
  id: string
  name: string
  type: 'http' | 'stdio'
  url?: string
  /** 'none' | 'bearer' | 'headers' — which auth the HTTP request carries. */
  authMode?: 'none' | 'bearer' | 'headers'
  /** Bearer token when authMode === 'bearer'. */
  token?: string
  /** Extra request headers (JSON object) when authMode === 'headers'. */
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  enabled?: boolean
}

interface State {
  servers: ServerConfig[]
}

function loadState(statePath: string): State {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as State
  } catch {
    return { servers: [] }
  }
}

function saveState(statePath: string, state: State): void {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/** Base64url helper. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** Deterministic public tool name: `mcp__<server>__<raw>`, normalized like dsh-mcp-client. */
function publicName(serverName: string, raw: string): string {
  const joined = `mcp__${serverName}__${raw}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${raw}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 64 - 13)}_${hash}`
}

// ---------- HTTP helpers ----------

interface HttpResp {
  status: number
  headers: Headers
  text: string
}

async function httpPostJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60000): Promise<HttpResp> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'manual',
    })
    return { status: resp.status, headers: resp.headers, text: await resp.text() }
  } finally {
    clearTimeout(timer)
  }
}

function parseBody(resp: HttpResp): unknown {
  try {
    return JSON.parse(resp.text)
  } catch {
    return null
  }
}

/** Parse a JSON-RPC response body, including an SSE `data:` payload fallback. */
function parseRpc(resp: HttpResp): unknown {
  let parsed = parseBody(resp)
  if (!parsed) {
    const data = resp.text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    try {
      parsed = JSON.parse(data)
    } catch {}
  }
  return parsed
}

// ---------- stdio transport ----------

interface StdioTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  notify(method: string, params?: unknown): void
  close(): void
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Spawn one stdio MCP server and speak newline-delimited JSON-RPC over its pipes. */
function spawnStdio(server: ServerConfig): StdioTransport {
  // Windows: `npx` / `uvx` are .cmd shims that spawn() cannot resolve directly
  // (ENOENT), and a bare .cmd path fails with EINVAL — they must run through
  // cmd.exe. POSIX spawns the command directly so args never touch a shell;
  // on win32 the quoted argv is joined for cmd.exe /c. The command itself is
  // user-trusted configuration.
  const command = server.command ?? ''
  const args = server.args ?? []
  const win32 = process.platform === 'win32'
  // Quote argv for the cmd.exe command line: cmd.exe /c joins them, so any
  // arg containing spaces (or quotes) must be wrapped to survive the join.
  const winArgs = [command, ...args.map(arg => (/\s|"/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg))].join(' ')
  const child = win32
    ? spawn('cmd.exe', ['/d', '/s', '/c', winArgs], {
      cwd: server.cwd || process.cwd(),
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
    })
    : spawn(command, args, {
      cwd: server.cwd || process.cwd(),
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  const pending = new Map<number, PendingRpc>()
  let buffer = ''
  let stderrTail = ''
  let closed = false
  let seq = 1

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg: { id?: unknown; error?: { message?: string }; result?: unknown } | null
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg !== null && msg.id != null && typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (p === undefined) continue
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
      // server→client notifications (no id) are ignored
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000)
  })
  const fail = (error: Error): void => {
    if (closed) return
    closed = true
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    pending.clear()
  }
  child.on('error', fail)
  child.on('close', () => {
    fail(new Error(stderrTail ? `stdio process exited: ${stderrTail.slice(-300)}` : 'stdio process exited'))
  })

  function send(payload: unknown): void {
    if (closed) throw new Error('stdio process closed')
    child.stdin.write(JSON.stringify(payload) + '\n')
  }
  function request(method: string, params: unknown, timeoutMs = 60000): Promise<unknown> {
    if (closed) return Promise.reject(new Error('stdio process closed'))
    return new Promise((resolve, reject) => {
      const id = seq++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`stdio ${method} timeout`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error as Error)
      }
    })
  }
  function notify(method: string, params?: unknown): void {
    if (closed) return
    try {
      send({ jsonrpc: '2.0', method, params })
    } catch {}
  }
  function close(): void {
    closed = true
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('stdio process closed'))
    }
    pending.clear()
    try {
      child.kill()
    } catch {}
  }
  return { request, notify, close }
}

// ---------- tool schema sanitization ----------

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const isScalar = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
const isPlainObj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Degrade a server JSON Schema to the raw object form the registry accepts. */
function sanitizeValue(node: unknown): Record<string, unknown> {
  if (!isPlainObj(node)) return { description: 'unconstrained JSON value' }
  if (Array.isArray(node.oneOf) && node.oneOf.length >= 2) {
    return { oneOf: node.oneOf.map(sanitizeValue) }
  }
  const t = typeof node.type === 'string' ? node.type : null
  const out: Record<string, unknown> = {}
  if (typeof node.description === 'string') out.description = node.description
  if (t === 'object') {
    out.type = 'object'
    if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties
    if (isPlainObj(node.properties)) {
      const properties: Record<string, unknown> = {}
      for (const key of Object.keys(node.properties)) properties[key] = sanitizeValue(node.properties[key])
      out.properties = properties
      if (Array.isArray(node.required)) {
        const required = node.required.filter((k) => typeof k === 'string' && k in properties)
        if (required.length > 0) out.required = required
      }
    }
  } else if (t === 'array') {
    out.type = 'array'
    if (node.items != null) out.items = sanitizeValue(node.items)
  } else if (t !== null && SCALAR_TYPES.has(t)) {
    out.type = t
    if (Array.isArray(node.enum)) {
      const values = node.enum.filter(isScalar)
      if (values.length > 0) out.enum = values
    }
    if (isScalar(node.const)) out.const = node.const
  } else {
    // Unsupported vocabulary (anyOf/allOf/$ref/pattern/format/bounds/...):
    // degrade to annotation-only — the raw boundary's unconstrained form.
    out.description = out.description ?? 'unconstrained JSON value'
  }
  return out
}

/** Wrap a tool's parameters into the object root the registry expects. */
function convParams(schema: unknown): Record<string, unknown> {
  const root = sanitizeValue(schema)
  if (root.type !== 'object') return { type: 'object', properties: {} }
  return root
}

const textRender = (_args: unknown, value: unknown): ContentBlock[] => [
  { type: 'text', text: (isPlainObj(value) && typeof value.text === 'string' ? value.text : '') || '' },
]
const MCP_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    isError: { type: 'boolean' },
  },
} as const

// ---------- plugin ----------

export const name = 'mcp-center'

/** Hard dependencies: the tool registry and the web server (mounted in web profiles). */
export const inject = ['tools', 'webServer']

interface LiveConn {
  sessionId: string | null
  transport: StdioTransport | null
  tools: Map<string, () => void>
  status: string
  error: string
  toolCount: number
}

/**
 * Mount the manager: load state, register the HTTP API, auto-connect servers.
 * @param ctx - plugin context carrying tools (and webServer when mounted).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: { statePath?: string } = {}): void {
  const statePath = config.statePath ?? DEFAULT_STATE_PATH
  const state = loadState(statePath)
  const live = new Map<string, LiveConn>()
  let rpcSeq = 1

  function setLive(serverId: string, conn: LiveConn): void {
    live.set(serverId, conn)
  }

  function buildHeaders(server: ServerConfig, conn: { sessionId: string | null }): Record<string, string> {
    const headers: Record<string, string> = {}
    if (server.authMode === 'bearer' && server.token) headers.Authorization = `Bearer ${server.token}`
    if (server.authMode === 'headers' && server.headers) {
      for (const [key, value] of Object.entries(server.headers)) headers[key] = value
    }
    if (conn.sessionId) headers['Mcp-Session-Id'] = conn.sessionId
    return headers
  }

  async function mcpRpc(
    server: ServerConfig,
    method: string,
    params: unknown,
    conn: { sessionId: string | null },
    { isNotification = false, retryOnExpired = true }: { isNotification?: boolean; retryOnExpired?: boolean } = {},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    if (!isNotification) payload.id = rpcSeq++
    const resp = await httpPostJson(server.url ?? '', buildHeaders(server, conn), payload)
    if (resp.status === 404 && retryOnExpired && conn.sessionId) {
      await reinitializeSession(server, conn)
      return mcpRpc(server, method, params, conn, { isNotification, retryOnExpired: false })
    }
    if (resp.status >= 400) {
      throw new Error(`MCP ${method} HTTP ${resp.status}: ${String(resp.text).slice(0, 200)}`)
    }
    if (isNotification) return null
    const parsed = parseRpc(resp)
    if (!parsed) throw new Error(`MCP ${method}: non-JSON response`)
    if (isPlainObj(parsed) && parsed.error) {
      throw new Error(
        `MCP ${method}: ${isPlainObj(parsed.error) && typeof parsed.error.message === 'string' ? parsed.error.message : JSON.stringify(parsed.error)}`,
      )
    }
    return isPlainObj(parsed) ? parsed.result : undefined
  }

  function registerTools(
    server: ServerConfig,
    conn: LiveConn,
    tools: Array<{ name?: string; description?: string; inputSchema?: unknown }>,
    callFn: (rawName: string, args: unknown) => Promise<unknown>,
  ): void {
    for (const dispose of conn.tools.values()) {
      try {
        dispose()
      } catch {}
    }
    conn.tools = new Map()
    for (const tool of tools) {
      if (!tool.name) continue
      const publicToolName = publicName(server.name, tool.name)
      const definition: ToolDefinition = {
        name: publicToolName,
        description: `${tool.description ?? ''} [${server.name} MCP]`.slice(0, 2000),
        parameters: convParams(tool.inputSchema),
        output: { schema: MCP_RESULT_SCHEMA, render: textRender },
        isConcurrencySafe: () => true,
        async execute(args: unknown, _exec: ToolRunContext): Promise<{ text: string; isError: boolean }> {
          const result = await callFn(tool.name ?? '', args ?? {})
          const content = isPlainObj(result) && Array.isArray(result.content) ? result.content : []
          const text = content
            .filter((c) => isPlainObj(c) && c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('\n')
          return { text, isError: isPlainObj(result) && result.isError === true }
        },
      }
      conn.tools.set(tool.name, ctx.tools.register(definition))
    }
    conn.toolCount = tools.length
    conn.status = 'connected'
    conn.error = ''
    ctx.logger.info(`mcp-center: ${server.name} connected, ${tools.length} tools`)
  }

  /**
   * Run the HTTP initialize handshake on `conn`, discarding any session id it
   * already holds: an id the server no longer recognizes is what triggers
   * recovery, so resending it would fail again. Shared by the initial connect
   * and by `mcpRpc`'s recovery from an expired session.
   *
   * @param server - the HTTP server entry to handshake with.
   * @param conn - the live connection whose sessionId is replaced.
   */
  async function reinitializeSession(server: ServerConfig, conn: { sessionId: string | null }): Promise<void> {
    const initPayload = {
      jsonrpc: '2.0',
      id: rpcSeq++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-center', version: VERSION },
      },
    }
    conn.sessionId = null
    const resp = await httpPostJson(server.url ?? '', buildHeaders(server, conn), initPayload)
    if (resp.status >= 400) {
      throw new Error(`initialize HTTP ${resp.status}: ${String(resp.text).slice(0, 200)}`)
    }
    const init = parseRpc(resp)
    if (!init || (isPlainObj(init) && init.error)) {
      throw new Error(`initialize failed: ${String(resp.text).slice(0, 200)}`)
    }
    const sid = resp.headers?.get?.('mcp-session-id')
    conn.sessionId = sid ?? null
    await mcpRpc(server, 'notifications/initialized', undefined, conn, {
      isNotification: true,
      retryOnExpired: false,
    }).catch(() => {})
  }

  async function connectHttp(server: ServerConfig, conn: LiveConn): Promise<void> {
    await reinitializeSession(server, conn)
    const listed = (await mcpRpc(server, 'tools/list', {}, conn)) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
    } | null
    registerTools(server, conn, listed?.tools ?? [], (rawName, args) =>
      mcpRpc(server, 'tools/call', { name: rawName, arguments: args }, conn))
  }

  async function connectStdio(server: ServerConfig, conn: LiveConn): Promise<void> {
    try {
      conn.transport?.close?.()
    } catch {}
    const transport = spawnStdio(server)
    conn.transport = transport
    await transport.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-center', version: VERSION },
    })
    transport.notify('notifications/initialized')
    const listed = (await transport.request('tools/list', {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
    } | null
    registerTools(server, conn, listed?.tools ?? [], (rawName, args) =>
      transport.request('tools/call', { name: rawName, arguments: args }))
  }

  async function connect(server: ServerConfig): Promise<void> {
    // Reuse ONE conn object per server and register it BEFORE any async work, so
    // every later mutation (registerTools, disconnect) touches the same object
    // whose tools map carries the disposers. Reconnecting an already-live server
    // therefore releases the previous registration first: its disposers would
    // otherwise stay registered and refuse the replacement as a duplicate tool
    // name, leaving the only repair action unable to recover the server.
    const previous = live.get(server.id)
    if (previous) {
      for (const dispose of previous.tools.values()) {
        try {
          dispose()
        } catch {}
      }
      previous.tools = new Map<string, () => void>()
      previous.toolCount = 0
      try {
        previous.transport?.close?.()
      } catch {}
    }
    const conn: LiveConn = previous ?? {
      sessionId: null,
      transport: null,
      tools: new Map<string, () => void>(),
      status: 'connecting',
      error: '',
      toolCount: 0,
    }
    setLive(server.id, conn)
    try {
      if (server.type === 'stdio') await connectStdio(server, conn)
      else await connectHttp(server, conn)
    } catch (error) {
      for (const dispose of conn.tools.values()) {
        try {
          dispose()
        } catch {}
      }
      conn.tools = new Map()
      conn.toolCount = 0
      try {
        conn.transport?.close?.()
      } catch {}
      conn.transport = null
      conn.status = 'error'
      conn.error = String(error instanceof Error ? error.message : error).slice(0, 300)
      ctx.logger.warn(`mcp-center: ${server.name} error: ${conn.error}`)
    }
  }

  function disconnect(serverId: string): void {
    const conn = live.get(serverId)
    if (!conn) return
    for (const dispose of conn.tools.values()) {
      try {
        dispose()
      } catch {}
    }
    try {
      conn.transport?.close?.()
    } catch {}
    live.delete(serverId)
  }

  function serverView(server: ServerConfig): Record<string, unknown> {
    const conn = live.get(server.id)
    const enabled = server.enabled !== false
    const view: Record<string, unknown> = {
      id: server.id,
      name: server.name,
      type: server.type,
      enabled,
      status: !enabled ? 'disabled' : (conn?.status ?? 'disconnected'),
      toolCount: conn?.toolCount ?? 0,
      error: conn?.error ?? '',
    }
    if (server.type === 'stdio') {
      view.command = server.command
      view.args = server.args ?? []
      view.cwd = server.cwd ?? ''
    } else {
      view.url = server.url
      view.authMode = server.authMode ?? 'none'
    }
    return view
  }

  // ---------- HTTP API on the GUI webserver ----------

  function json(res: ServerResponse, code: number, value: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  }

  /** Tokenize a command-line args string (double/single quotes) into argv. */
  function parseArgs(args: unknown): string[] {
    if (Array.isArray(args)) return args.filter((a): a is string => typeof a === 'string')
    if (typeof args === 'string') {
      const out: string[] = []
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(args))) {
        const value = m[1] ?? m[2] ?? m[3]
        if (value !== undefined) out.push(value)
      }
      return out
    }
    return []
  }

  /** Normalize an env payload (object or JSON string) into a string→string map. */
  function parseEnv(env: unknown): Record<string, string> {
    if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
      const out: Record<string, string> = {}
      for (const key of Object.keys(env)) out[key] = String((env as Record<string, unknown>)[key] ?? '')
      return out
    }
    if (typeof env === 'string' && env.trim()) {
      try {
        const parsed = JSON.parse(env)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parseEnv(parsed)
      } catch {}
    }
    return {}
  }

  /** Parse a headers payload (object or JSON string) into a string→string map. */
  function parseHeaders(headers: unknown): Record<string, string> {
    if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
      const out: Record<string, string> = {}
      for (const key of Object.keys(headers)) out[key] = String((headers as Record<string, unknown>)[key] ?? '')
      return out
    }
    if (typeof headers === 'string' && headers.trim()) {
      try {
        const parsed = JSON.parse(headers)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parseHeaders(parsed)
      } catch {}
    }
    return {}
  }

  const route = ctx.webServer.register({
    kind: 'prefix',
    path: '/mcp-center',
    async handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      try {
        if (!path.startsWith(API_PREFIX)) {
          res.writeHead(404)
          res.end()
          return
        }
        const rest = path.slice(API_PREFIX.length)
        const idMatch = rest.match(/^\/servers\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/)

        if (req.method === 'GET' && rest === '/ping') {
          return json(res, 200, { ok: true, version: 2, stdio: true, http: true })
        }
        if (req.method === 'GET' && rest === '/servers') {
          return json(res, 200, { servers: state.servers.map(serverView) })
        }
        if (req.method === 'POST' && rest === '/servers') {
          const body = await readBody(req)
          const name = String(body.name ?? '').trim()
          const type = body.type === 'stdio' ? 'stdio' : 'http'
          if (!SERVER_NAME_PATTERN.test(name)) {
            return json(res, 400, {
              code: 'name-invalid',
              error: 'name must be 1-32 chars of [A-Za-z0-9_-] (it becomes the mcp__<name>__ tool prefix)',
            })
          }
          if (state.servers.some((s) => s.name === name)) {
            return json(res, 409, { code: 'name-exists', error: `a server named ${name} already exists` })
          }

          let server: ServerConfig
          if (type === 'stdio') {
            const command = String(body.command ?? '').trim()
            if (!command) {
              return json(res, 400, {
                code: 'command-required',
                error: 'stdio server requires a command (executable, e.g. npx / uvx / python)',
              })
            }
            server = {
              id: b64url(randomBytes(8)),
              name,
              type: 'stdio',
              command,
              args: parseArgs(body.args),
              env: parseEnv(body.env),
            }
            const cwd = String(body.cwd ?? '').trim()
            if (cwd) server.cwd = cwd
          } else {
            const serverUrl = String(body.url ?? '').trim()
            const authMode = body.authMode === 'bearer' || body.authMode === 'headers' ? body.authMode : 'none'
            if (!/^https?:\/\//.test(serverUrl)) {
              return json(res, 400, { code: 'url-invalid', error: 'url must be an http(s) URL' })
            }
            server = {
              id: b64url(randomBytes(8)),
              name,
              type: 'http',
              url: serverUrl,
              authMode,
            }
            if (authMode === 'bearer') server.token = String(body.token ?? '')
            if (authMode === 'headers') server.headers = parseHeaders(body.headers)
          }

          state.servers.push(server)
          saveState(statePath, state)
          await connect(server)
          return json(res, 201, { server: serverView(server) })
        }
        if (idMatch) {
          const server = state.servers.find((s) => s.id === idMatch[1])
          if (!server) return json(res, 404, { code: 'not-found', error: 'server not found' })
          const action = idMatch[2]
          if (req.method === 'POST' && action === '/connect') {
            if (server.authMode === 'bearer') {
              const body = await readBody(req)
              if (typeof body.token === 'string' && body.token) {
                server.token = body.token
                saveState(statePath, state)
              }
            }
            await connect(server)
            return json(res, 200, { server: serverView(server) })
          }
          if (req.method === 'POST' && action === '/enabled') {
            const body = await readBody(req)
            const enabled = body.enabled !== false
            if (enabled === (server.enabled !== false)) {
              return json(res, 200, { server: serverView(server) })
            }
            server.enabled = enabled
            saveState(statePath, state)
            if (!enabled) {
              disconnect(server.id)
            } else {
              await connect(server)
            }
            return json(res, 200, { server: serverView(server) })
          }
          if (req.method === 'DELETE' && !action) {
            disconnect(server.id)
            state.servers = state.servers.filter((s) => s.id !== server.id)
            saveState(statePath, state)
            return json(res, 200, { ok: true })
          }
        }
        res.writeHead(404)
        res.end()
      } catch (error) {
        ctx.logger.error(`mcp-center api: ${error instanceof Error ? error.stack : String(error)}`)
        json(res, 500, {
          code: 'internal',
          error: String(error instanceof Error ? error.message : error).slice(0, 300),
        })
      }
    },
  })
  ctx.effect(() => route)

  // On unload/reload, tear down every live transport.
  ctx.effect(() => () => {
    for (const conn of live.values()) {
      try {
        conn.transport?.close?.()
      } catch {}
    }
  })

  // Auto-connect every enabled server at startup.
  for (const server of state.servers) {
    if (server.enabled === false) continue
    void connect(server)
  }
}
