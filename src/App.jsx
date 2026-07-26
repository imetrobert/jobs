import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { supabase, isConfigured } from './lib/supabase'
import Login from './components/Login'
import Jobs from './components/Jobs'
import Profile from './components/Profile'
import Applications from './components/Applications'
import Sources from './components/Sources'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (!isConfigured) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Job Match</h1>
          <p className="muted">
            Deployment succeeded, but the Supabase secrets (VITE_SUPABASE_URL and
            VITE_SUPABASE_ANON_KEY) are not set yet. Add them in the repo's
            Settings → Secrets and variables → Actions, then re-run the deploy.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    )
  }

  const guard = el => (session ? el : <Navigate to="/login" replace />)

  return (
    <Router>
      <Routes>
        <Route path="/login" element={!session ? <Login /> : <Navigate to="/" replace />} />
        <Route path="/" element={guard(<Jobs session={session} />)} />
        <Route path="/profile" element={guard(<Profile session={session} />)} />
        <Route path="/applications" element={guard(<Applications session={session} />)} />
        <Route path="/sources" element={guard(<Sources session={session} />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  )
}
