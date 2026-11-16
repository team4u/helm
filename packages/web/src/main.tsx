import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './responsive.css'
import { App } from './App.js'
import { registerBrowserNotificationServiceWorker } from './lib/browser-notification.js'
import { ViewBoundary } from '@helm/plugin-client'

const container = document.getElementById('root')
if (container) {
  void registerBrowserNotificationServiceWorker()
  createRoot(container).render(
    <StrictMode>
      <ViewBoundary label="Helm 主控台"><App /></ViewBoundary>
    </StrictMode>,
  )
}
