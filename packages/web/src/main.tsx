import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './responsive.css'
import { App } from './App.js'
import { ViewBoundary } from './ui/ViewBoundary.js'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ViewBoundary label="Helm 主控台"><App /></ViewBoundary>
    </StrictMode>,
  )
}
