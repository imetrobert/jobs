import { Fragment, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Layout from './Layout'

// Company boards: `token` is the board slug, and every one of these is a
// different company, so you add as many as you like.
const ATS_KINDS = [
  { v: 'greenhouse', l: 'Greenhouse', hint: 'boards.greenhouse.io/<slug>' },
  { v: 'lever', l: 'Lever', hint: 'jobs.lever.co/<slug>' },
  { v: 'ashby', l: 'Ashby', hint: 'jobs.ashbyhq.com/<slug>' },
  { v: 'smartrecruiters', l: 'SmartRecruiters', hint: 'jobs.smartrecruiters.com/<slug>' },
  { v: 'workable', l: 'Workable', hint: 'apply.workable.com/<slug>' },
]

// Market-wide feeds. These were seeded once at install and had no way back
// into the app if you removed one — the add form only offered company boards,
// so re-adding Jooble meant hand-writing SQL. They belong here too.
//
// Adzuna is per country, so it takes a token and you can have both. The rest
// are a single global feed each: one row, no token.
const AGGREGATOR_KINDS = [
  { v: 'adzuna', l: 'Adzuna', country: true, hint: 'ca or us' },
  { v: 'jooble', l: 'Jooble' },
  { v: 'remotive', l: 'Remotive' },
  { v: 'jsearch', l: 'JSearch (RapidAPI)' },
]

const KIND_LABEL = Object.fromEntries(
  [...ATS_KINDS, ...AGGREGATOR_KINDS].map(k => [k.v, k.l])
)

export default function Sources() {
  const [rows, setRows] = useState([])
  const [kind, setKind] = useState('greenhouse')
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState('')
  // Which row is asking "are you sure?". Removing a source is one click and
  // irreversible from the app, and it sits next to a toggle that looks almost
  // identical — so it asks first, and offers the reversible option by name.
  const [confirmId, setConfirmId] = useState(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('job_sources').select('*').order('kind')
    setRows(data || [])
  }, [])

  useEffect(() => { load() }, [load])

  const spec = [...ATS_KINDS, ...AGGREGATOR_KINDS].find(k => k.v === kind)
  const isAggregator = AGGREGATOR_KINDS.some(k => k.v === kind)
  // Only Adzuna is per-country; the other aggregators are one global feed.
  const needsToken = !isAggregator || Boolean(spec?.country)

  async function add(e) {
    e.preventDefault()
    setMsg('')
    // Accept a full board URL and pull the slug out of it.
    const slug = needsToken ? token.trim().replace(/^.*\/([^/?#]+).*$/, '$1') : null

    // (kind, token) is unique in the database, but Postgres treats two NULLs
    // as distinct — so nothing stops a second tokenless Jooble row. Catch it
    // here, where a duplicate feed just means scanning everything twice.
    if (rows.some(r => r.kind === kind && (r.token || null) === slug)) {
      setMsg(`That source is already in the list${slug ? ` (${kind}: ${slug})` : ''}.`)
      return
    }

    const { error } = await supabase
      .from('job_sources')
      .insert({ kind, label: label.trim() || KIND_LABEL[kind] || slug, token: slug })
    if (error) setMsg(error.message)
    else {
      setLabel('')
      setToken('')
      load()
    }
  }

  async function toggle(row) {
    await supabase.from('job_sources').update({ enabled: !row.enabled }).eq('id', row.id)
    setConfirmId(null)
    load()
  }

  async function remove(row) {
    await supabase.from('job_sources').delete().eq('id', row.id)
    setConfirmId(null)
    load()
  }

  return (
    <Layout>
      <header className="page-head">
        <h1>Sources</h1>
        <p className="muted">
          Aggregators cover the market broadly. Company boards are the sharper tool — add the
          employers you'd actually leave for and you'll see their roles the day they post,
          before the aggregators pick them up. They're also the only sources whose postings
          can be confirmed still open without fetching a single page.
        </p>
      </header>

      {msg && <div className="err">{msg}</div>}

      <div className="card">
        <h3>Add a source</h3>
        <form className="row wrap" onSubmit={add}>
          <select value={kind} onChange={e => { setKind(e.target.value); setMsg('') }}>
            <optgroup label="Company board">
              {ATS_KINDS.map(k => (
                <option key={k.v} value={k.v}>{k.l}</option>
              ))}
            </optgroup>
            <optgroup label="Market-wide feed">
              {AGGREGATOR_KINDS.map(k => (
                <option key={k.v} value={k.v}>{k.l}</option>
              ))}
            </optgroup>
          </select>
          {needsToken && (
            <input
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder={spec?.hint}
              required
            />
          )}
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={isAggregator ? 'Label (optional)' : 'Company name (optional)'}
          />
          <button className="btn" type="submit">Add</button>
        </form>
        <p className="muted sm">
          {isAggregator
            ? spec?.country
              ? 'One row per country — Adzuna runs a separate index for each.'
              : 'A single global feed; no slug needed. Its API key comes from the repo secrets.'
            : 'Paste either the slug or the full board URL — the slug is extracted for you.'}
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
              <Fragment key={r.id}>
                <tr className={r.enabled ? '' : 'off'}>
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
                    <button
                      className="btn ghost sm danger"
                      onClick={() => setConfirmId(confirmId === r.id ? null : r.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
                {confirmId === r.id && (
                  <tr className="confirm-row">
                    <td colSpan={5}>
                      <div className="confirm-box">
                        <p>
                          <strong>Remove {r.label} permanently?</strong> It disappears from this
                          list and can only be added back by hand.
                        </p>
                        <p className="muted sm">
                          <strong>Disable</strong> is almost always what you want: the source stays
                          here, and simply sits out the next run until you switch it back on.
                          Either way the postings it already found are kept — but with nothing
                          re-listing them, any that came from this source alone age out after
                          seven days.
                        </p>
                        <div className="row wrap">
                          <button className="btn" onClick={() => toggle(r)}>
                            {r.enabled ? 'Disable instead' : 'Keep it disabled'}
                          </button>
                          <button className="btn ghost sm danger" onClick={() => remove(r)}>
                            Remove permanently
                          </button>
                          <button className="btn ghost sm" onClick={() => setConfirmId(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  )
}
