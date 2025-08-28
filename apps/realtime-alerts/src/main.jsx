import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

const el = document.getElementById('root')
if (!el) {
  console.error('[APP] #root not found')
} else {
  createRoot(el).render(<App />)
  console.log('[APP] React mounted')
}
