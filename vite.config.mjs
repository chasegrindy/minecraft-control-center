import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { apiPort, configPath } from './apps/api/config.mjs'

const proxy = { '/api/mcc/': { target: 'http://127.0.0.1:' + apiPort, changeOrigin: true } }

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_MCC_LIVE': JSON.stringify(existsSync(configPath) ? 'true' : 'false') },
  server: { strictPort: true, proxy },
  preview: { strictPort: true, proxy },
})
