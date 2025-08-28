import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  build: { sourcemap: false, target: 'es2019', modulePreload: { polyfill: false }, reportCompressedSize: true }, plugins: [react()], build: { sourcemap: true, target: 'es2019' } })
