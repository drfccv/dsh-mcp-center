/**
 * MCP Center settings section: the managed server list with add / delete /
 * enable/disable forms. The UI talks to the node half's same-origin JSON API
 * through the inject face; the node half persists each change and connects
 * immediately.
 *
 * Styling uses the shared `--dsw-*` theme tokens via inline styles so the
 * standalone package needs no CSS pipeline.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpCenterKey } from './locales.ts'

/** One server row as the node half's API returns it. */
export interface McpServerView {
  id: string
  name: string
  type: 'http' | 'stdio'
  enabled: boolean
  status: string
  toolCount: number
  error: string
  url?: string
  authMode?: string
  command?: string
  args?: string[]
  cwd?: string
}

/** Registration-side business face for the MCP Center section. */
export interface McpCenterSectionInjected {
  loadServers: () => Promise<McpServerView[]>
  addServer: (payload: Record<string, unknown>) => Promise<McpServerView>
  removeServer: (id: string) => Promise<void>
  toggleServer: (id: string, enabled: boolean) => Promise<void>
  reconnectServer: (id: string, token?: string) => Promise<McpServerView>
}

/** Full component props. */
export type McpCenterSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<McpCenterSectionInjected>
  & PropsLocale<'mcp-center'>

/** Translate function bound to the mcp-center namespace. */
export type McpCenterTranslate = TranslateNS<'mcp-center'>

/** Add-form local state. */
interface AddDraft {
  type: 'http' | 'stdio'
  name: string
  url: string
  authMode: 'none' | 'bearer' | 'headers'
  token: string
  headersText: string
  command: string
  args: string
  envText: string
  cwd: string
}

function freshDraft(): AddDraft {
  return {
    type: 'http',
    name: '',
    url: '',
    authMode: 'none',
    token: '',
    headersText: '',
    command: '',
    args: '',
    envText: '',
    cwd: '',
  }
}

/** Theme-token-driven inline styles shared by the section and the form. */
const style = {
  section: {
    padding: '16px 20px',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '100%',
    overflow: 'hidden',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px',
    lineHeight: '1.6',
  } as const,
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '0 0 4px',
  } as const,
  titleIcon: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  } as const,
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
  } as const,
  intro: {
    margin: '0 0 16px',
    color: 'var(--dsw-alias-label-secondary)',
    wordBreak: 'break-word',
  } as const,
  list: {
    listStyle: 'none',
    margin: '0 0 16px',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  } as const,
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: '12px',
    padding: '10px 12px',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '100%',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '8px',
  } as const,
  cardMain: {
    flex: 1,
    minWidth: 0,
    maxWidth: '100%',
  } as const,
  cardName: {
    fontWeight: 600,
    wordBreak: 'break-all',
  } as const,
  cardMeta: {
    color: 'var(--dsw-alias-label-secondary)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px',
    wordBreak: 'break-all',
  } as const,
  badge: {
    fontSize: '11px',
    padding: '2px 8px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2)',
    flexShrink: 0,
  } as const,
  badgeConnected: {
    color: 'var(--dsw-alias-state-success-primary)',
    borderColor: 'var(--dsw-alias-state-success-primary)',
  } as const,
  badgeError: {
    color: 'var(--dsw-alias-state-error-primary)',
    borderColor: 'var(--dsw-alias-state-error-primary)',
  } as const,
  actions: {
    display: 'flex',
    gap: '6px',
    flexShrink: 0,
  } as const,
  button: {
    padding: '5px 10px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '6px',
    cursor: 'pointer',
  } as const,
  primaryButton: {
    padding: '6px 12px',
    fontSize: '12px',
    color: '#fff',
    background: 'var(--dsw-alias-brand-primary)',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  } as const,
  dangerButton: {
    padding: '5px 10px',
    fontSize: '12px',
    color: 'var(--dsw-alias-state-error-primary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-state-error-primary)',
    borderRadius: '6px',
    cursor: 'pointer',
  } as const,
  empty: {
    padding: '16px',
    textAlign: 'center',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px dashed var(--dsw-alias-border-l2)',
    borderRadius: '8px',
  } as const,
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '100%',
    overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '8px',
  } as const,
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    width: '100%',
    minWidth: 0,
  } as const,
  label: {
    fontSize: '12px',
    lineHeight: '1.4',
    color: 'var(--dsw-alias-label-secondary)',
    wordBreak: 'break-word',
  } as const,
  input: {
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-base)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '6px',
  } as const,
  textarea: {
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-base)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '6px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    resize: 'vertical',
  } as const,
  error: {
    margin: 0,
    fontSize: '12px',
    color: 'var(--dsw-alias-state-error-primary)',
  } as const,
  hint: {
    margin: '0 0 16px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-secondary)',
  } as const,
  formActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  } as const,
} as const

