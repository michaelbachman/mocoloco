import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2019',
    sourcemap: false
  },
  server: {
    headers: {
      // helpful locally to mimic Netlify CSP
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self' https://api.kraken.com wss://ws.kraken.com; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'"
    }
  }
})
