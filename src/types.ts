/**
 * Shared types for dsh-mcp-center. Purely structural: the server entry shapes
 * the Settings page submits and the node half persists to
 * `~/.dsh/mcp-center.json`. No runtime dependency on any MCP SDK — the client
 * transport is implemented in the node half itself.
 */

/** One managed MCP server entry as stored in the state document. */
export interface McpServerEntry {
  /** Stable unique id assigned at creation. */
  id: string
  /** Tool-name namespace: `[A-Za-z0-9_-]{1,32}`, unique per list. */
  name: string
  /** Transport selector. */
  type: 'http' | 'stdio'
  /** HTTP transport: MCP endpoint URL. */
  url?: string
  /** HTTP auth mode: no auth, static Bearer token, or custom headers. */
  authMode?: 'none' | 'bearer' | 'headers'
  /** Bearer token when authMode === 'bearer'. */
  token?: string
  /** Extra request headers when authMode === 'headers'. */
  headers?: Record<string, string>
  /** stdio transport: executable to spawn. */
  command?: string
  /** stdio transport: argv. */
  args?: string[]
  /** stdio transport: extra env merged over the ambient environment. */
  env?: Record<string, string>
  /** stdio transport: working directory for the child process. */
  cwd?: string
  /** Global enable flag; disabled servers stay dormant across restarts. */
  enabled?: boolean
}

/** The persisted state document. */
export interface McpCenterState {
  servers: McpServerEntry[]
}