/** Status → dictionary key (displayed status text follows the active locale). */
const STATUS_KEY: Record<string, McpCenterKey> = {
  connected: 'status.connected',
  connecting: 'status.connecting',
  error: 'status.error',
  disconnected: 'status.disconnected',
  disabled: 'status.disabled',
}

/** Parse a headers/env payload (object or JSON string) into a flat map; empty on failure. */
function parseRecord(text: string): Record<string, string> {
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = String(value ?? '')
    }
    return out
  } catch {
    return {}
  }
}

/** Server-list row: name, endpoint, status, actions. */
function ServerRow({
  server,
  onRefresh,
  actions,
  t,
}: {
  server: McpServerView
  onRefresh: () => void
  actions: Pick<McpCenterSectionInjected, 'removeServer' | 'toggleServer' | 'reconnectServer'>
  t: McpCenterTranslate
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)

  const run = async (op: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await op()
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const authLabel = server.authMode === 'bearer' ? 'Bearer' : server.authMode === 'headers' ? t('authHeaders') : t('authNone')
  const endpoint = server.type === 'stdio'
    ? `stdio · ${server.command ?? ''} ${(server.args ?? []).join(' ')}`
    : `${authLabel} · ${server.url ?? ''}`

  return (
    <li style={style.card}>
      <div style={style.cardMain}>
        <div style={style.cardName}>
          {server.name}
          {' '}
          <span
            style={{
              ...style.badge,
              ...(server.status === 'connected' ? style.badgeConnected : {}),
              ...(server.status === 'error' ? style.badgeError : {}),
            }}
          >
            {STATUS_KEY[server.status] !== undefined ? t(STATUS_KEY[server.status] as McpCenterKey) : server.status}
            {server.status === 'connected' ? ` (${server.toolCount})` : ''}
          </span>
        </div>
        <div style={style.cardMeta}>{endpoint}</div>
        {error !== '' ? <p style={style.error} role="alert">{error}</p> : null}
        {server.error !== '' ? <p style={style.error} role="alert">{server.error}</p> : null}
        {server.type === 'http' && server.authMode === 'bearer' && showToken ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', width: '100%', maxWidth: '100%' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                style={style.input}
                value={tokenInput}
                placeholder={t('pasteToken')}
                spellCheck={false}
                onChange={(event) => { setTokenInput(event.target.value) }}
              />
            </div>
            <button
              type="button"
              style={style.button}
              disabled={busy}
              onClick={() => {
                void run(() => actions.reconnectServer(server.id, tokenInput).then(() => {
                  setShowToken(false)
                  setTokenInput('')
                }))
              }}
            >
              {t('saveAndConnect')}
            </button>
          </div>
        ) : null}
      </div>
      <div style={style.actions}>
        {server.type === 'http' && server.authMode === 'bearer'
          ? (
            <button
              type="button"
              style={style.button}
              disabled={busy}
              onClick={() => { setShowToken(previous => !previous) }}
            >
              {showToken ? t('collapse') : t('changeToken')}
            </button>
          )
          : null}
        <button
          type="button"
          style={style.button}
          disabled={busy}
          onClick={() => { void run(() => actions.toggleServer(server.id, !server.enabled)) }}
        >
          {server.enabled ? t('disable') : t('enable')}
        </button>
        <button
          type="button"
          style={style.dangerButton}
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('deleteConfirm', { name: server.name }))) void run(() => actions.removeServer(server.id))
          }}
        >
          {t('delete')}
        </button>
      </div>
    </li>
  )
}

