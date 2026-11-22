import { useState } from 'react'
import { supabase } from '../lib/supabase'

// "Request access" link: opens an email to Robert with the app and URL filled in.
const APP_NAME = 'Job Match'
const APP_URL = 'https://jobs.imetrobert.com'
const REQUEST_ACCESS_HREF =
  'mailto:robert@imetrobert.com?subject=' + encodeURIComponent('Access request: ' + APP_NAME) +
  '&body=' + encodeURIComponent('Hi Robert,\n\nI would like an account or access to ' + APP_NAME + ' (' + APP_URL + ').\n\nMy name: \nMy email address: \n\nThank you')

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">imetrobert</div>
        <h1>Job Match</h1>
        <div className="muted">Private role matching &amp; application drafting</div>

        <form onSubmit={handleLogin}>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email"
            required
            autoComplete="username"
          />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            required
            autoComplete="current-password"
          />
          <button type="submit" className="btn" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error && <div className="err">{error}</div>}
        <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>
          Need an account or access? Email{' '}
          <a href={REQUEST_ACCESS_HREF}>robert@imetrobert.com</a> and Robert will send you a link to register.
        </p>
      </div>
    </div>
  )
}
