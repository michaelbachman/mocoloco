import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    manifest: true,
    target: 'es2019',
    sourcemap: false,
    rollupOptions: {
      input: 'src/main.jsx',
      output: { manualChunks: undefined }
    }
  }
})
