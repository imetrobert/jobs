import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Layout from './Layout'
import JobCard from './JobCard'
import { PIPELINE_COLUMNS, statusLabel } from '../lib/statuses'

export default function Applications() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('job_ranked')
      .select('*')
      .not('app_status', 'is', null)
      .order('score', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

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

      {PIPELINE_COLUMNS.map(col => {
        const group = rows.filter(r => r.app_status === col)
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
