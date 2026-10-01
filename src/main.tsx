import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from './components/AuthGate'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>{(userId) => <App key={userId} userId={userId} />}</AuthGate>
  </StrictMode>,
)
