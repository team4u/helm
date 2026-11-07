// Temporary browser fixture: real UI and SDK catalog, explicitly synthetic credential status.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmStoreContext } from './src/lib/store-context.js'
import type { HelmStoreValue } from './src/lib/types.js'
import { ProviderAuthModal } from './src/modals/ProviderAuthModal.js'
import './src/styles.css'
import './src/responsive.css'
import fixture from './provider-preview-data.json'

const originalFetch = window.fetch.bind(window)
let saved = ['deepseek']
window.fetch = async (input, init) => {
  const url = String(input)
  if (url === '/api/models/providers') return Response.json(fixture.providers)
  if (url.startsWith('/api/credentials/')) {
    const id = decodeURIComponent(url.split('/').pop()!)
    saved = init?.method === 'DELETE' ? saved.filter((item) => item !== id) : [...new Set([...saved, id])]
    return Response.json({ ok: true })
  }
  if (url === '/api/providers') return Response.json([])
  return originalFetch(input, init)
}
function Preview() {
  const [credentials, setCredentials] = useState(saved.map((id) => ({ id, configured: true })))
  const [open, setOpen] = useState(true)
  const store = {
    providers: [], credentials,
    models: fixture.models.map((model) => ({ ...model, available: model.provider === 'openai' || credentials.some((credential) => credential.id === model.provider) })),
    refreshAssets: async () => setCredentials(saved.map((id) => ({ id, configured: true }))),
    pushNotice: () => {},
  } as unknown as HelmStoreValue
  return <HelmStoreContext.Provider value={store}><button onClick={() => setOpen(true)}>打开模型供应商</button>{open && <ProviderAuthModal onClose={() => setOpen(false)} />}</HelmStoreContext.Provider>
}
createRoot(document.getElementById('root')!).render(<Preview />)
