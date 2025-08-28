import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    manifest: true,
    sourcemap: false,
    target: 'es2019',
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  }
})
