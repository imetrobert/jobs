import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Layout from './Layout'
import JobCard from './JobCard'
import { PIPELINE_COLUMNS, statusLabel, CLOSED_STATUSES } from '../lib/statuses'
import { parseFollowUp, isFollowUpDue } from '../lib/followUp'

export default function Applications() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data }, { data: dismissedRows }, { data: appRows }] = await Promise.all([
      supabase
        .from('job_ranked')
        .select('*')
        .not('app_status', 'is', null)
        .order('score', { ascending: false }),
      supabase.from('job_dismissed').select('fingerprint'),
      // Follow-up dates live in job_applications.notes (see
      // src/lib/followUp.js) — the job_ranked view does not expose them,
      // so they are merged here rather than via a view change.
      supabase.from('job_applications').select('posting_id, notes'),
    ])
    // Same filter as Matches: dismissed means gone from everywhere, including
    // here, whether or not the underlying delete was permitted.
    const dismissed = new Set((dismissedRows || []).map(r => r.fingerprint))
    const followUps = new Map(
      (appRows || []).map(a => [a.posting_id, parseFollowUp(a.notes)])
    )
    const kept = (data || []).filter(r => !dismissed.has(r.fingerprint))
    for (const r of kept) {
      const fu = followUps.get(r.id)
      if (fu && fu.date) {
        r.follow_up_date = fu.date
        r.follow_up_note = fu.note
      }
    }
    setRows(kept)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Due or overdue follow-ups sort first, ahead of the status groups, and
  // look different — the point of a follow-up is that it needs acting on,
  // not that it sits inside its status column. Closed roles (rejected, or
  // legacy passed) never appear here: there is nothing to follow up.
  const due = rows
    .filter(r => r.follow_up_date && isFollowUpDue(r.follow_up_date) && !CLOSED_STATUSES.includes(r.app_status))
    .sort((a, b) => (a.follow_up_date < b.follow_up_date ? -1 : a.follow_up_date > b.follow_up_date ? 1 : 0))

  return (
    <Layout>
      <header className="page-head">
        <h1>Pipeline</h1>
        <p className="muted">Every role you've marked. Statuses are set on each card.</p>
      </header>

      {loading && <div className="muted">Loading…</div>}
      {!loading && rows.length === 0 && (
        <div className="empty">
          <p>Nothing tracked yet.</p>
          <p className="muted">Set a status on any match to see it here.</p>
        </div>
      )}

      {!loading && due.length > 0 && (
        <section className="pipeline-group followup-due">
          <h2 className="group-head">
            Follow-ups due <span className="pill">{due.length}</span>
          </h2>
          <p className="muted sm">
            Follow-up date reached or passed. Set or clear the date on the card.
            These roles are shown here instead of in their status group below,
            so the same card never appears twice.
          </p>
          <div className="job-list">
            {due.map(job => (
              <JobCard key={job.id} job={job} onChanged={load} />
            ))}
          </div>
        </section>
      )}

      {PIPELINE_COLUMNS.map(col => {
        const group = rows.filter(r => r.app_status === col && !due.includes(r))
        if (!group.length) return null
        return (
          <section key={col} className="pipeline-group">
            <h2 className="group-head">
              {statusLabel(col)} <span className="pill">{group.length}</span>
            </h2>
            <div className="job-list">
              {group.map(job => (
                <JobCard key={job.id} job={job} onChanged={load} />
              ))}
            </div>
          </section>
        )
      })}
    </Layout>
  )
}
