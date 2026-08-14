/**
 * MCP Center — settings-driven MCP server manager, browser half.
 *
 * Registers one Settings page (`settings.section`, id `mcp-center`) that
 * talks to the node half's same-origin JSON API (`/mcp-center/api/*`). The
 * node half persists each change to `~/.dsh/mcp-center.json` and connects the
 * server immediately — saving IS the wire, no settings-service RPC involved.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the slot type chain and the locale namespace merge.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ctx.locale (the framework locale service) into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { McpCenterSection } from './McpCenterSection.tsx'
import type { McpCenterSectionInjected } from './McpCenterSection.tsx'
import { installNavIcon } from './nav-icon.ts'
import { en, ERROR_CODE_KEYS, zh, type McpCenterKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP Center settings-page copy. */
    'mcp-center': McpCenterKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'mcp-center'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-center'

/** Required services. */
export const inject = ['slots', 'locale']

/**
 * Mount the Settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Theme-plugin style nav override: the settings shell hardcodes nav icons by
  // section id and offers no icon option on settings.section, so swap the
  // MCP Center row's gear glyph for the link icon via DOM observation. The
  // effect disposer removes the observer when this plugin unloads.
  ctx.effect(() => installNavIcon(), 'mcp-center: settings nav icon')

  // Register the zh/en dictionaries; the section's `locale:` declaration puts
  // the typed `t` seat on the component and the nav label thunk follows the
  // active locale without re-registration.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-center: dictionaries')
  const t = ctx.locale.bind(NS)

  /** Translate a host error payload: machine code first, raw message fallback. */
  const hostError = (body: { code?: unknown; error?: unknown }, fallbackKey: McpCenterKey, params?: Record<string, unknown>): string => {
    const key = typeof body.code === 'string' ? ERROR_CODE_KEYS[body.code] : undefined
    if (key !== undefined) return t(key, params)
    return typeof body.error === 'string' ? body.error : t(fallbackKey, params)
  }

  const injected = (): McpCenterSectionInjected => ({
    loadServers: async () => {
      const resp = await fetch('/mcp-center/api/servers', {
        headers: { 'Content-Type': 'application/json' },
      })
      const body = await resp.json().catch(() => ({}))
      return resp.ok ? (body.servers ?? []) : []
    },
    addServer: async (payload) => {
      const resp = await fetch('/mcp-center/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(hostError(body, 'addError', { status: resp.status, name: payload.name }))
      return body.server
    },
    removeServer: async (id) => {
      const resp = await fetch(`/mcp-center/api/servers/${id}`, { method: 'DELETE' })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(hostError(body, 'removeError', { status: resp.status }))
    },
    toggleServer: async (id, enabled) => {
      const resp = await fetch(`/mcp-center/api/servers/${id}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(hostError(body, 'toggleError', { status: resp.status }))
    },
    reconnectServer: async (id, token) => {
      const resp = await fetch(`/mcp-center/api/servers/${id}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token === undefined ? {} : { token }),
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(hostError(body, 'connectError', { status: resp.status }))
      return body.server
    },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp-center',
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, McpCenterSection))
}
