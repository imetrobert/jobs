import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import Layout from './Layout'

const SENIORITY = [
  { v: 'any', l: 'Any level' },
  { v: 'senior', l: 'Senior and up' },
  { v: 'manager', l: 'Manager and up' },
  { v: 'director', l: 'Director and up' },
  { v: 'vp', l: 'VP and up' },
  { v: 'c_level', l: 'C-level only' },
]

// Array columns are edited as comma-separated text.
//
// The raw text is held in its own state and only converted to an array on
// save. Parsing on every keystroke looks equivalent but isn't: trimming each
// item strips the space the moment you type it, the field re-renders without
// it, and "VP Digital" comes out as "VPDigital". A controlled input must never
// round-trip through a lossy transform while the user is still typing.
const LIST_FIELDS = [
  'target_titles',
  'target_industries',
  'locations',
  'must_haves',
  'deal_breakers',
]

function toList(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
}

export default function Profile() {
  const [p, setP] = useState(null)
  const [lists, setLists] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    supabase
      .from('job_profile')
      .select('*')
      .eq('id', 1)
      .single()
      .then(({ data }) => {
        if (!data) return
        setP(data)
        setLists(
          Object.fromEntries(LIST_FIELDS.map(k => [k, (data[k] || []).join(', ')]))
        )
      })
  }, [])

  if (!p) {
    return (
      <Layout>
        <div className="muted">Loading…</div>
      </Layout>
    )
  }

  const set = (k, v) => setP(prev => ({ ...prev, [k]: v }))
  const setList = (k, v) => setLists(prev => ({ ...prev, [k]: v }))

  async function save() {
    setSaving(true)
    setMsg('')
    // Convert the list fields here rather than on keystroke. Doing it at save
    // time also means it doesn't depend on the input losing focus first —
    // tapping Save straight from the keyboard still captures what's typed.
    const payload = {
      ...p,
      ...Object.fromEntries(LIST_FIELDS.map(k => [k, toList(lists[k])])),
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('job_profile').update(payload).eq('id', 1)
    if (!error) setP(payload)
    setMsg(error ? error.message : 'Saved. The next scan will use this.')
    setSaving(false)
  }

  return (
    <Layout
      actions={
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      }
    >
      <header className="page-head">
        <h1>Profile</h1>
        <p className="muted">
          Everything here is fed to the scorer verbatim. The resume field matters most — the
          more specific it is, the more honest the scores and the better the cover letters.
        </p>
      </header>

      {msg && <div className="notice">{msg}</div>}

      <div className="card">
        <label>
          Headline
          <input
            value={p.headline || ''}
            onChange={e => set('headline', e.target.value)}
            placeholder="AI Innovation Leader & Digital Transformation Executive"
          />
        </label>

        <div className="grid-2">
          <label>
            Years of experience
            <input
              type="number"
              value={p.years_experience || ''}
              onChange={e => set('years_experience', e.target.value ? Number(e.target.value) : null)}
            />
          </label>
          <label>
            Based in
            <input
              value={p.location || ''}
              onChange={e => set('location', e.target.value)}
              placeholder="Montreal, QC, Canada"
            />
          </label>
        </div>

        <label>
          Summary
          <textarea
            rows={4}
            value={p.summary || ''}
            onChange={e => set('summary', e.target.value)}
            placeholder="A short positioning statement — who you are and what you're known for."
          />
        </label>
      </div>

      <div className="card">
        <h3>What counts as a good job</h3>

        <label>
          Target titles <span className="muted">— comma separated; these become the search queries</span>
          <input
            value={lists.target_titles ?? ''}
            onChange={e => setList('target_titles', e.target.value)}
            placeholder="VP Digital, Head of AI, Director of Digital Product"
          />
        </label>

        <label>
          Target industries <span className="muted">— comma separated</span>
          <input
            value={lists.target_industries ?? ''}
            onChange={e => setList('target_industries', e.target.value)}
            placeholder="Telecom, Media, SaaS, Financial services"
          />
        </label>

        <label>
          Locations <span className="muted">— comma separated</span>
          <input
            value={lists.locations ?? ''}
            onChange={e => setList('locations', e.target.value)}
            placeholder="Montreal, Canada remote, North America remote"
          />
        </label>

        <label>
          Minimum seniority
          <select
            value={p.min_seniority || 'director'}
            onChange={e => set('min_seniority', e.target.value)}
          >
            {SENIORITY.map(s => (
              <option key={s.v} value={s.v}>{s.l}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <h3>Compensation</h3>
        <p className="muted">
          The bar is <strong>total</strong> compensation, not base. A role advertising a
          lower base still clears the floor once bonus, pension, benefits and equity are
          counted — so base is never used to reject a posting. Most postings disclose no
          pay at all; those come back as “unclear”, which is normal and doesn’t count
          against the match.
        </p>

        <div className="grid-2">
          <label>
            Total compensation floor
            <input
              type="number"
              value={p.min_total_comp ?? ''}
              onChange={e =>
                set('min_total_comp', e.target.value ? Number(e.target.value) : null)
              }
              placeholder="128000"
            />
          </label>
          <label>
            Currency
            <select
              value={p.salary_currency || 'CAD'}
              onChange={e => set('salary_currency', e.target.value)}
            >
              <option value="CAD">CAD</option>
              <option value="USD">USD</option>
            </select>
          </label>
        </div>

        <label>
          What counts toward that total
          <textarea
            rows={3}
            value={p.comp_components || ''}
            onChange={e => set('comp_components', e.target.value)}
            placeholder="Base + annual bonus (target ~15%) + employer pension match + health/dental benefits + any equity or options. Bell pension counts at roughly X/yr."
          />
          <span className="muted sm">
            The more specific this is, the better the estimate on roles that publish only
            a base range.
          </span>
        </label>

        <label>
          Hard floor on base alone <span className="muted">— optional, usually blank</span>
          <input
            type="number"
            value={p.min_base_salary ?? ''}
            onChange={e =>
              set('min_base_salary', e.target.value ? Number(e.target.value) : null)
            }
            placeholder="leave empty unless a low base is a non-starter regardless of package"
          />
        </label>
      </div>

      <div className="card">
        <h3>Requirements</h3>

        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(p.remote_ok)}
            onChange={e => set('remote_ok', e.target.checked)}
          />
          Open to fully remote roles
        </label>

        <label>
          Must haves <span className="muted">— comma separated</span>
          <input
            value={lists.must_haves ?? ''}
            onChange={e => setList('must_haves', e.target.value)}
            placeholder="Executive scope, AI mandate, real budget ownership"
          />
        </label>

        <label>
          Deal breakers <span className="muted">— comma separated; any match is filtered out before scoring</span>
          <input
            value={lists.deal_breakers ?? ''}
            onChange={e => setList('deal_breakers', e.target.value)}
            placeholder="commission only, unpaid, relocation required"
          />
        </label>
      </div>

      <div className="card">
        <h3>Experience</h3>
        <p className="muted">
          The single biggest driver of match quality. <strong>Use whichever source is
          most current — LinkedIn is fine, and is better than a stale CV.</strong> The
          scorer reads plain text and doesn&apos;t care about formatting; it cares about
          evidence.
        </p>
        <p className="muted sm">
          Fastest way to get a good version in: on LinkedIn, open your profile →
          <em> More</em> → <em>Save to PDF</em>, then paste the text here. Or copy your
          About section and each role&apos;s description. Then add whatever LinkedIn
          leaves out — team sizes, budgets, P&amp;L scope, and outcomes with real
          numbers. Those are what separate a confident match from a vague one.
        </p>
        <textarea
          rows={18}
          className="mono"
          value={p.resume_text || ''}
          onChange={e => set('resume_text', e.target.value)}
          placeholder="Paste your LinkedIn About + Experience sections, or your CV — whichever is more current.&#10;&#10;Bell — AI Evangelist & Digital Sales Leader (2024–present)&#10;  · Scope: …&#10;  · Team size / budget: …&#10;  · Outcome: … (with numbers)&#10;&#10;Bell — Digital Adoption Catalyst (2020–2024)&#10;  · …"
        />
        <p className="muted sm">
          Anything you leave out simply isn&apos;t considered — the scorer and the letter
          writer are both forbidden from inventing experience, so thin input produces
          thin, hedged output rather than confident claims.
        </p>
      </div>

      <div className="save-bar">
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </Layout>
  )
}
