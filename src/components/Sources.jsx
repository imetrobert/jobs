import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Layout from './Layout'

const ATS_KINDS = [
  { v: 'greenhouse', l: 'Greenhouse', hint: 'boards.greenhouse.io/<slug>' },
  { v: 'lever', l: 'Lever', hint: 'jobs.lever.co/<slug>' },
  { v: 'ashby', l: 'Ashby', hint: 'jobs.ashbyhq.com/<slug>' },
  { v: 'smartrecruiters', l: 'SmartRecruiters', hint: 'jobs.smartrecruiters.com/<slug>' },
  { v: 'workable', l: 'Workable', hint: 'apply.workable.com/<slug>' },
]

export default function Sources() {
  const [rows, setRows] = useState([])
  const [kind, setKind] = useState('greenhouse')
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase.from('job_sources').select('*').order('kind')
    setRows(data || [])
  }, [])

  useEffect(() => { load() }, [load])

  async function add(e) {
    e.preventDefault()
    setMsg('')
    const slug = token.trim().replace(/^.*\/([^/?#]+).*$/, '$1')
    const { error } = await supabase
      .from('job_sources')
      .insert({ kind, label: label.trim() || slug, token: slug })
    if (error) setMsg(error.message)
    else {
      setLabel('')
      setToken('')
      load()
    }
  }

  async function toggle(row) {
    await supabase.from('job_sources').update({ enabled: !row.enabled }).eq('id', row.id)
    load()
  }

  async function remove(row) {
    await supabase.from('job_sources').delete().eq('id', row.id)
    load()
  }

  const hint = ATS_KINDS.find(k => k.v === kind)?.hint

  return (
    <Layout>
      <header className="page-head">
        <h1>Sources</h1>
        <p className="muted">
          Aggregators cover the market broadly. Company boards are the sharper tool — add the
          employers you'd actually leave for and you'll see their roles the day they post,
          before the aggregators pick them up.
        </p>
      </header>

      {msg && <div className="err">{msg}</div>}

      <div className="card">
        <h3>Add a company board</h3>
        <form className="row wrap" onSubmit={add}>
          <select value={kind} onChange={e => setKind(e.target.value)}>
            {ATS_KINDS.map(k => (
              <option key={k.v} value={k.v}>{k.l}</option>
            ))}
          </select>
          <input
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={hint}
            required
          />
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Company name (optional)"
          />
          <button className="btn" type="submit">Add</button>
        </form>
        <p className="muted sm">
          Paste either the slug or the full board URL — the slug is extracted for you.
        </p>
      </div>

      <div className="card">
        <h3>Active sources</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Source</th>
              <th>Kind</th>
              <th>Last OK</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={r.enabled ? '' : 'off'}>
                <td>
                  {r.label}
                  {r.last_error && <div className="err sm">{r.last_error}</div>}
                </td>
                <td><code>{r.kind}</code></td>
                <td className="muted">
                  {r.last_ok_at ? new Date(r.last_ok_at).toLocaleDateString() : '—'}
                </td>
                <td>
                  <button className="btn ghost sm" onClick={() => toggle(r)}>
                    {r.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </td>
                <td>
                  <button className="btn ghost sm danger" onClick={() => remove(r)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  )
}
