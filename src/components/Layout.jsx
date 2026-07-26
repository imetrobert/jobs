import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Layout({ children, actions }) {
  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">
          Job Match
          <span className="nav-sub">imetrobert</span>
        </div>
        <div className="nav-links">
          <NavLink to="/" end>Matches</NavLink>
          <NavLink to="/applications">Pipeline</NavLink>
          <NavLink to="/profile">Profile</NavLink>
          <NavLink to="/sources">Sources</NavLink>
        </div>
        <div className="nav-actions">
          {actions}
          <button className="btn ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  )
}
