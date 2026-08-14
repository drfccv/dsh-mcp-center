/**
 * Settings nav glyph override — the theme-plugin pattern applied to one row.
 *
 * The settings shell hardcodes nav icons by section id (`navIcon` in
 * ui-settings-general): unknown ids (including `mcp-center`) fall back to a
 * gear, and the `settings.section` registration offers no icon option. Rather
 * than modifying the shell, this module observes the rendered nav and swaps
 * the gear <svg> of the MCP Center row for the Boxicons link glyph — the same
 * DOM-injection approach an installable theme plugin uses. All writes are
 * retracted by the returned disposer.
 */

const LINK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="m19.97,11.84c.66-.66,1.02-1.53,1.02-2.46s-.36-1.8-1.02-2.46l-.04-.04c-.66-.66-1.53-1.02-2.46-1.02-.17,0-.34.03-.51.05.02-.17.05-.33.05-.51,0-.93-.36-1.8-1.02-2.46-.66-.66-1.53-1.02-2.46-1.02s-1.8.36-2.46,1.02l-7.87,7.87c-.27.27-.27.71,0,.98s.71.27.98,0l7.87-7.87c.39-.39.92-.61,1.47-.61s1.08.22,1.47.61c.39.39.61.92.61,1.48s-.22,1.08-.61,1.48l-5.86,5.86-.08.08c-.27.27-.27.71,0,.98.14.14.31.2.49.2s.36-.07.49-.2l5.94-5.94c.39-.39.92-.61,1.48-.61s1.08.22,1.47.61l.04.04c.39.39.61.92.61,1.47s-.22,1.08-.61,1.48l-7.11,7.11c-.63.63-.63,1.66,0,2.29l1.46,1.46c.14.14.31.2.49.2s.36-.07.49-.2c.27-.27.27-.71,0-.98l-1.46-1.46c-.09-.09-.09-.24,0-.33l7.11-7.11Z"/><path d="m17.96,9.83c.27-.27.27-.71,0-.98-.27-.27-.71-.27-.98,0l-5.82,5.82c-.81.81-2.14.81-2.95,0-.81-.81-.81-2.14,0-2.95l5.82-5.82c.27-.27.27-.71,0-.98-.27-.27-.71-.27-.98,0l-5.82,5.82c-1.36,1.36-1.36,3.56,0,4.92.68.68,1.57,1.02,2.46,1.02s1.78-.34,2.46-1.02l5.82-5.82Z"/></svg>`

const TARGET_LABEL = 'MCP Center'
/** Marker so a row we already patched is not re-patched on later mutations. */
const PATCHED = 'data-mcp-center-nav'

/**
 * Replace the first <svg> of the settings nav row whose label text is
 * `MCP Center` with the link glyph. The settings panel mounts/unmounts with
 * its open state and re-renders nav rows on locale changes, so a caller keeps
 * a MutationObserver alive and calls this on every mutation.
 * @returns the number of rows patched.
 */
function patchNavRows(): number {
  let patched = 0
  for (const span of document.querySelectorAll('nav span')) {
    if (span.textContent !== TARGET_LABEL) continue
    const cell = span.parentElement
    if (cell === null || cell.hasAttribute(PATCHED)) continue
    const gear = cell.querySelector(':scope > svg')
    if (gear === null) continue
    const icon = document.createElement('span')
    icon.innerHTML = LINK_ICON_SVG
    const svg = icon.firstElementChild
    if (svg === null) continue
    gear.replaceWith(svg)
    cell.setAttribute(PATCHED, '')
    patched += 1
  }
  return patched
}

/**
 * Install the nav glyph override. The settings panel renders only while open,
 * so a MutationObserver re-runs the patch on every DOM change and after each
 * mutation pass until the row is patched.
 * @returns the disposer removing the observer.
 */
export function installNavIcon(): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(() => { void patchNavRows() })
  // Patch whatever is already mounted, then watch for the panel opening.
  void patchNavRows()
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}