/**
 * Add form. Local state only; submit calls the inject face's addServer.
 */
function AddForm({
  onAdded,
  actions,
  t,
}: {
  onAdded: () => void
  actions: Pick<McpCenterSectionInjected, 'addServer'>
  t: McpCenterTranslate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AddDraft>(freshDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (patch: Partial<AddDraft>): void => setDraft(previous => ({ ...previous, ...patch }))

  const nameValid = /^[A-Za-z0-9_-]{1,32}$/.test(draft.name)
  const valid = nameValid && (draft.type === 'stdio' ? draft.command.trim() !== '' : /^https?:\/\//.test(draft.url))

  const submit = async (): Promise<void> => {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        name: draft.name.trim(),
        type: draft.type,
      }
      if (draft.type === 'stdio') {
        payload.command = draft.command.trim()
        payload.args = draft.args
        payload.env = parseRecord(draft.envText)
        if (draft.cwd.trim() !== '') payload.cwd = draft.cwd.trim()
      } else {
        payload.url = draft.url.trim()
        payload.authMode = draft.authMode
        if (draft.authMode === 'bearer') payload.token = draft.token
        if (draft.authMode === 'headers') payload.headers = parseRecord(draft.headersText)
      }
      await actions.addServer(payload)
      setDraft(freshDraft())
      setOpen(false)
      onAdded()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  if (!open) {
    return (
      <button type="button" style={style.primaryButton} onClick={() => { setOpen(true) }}>
        + {t('addServer')}
      </button>
    )
  }

  return (
    <div style={style.form}>
      <div style={style.field}>
        <span style={style.label}>{t('type')}</span>
        <select
          style={style.input}
          value={draft.type}
          onChange={(event) => set({ type: event.target.value as 'http' | 'stdio' })}
        >
          <option value="http">{t('typeHttp')}</option>
          <option value="stdio">{t('typeStdio')}</option>
        </select>
      </div>
      <div style={style.field}>
        <span style={style.label}>{t('nameLabel')}</span>
        <input
          style={style.input}
          value={draft.name}
          spellCheck={false}
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>

      {draft.type === 'stdio' ? (
        <>
          <div style={style.field}>
            <span style={style.label}>{t('commandLabel')}</span>
            <input
              style={style.input}
              value={draft.command}
              spellCheck={false}
              onChange={(event) => set({ command: event.target.value })}
            />
          </div>
          <div style={style.field}>
            <span style={style.label}>{t('cwdLabel')}</span>
            <input
              style={style.input}
              value={draft.cwd}
              spellCheck={false}
              onChange={(event) => set({ cwd: event.target.value })}
            />
          </div>
          <div style={style.field}>
            <span style={style.label}>{t('argsLabel')}</span>
            <input
              style={style.input}
              value={draft.args}
              spellCheck={false}
              onChange={(event) => set({ args: event.target.value })}
            />
          </div>
          <div style={style.field}>
            <span style={style.label}>{t('envLabel')}</span>
            <textarea
              style={style.textarea}
              rows={3}
              value={draft.envText}
              spellCheck={false}
              placeholder={t('envPlaceholder')}
              onChange={(event) => set({ envText: event.target.value })}
            />
          </div>
        </>
      ) : (
        <>
          <div style={style.field}>
            <span style={style.label}>{t('authMode')}</span>
            <select
              style={style.input}
              value={draft.authMode}
              onChange={(event) => set({ authMode: event.target.value as 'none' | 'bearer' | 'headers' })}
            >
              <option value="none">{t('authNone')}</option>
              <option value="bearer">{t('authBearer')}</option>
              <option value="headers">{t('authHeaders')}</option>
            </select>
          </div>
          <div style={style.field}>
            <span style={style.label}>{t('urlLabel')}</span>
            <input
              style={style.input}
              value={draft.url}
              spellCheck={false}
              onChange={(event) => set({ url: event.target.value })}
            />
          </div>
          {draft.authMode === 'bearer' ? (
            <div style={style.field}>
              <span style={style.label}>{t('tokenLabel')}</span>
              <input
                style={style.input}
                value={draft.token}
                spellCheck={false}
                onChange={(event) => set({ token: event.target.value })}
              />
            </div>
          ) : null}
          {draft.authMode === 'headers' ? (
            <div style={style.field}>
              <span style={style.label}>{t('headersLabel')}</span>
              <textarea
                style={style.textarea}
                rows={3}
                value={draft.headersText}
                spellCheck={false}
                onChange={(event) => set({ headersText: event.target.value })}
              />
            </div>
          ) : null}
        </>
      )}

      {!nameValid ? (
        <p style={style.error} role="alert">{t('nameInvalid')}</p>
      ) : null}
      {error !== '' ? <p style={style.error} role="alert">{error}</p> : null}

      <div style={style.formActions}>
        <button type="button" style={style.button} onClick={() => { setOpen(false) }} disabled={busy}>
          {t('cancel')}
        </button>
        <button
          type="button"
          style={style.primaryButton}
          disabled={!valid || busy}
          onClick={() => { void submit() }}
        >
          {busy ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  )
}

/**
 * Render the MCP Center section content column.
 * @param props - composed slot props.
 * @returns the section.
 */
export function McpCenterSection(props: McpCenterSectionProps): ReactNode {
  const { loadServers, removeServer, toggleServer, reconnectServer, addServer, t } = props
  const [servers, setServers] = useState<McpServerView[]>([])
  const timerRef = useRef<number | null>(null)

  const refresh = (): void => {
    void loadServers().then(setServers).catch(() => {})
  }

  useEffect(() => {
    refresh()
    // Poll so connection status stays live without a refresh.
    timerRef.current = window.setInterval(refresh, 3000)
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
    }
  }, [loadServers])

  const actions = { removeServer, toggleServer, reconnectServer }

  return (
    <div style={style.section}>
      <div style={style.titleRow}>
        <span style={style.titleIcon}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            fill="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="m19.97,11.84c.66-.66,1.02-1.53,1.02-2.46s-.36-1.8-1.02-2.46l-.04-.04c-.66-.66-1.53-1.02-2.46-1.02-.17,0-.34.03-.51.05.02-.17.05-.33.05-.51,0-.93-.36-1.8-1.02-2.46-.66-.66-1.53-1.02-2.46-1.02s-1.8.36-2.46,1.02l-7.87,7.87c-.27.27-.27.71,0,.98s.71.27.98,0l7.87-7.87c.39-.39.92-.61,1.47-.61s1.08.22,1.47.61c.39.39.61.92.61,1.48s-.22,1.08-.61,1.48l-5.86,5.86-.08.08c-.27.27-.27.71,0,.98.14.14.31.2.49.2s.36-.07.49-.2l5.94-5.94c.39-.39.92-.61,1.48-.61s1.08.22,1.47.61l.04.04c.39.39.61.92.61,1.47s-.22,1.08-.61,1.48l-7.11,7.11c-.63.63-.63,1.66,0,2.29l1.46,1.46c.14.14.31.2.49.2s.36-.07.49-.2c.27-.27.27-.71,0-.98l-1.46-1.46c-.09-.09-.09-.24,0-.33l7.11-7.11Z" />
            <path d="m17.96,9.83c.27-.27.27-.71,0-.98-.27-.27-.71-.27-.98,0l-5.82,5.82c-.81.81-2.14.81-2.95,0-.81-.81-.81-2.14,0-2.95l5.82-5.82c.27-.27.27-.71,0-.98-.27-.27-.71-.27-.98,0l-5.82,5.82c-1.36,1.36-1.36,3.56,0,4.92.68.68,1.57,1.02,2.46,1.02s1.78-.34,2.46-1.02l5.82-5.82Z" />
          </svg>
        </span>
        <h2 style={style.title}>{t('title')}</h2>
      </div>
      <p style={style.intro}>{t('intro')}</p>
      <p style={style.hint}>{t('hint')}</p>

      {servers.length === 0 ? (
        <div style={style.empty}>{t('empty')}</div>
      ) : (
        <ul style={style.list}>
          {servers.map(server => (
            <ServerRow key={server.id} server={server} onRefresh={refresh} actions={actions} t={t} />
          ))}
        </ul>
      )}

      <AddForm onAdded={refresh} actions={{ addServer }} t={t} />
    </div>
  )
}
