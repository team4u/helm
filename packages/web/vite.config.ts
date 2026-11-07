import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const hubPort = process.env.HELM_PORT ?? '3202'
const hubTarget = `http://127.0.0.1:${hubPort}`

export default defineConfig({
  plugins: [react()],
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
  },
})
