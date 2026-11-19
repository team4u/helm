import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const hubPort = process.env.HELMX_PORT ?? '3202'
const hubTarget = `http://127.0.0.1:${hubPort}`

function packageNameFromId(id: string): string | null {
  const normalized = id.replaceAll('\\', '/')
  const marker = '/node_modules/'
  const idx = normalized.lastIndexOf(marker)
  if (idx === -1) return null
  const rest = normalized.slice(idx + marker.length)
  if (rest.startsWith('.pnpm/')) return null
  if (rest.startsWith('@')) {
    const parts = rest.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return rest.split('/', 1)[0] ?? null
}

const REACT_PKGS = new Set(['react', 'react-dom', 'scheduler'])
const MARKDOWN_PKGS = new Set([
  'react-markdown',
  'remark-gfm',
  'remark-parse',
  'remark-rehype',
  'unified',
])

export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@helmx/protocol/browser', replacement: fileURLToPath(new URL('../protocol/src/browser.ts', import.meta.url)) },
      { find: /^@helmx\/protocol$/, replacement: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: process.env.VITE_HOST ?? '0.0.0.0',
    port: 3201,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: hubTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: hubTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const pkg = packageNameFromId(id)
          if (pkg === null) return undefined
          if (REACT_PKGS.has(pkg)) return 'vendor-react'
          if (pkg.startsWith('@radix-ui/')) return 'vendor-radix'
          if (pkg === 'lucide-react') return 'vendor-lucide'
          if (MARKDOWN_PKGS.has(pkg) || pkg.startsWith('mdast-') || pkg.startsWith('hast-') || pkg.startsWith('micromark') || pkg.startsWith('unist-')) {
            return 'vendor-markdown'
          }
          if (pkg === 'ajv') return 'vendor-ajv'
          return undefined
        },
      },
    },
  },
})
