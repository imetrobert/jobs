import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Layout from './Layout'
import JobCard from './JobCard'
import KeywordGaps from './KeywordGaps'
import { triggerScan, getToken, setToken } from '../lib/refresh'
import { CLOSED_STATUSES } from '../lib/statuses'

const TIERS = [
  { key: 'all', label: 'All' },
  { key: 'exceptional', label: 'Exceptional' },
  { key: 'strong', label: 'Strong' },
  { key: 'possible', label: 'Possible' },
  { key: 'stretch', label: 'Stretch' },
]

const NEGOTIABLE_KEY = 'jobs.showNegotiable'

function relTime(iso) {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400_000)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return `${Math.floor(days / 30)} mo ago`
}

// A precise "done at" timestamp, not just the relative day count above —
// the actual clock time so "done" reads as a real completion marker.
function doneAt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  if (sameDay) return `today at ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`
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
  // Anything not confirmed workable from Montreal — on-site elsewhere with
  // no stated remote-from-Canada option, OR remote with no stated Canada
  // eligibility either way — is excluded from the default list, regardless
  // of fit. This toggle opts back into both at once (their score is
  // preserved, not zeroed, for exactly this reason) and remembers its
  // state across visits, same pattern as the saved GitHub token.
  const [showNegotiable, setShowNegotiable] = useState(() => localStorage.getItem(NEGOTIABLE_KEY) === '1')

  const load = useCallback(async () => {
    setLoading(true)
    let jobsQuery = supabase
      .from('job_ranked')
      .select('*')
      .eq('stale', false)
      .not('score', 'is', null)
      .gte('score', 35)
      // Closed out: rejected, passed on, or the posting is gone — done either
      // way, and it shouldn't keep cluttering discovery. The Pipeline page is
      // where it stays visible, and where a mistaken click gets undone.
      // Still-active statuses (applied/interviewing/offer) and untracked
      // roles (app_status is null, the common case) both pass through — a
      // plain .neq() would silently drop every untracked row too, since SQL
      // treats "null <> value" as unknown rather than true.
      .or(`app_status.is.null,app_status.not.in.(${CLOSED_STATUSES.join(',')})`)
      // Belt and braces on dead links. The scan marks a posting stale the
      // moment it confirms the page says the role is closed, so `stale` above
      // already excludes these — but that coupling is easy to break, and a
      // posting we have positively confirmed is gone should never reach the
      // list on the strength of one filter. Null (never checked) and
      // 'unknown' (couldn't tell) both pass: only a confirmed close hides
      // anything.
      .or('link_status.is.null,link_status.neq.dead')
      // Location first: remote-and-Montreal-eligible, then close to Côte
      // Saint-Luc, then a real commute but still Montreal. Fit score only
      // breaks ties within the same location tier.
      .order('location_priority', { ascending: true })
      .order('score', { ascending: false })
      .limit(200)
    // With the checkbox off, the list should be ONLY confirmed-workable
    // roles: remote_montreal, onsite_close, onsite_far. remote_unclear
    // ("might be fine, might not, the posting doesn't say") and
    // not_montreal both keep their real score rather than being zeroed —
    // that's what lets them pass the score filter above at all — so both
    // need excluding here explicitly, not just not_montreal. The checkbox
    // reveals both together; there's no case for treating "ambiguous" as
    // more trustworthy than "confirmed not workable, but a great fit."
    if (!showNegotiable) jobsQuery = jobsQuery.not('location_fit', 'in', '(not_montreal,remote_unclear)')
    const [{ data: rows, error: jobsErr }, { data: runs }, { data: dismissedRows }] = await Promise.all([
      jobsQuery,
      supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(1),
      supabase.from('job_dismissed').select('fingerprint'),
    ])
    if (jobsErr) setError(jobsErr.message)
    // A dismissed role should vanish the moment you dismiss it, even if the
    // DELETE itself was refused — row-level security can turn that into a
    // silent no-op, and the whole point of the button is that the role goes
    // away. The suppression row is written first and is the thing that
    // actually decides visibility here; the delete and the scan's sweep are
    // how the row eventually stops existing.
    else {
      const dismissed = new Set((dismissedRows || []).map(r => r.fingerprint))
      setJobs(dismissed.size ? (rows || []).filter(j => !dismissed.has(j.fingerprint)) : rows || [])
    }
    const run = runs?.[0] || null
    setLastRun(run)
    setLoading(false)
    return run
  }, [showNegotiable])

  useEffect(() => { load() }, [load])

  function toggleNegotiable() {
    setShowNegotiable(v => {
      const next = !v
      localStorage.setItem(NEGOTIABLE_KEY, next ? '1' : '0')
      return next
    })
  }

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
      // GitHub still has to check out the repo and install dependencies
      // before the script writes its 'running' row to job_runs — a single
      // reload a few seconds later can still see the PREVIOUS run and the
      // button flips back to clickable in that gap. Keep polling (and the
      // button disabled) until the new run actually shows up, then the 15s
      // poller above takes over for the rest of the scan.
      let run = null
      for (let i = 0; i < 8 && run?.status !== 'running'; i++) {
        await new Promise(r => setTimeout(r, 5000))
        run = await load()
      }
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
          {lastRun?.status === 'running' || refreshing ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              {lastRun?.status === 'running' ? 'Scanning…' : 'Starting…'}
            </>
          ) : (
            'Refresh now'
          )}
        </button>
      }
    >
      <header className="page-head">
        <h1>Matches</h1>
        <p className="muted">
          {/* refreshing flips true the instant Refresh is clicked, same signal
              the button uses — lastRun.status lags a few seconds behind (it
              only updates once a reload sees the new row), so gating on it
              alone left "✓ Done" from the PREVIOUS scan showing while a new
              one was already underway. */}
          {refreshing && lastRun?.status !== 'running' && 'Starting a new scan…'}
          {lastRun?.status === 'running' && `Scanning — started ${relTime(lastRun.started_at)}.`}
          {!refreshing && !lastRun && 'No scan has run yet. Fill in your Profile, then hit Refresh now.'}
          {!refreshing && lastRun?.status === 'error' && `Last scan failed: ${lastRun.error}`}
          {!refreshing && lastRun?.status === 'ok' && (
            <>
              <span className="done-check">✓ Done</span> — {doneAt(lastRun.finished_at || lastRun.started_at)},{' '}
              {lastRun.scored} roles scored, {lastRun.fetched} postings seen
              {lastRun.links_checked > 0 && `, ${lastRun.links_checked} links checked`}
              {lastRun.links_dead > 0 && ` (${lastRun.links_dead} already closed, dropped)`}.
            </>
          )}
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

      <label className="check negotiable-toggle">
        <input type="checkbox" checked={showNegotiable} onChange={toggleNegotiable} />
        Show roles not confirmed workable from Montreal (unclear-remote or on-site elsewhere)
      </label>

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
