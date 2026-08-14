/**
 * Self-contained tsdown config for dsh-mcp-center (standalone package, mirrors
 * the official dsh web client-bundle contract and the neko-theme precedent):
 *
 * - lib/index.js — the node half (ESM): the self-contained MCP client
 *   manager. It uses only Node built-ins plus the cordis `Context` type; the
 *   `tools` and `webServer` services are injected at runtime, never imported.
 * - lib/client.js — the browser half: a closure-factory artifact that calls
 *   window.__ModuleLoader__.load({ id, factory }) and inlines everything except
 *   React (a platform module shared through the loader table).
 */
import type { UserConfig } from 'tsdown'

const ID = 'dsh-mcp-center'

export default (): UserConfig[] => [
  {
    name: `${ID}/index`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // Emit the host-half declaration (name/inject/apply) so TypeScript
    // consumers resolve the plugin entry; the client half stays type-free
    // (browser closure artifact).
    dts: true,
    clean: false,
    // cordis is a peer provided by the dsh runtime; everything else is a Node
    // built-in that the bundler keeps as-is.
    external: ['@deepseek-ai/cordis'],
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    // React is a platform module shared through the loader table; every other
    // dependency is either type-only (erased) or inlined.
    external: ['react', 'react/jsx-runtime'],
    noExternal: [/.*/],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
