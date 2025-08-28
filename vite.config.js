import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    target: 'es2019',
    sourcemap: false,
    manifest: true,
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    port: 5173,
    strictPort: true
  }
})