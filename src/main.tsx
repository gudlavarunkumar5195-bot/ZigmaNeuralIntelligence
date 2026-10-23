import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { assertProductionConfig } from './config/env'
import { initFrontendSentry, Sentry } from './observability/sentry'

assertProductionConfig()
// No-op unless VITE_SENTRY_DSN was set at build time.
initFrontendSentry()

function AppCrashFallback() {
  return (
    <div role="alert" style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong</h1>
      <p style={{ marginBottom: 16 }}>The error has been reported. Please reload the page.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload</button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The only app-level error boundary; reports to Sentry when enabled. */}
    <Sentry.ErrorBoundary fallback={<AppCrashFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
