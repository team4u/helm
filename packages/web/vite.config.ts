import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const hubPort = process.env.HELM_PORT ?? '3202'
const hubTarget = `http://127.0.0.1:${hubPort}`

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 3201,
    strictPort: true,
    proxy: {
      '/api': {
        target: hubTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
