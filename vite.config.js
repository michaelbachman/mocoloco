import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    sourcemap: false,
    target: 'es2019',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0
  },
  server: {
    headers: {
      // Allow CORS during local dev if needed
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    }
  }
})
