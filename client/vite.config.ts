import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      // headers.origin as well as changeOrigin: changeOrigin only rewrites
      // Host, leaving the browser's own Origin intact — which is exactly the
      // mismatch middleware/verifyOrigin.ts rejects as CSRF, so every POST in
      // dev mode would 403 while GETs sailed through.
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
        headers: { origin: 'http://localhost:3100' },
      },
    },
  },
  build: { outDir: 'dist' },
})
