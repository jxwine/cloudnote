import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { WebUpdateNotice } from './components/WebUpdateNotice'
import { ExportDialog } from './components/ExportDialog'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <WebUpdateNotice />
    <ExportDialog />
  </StrictMode>
)
