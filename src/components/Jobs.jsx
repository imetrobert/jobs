import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Layout from './Layout'
import JobCard from './JobCard'
import KeywordGaps from './KeywordGaps'
import { triggerScan, getToken, setToken } from '../lib/refresh'

const TIERS = [
  { key: 'all', label: 'All' },
  { key: 'exceptional', label: 'Exceptional' },
  { key: 'strong', label: 'Strong' },
  { key: 'possible', label: 'Possible' },
  { key: 'stretch', label: 'Stretch' },
]

function relTime(iso) {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400_000)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return `${Math.floor(days / 30)} mo ago`
}

export default function Jobs({ session }) {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tier, setTier] = useState('all')
  const [lastRun, setLastRun] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const [tokenInput, setTokenInput] = useState(getToken())
  const [showTokenBox, setShowTokenBox] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: rows, error: jobsErr }, { data: runs }] = await Promise.all([
      supabase
        .from('job_ranked')
        .select('*')
        .eq('stale', false)
        .not('score', 'is', null)
        .gte('score', 35)
        .order('score', { ascending: false })
        .limit(200),
      supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(1),
    ])
    if (jobsErr) setError(jobsErr.message)
    else setJobs(rows || [])
    setLastRun(runs?.[0] || null)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // While a scan is running, poll so the page fills in without a manual reload.
  useEffect(() => {
    if (lastRun?.status !== 'running') return
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [lastRun?.status, load])

  async function onRefresh() {
    setRefreshing(true)
    setNotice('')
    try {
      await triggerScan()
      setNotice('Scan started. It usually takes a few minutes — this page will update itself.')
      setTimeout(load, 8000)
    } catch (err) {
      setNotice(err.message)
      if (/token/i.test(err.message)) setShowTokenBox(true)
    }
    setRefreshing(false)
  }

  const shown = tier === 'all' ? jobs : jobs.filter(j => j.tier === tier)
  const counts = jobs.reduce((acc, j) => ({ ...acc, [j.tier]: (acc[j.tier] || 0) + 1 }), {})

  return (
    <Layout
      actions={
        <button className="btn" onClick={onRefresh} disabled={refreshing || lastRun?.status === 'running'}>
          {lastRun?.status === 'running' ? 'Scanning…' : refreshing ? 'Starting…' : 'Refresh now'}
        </button>
      }
    >
      <header className="page-head">
        <h1>Matches</h1>
        <p className="muted">
          {lastRun
            ? lastRun.status === 'error'
              ? `Last scan failed: ${lastRun.error}`
              : `Last scan ${relTime(lastRun.started_at)} — ${lastRun.scored} roles scored, ${lastRun.fetched} postings seen.`
            : 'No scan has run yet. Fill in your Profile, then hit Refresh now.'}
        </p>
      </header>

      {notice && <div className="notice">{notice}</div>}

      {showTokenBox && (
        <div className="card token-box">
          <h3>GitHub token</h3>
          <p className="muted">
            The Refresh button starts the scan workflow on your behalf. Create a token at{' '}
            <a href="https://github.com/settings/tokens/new?scopes=repo&description=Job%20Match%20Refresh" target="_blank" rel="noreferrer">
              github.com/settings/tokens/new
            </a>{' '}
            with the <code>repo</code> scope — that link pre-selects it. It stays in this
            browser only. (A fine-grained token works too, with{' '}
            <code>Actions: read and write</code> on this repo. Note that <code>workflow</code>{' '}
            is <em>not</em> the right scope: it governs editing workflow files, not running them.)
          </p>
          <div className="row">
            <input
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="ghp_…"
            />
            <button
              className="btn"
              onClick={() => {
                setToken(tokenInput)
                setNotice('Token saved.')
                setShowTokenBox(false)
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {!loading && <KeywordGaps jobs={jobs} />}

      <div className="tabs">
        {TIERS.map(t => (
          <button
            key={t.key}
            className={`tab ${tier === t.key ? 'on' : ''}`}
            onClick={() => setTier(t.key)}
          >
            {t.label}
            <span className="pill">{t.key === 'all' ? jobs.length : counts[t.key] || 0}</span>
          </button>
        ))}
        {!getToken() && (
          <button className="tab link" onClick={() => setShowTokenBox(v => !v)}>
            Set up Refresh
          </button>
        )}
      </div>

      {error && <div className="err">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {!loading && shown.length === 0 && (
        <div className="empty">
          <p>Nothing here yet.</p>
          <p className="muted">
            {jobs.length === 0
              ? 'Run a scan once your profile is filled in. Roles scoring under 35 are hidden.'
              : 'No roles in this tier. Try another tab.'}
          </p>
        </div>
      )}

      <div className="job-list">
        {shown.map(job => (
          <JobCard key={job.id} job={job} onChanged={load} />
        ))}
      </div>
    </Layout>
  )
}
