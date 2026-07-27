import { useState } from 'react'
import { supabase } from '../lib/supabase'

const STATUSES = ['interested', 'applied', 'interviewing', 'offer', 'rejected', 'passed']

function money(job) {
  if (!job.salary_min && !job.salary_max) return null
  const fmt = n => (n ? Math.round(n).toLocaleString() : '?')
  const range = `${fmt(job.salary_min)}–${fmt(job.salary_max)} ${job.salary_currency || ''}`.trim()
  // Never show an aggregator's guess as if the employer published it.
  return job.salary_predicted ? `~${range} (est.)` : range
}

// The scorer writes "above: <reasoning>" — pull the verdict off the front for
// colour-coding, tolerating a shape change.
function compLevel(text) {
  const m = String(text || '').match(/^\s*(above|at|below|unclear)\b/i)
  return m ? m[1].toLowerCase() : 'unclear'
}

// Strips Markdown to plain text for pasting into an application portal's
// textarea or saving as .txt. Portals frequently render raw Markdown literally,
// so "**Director**" reaches the reviewer with the asterisks intact.
function toPlainText(md) {
  return String(md || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^\s*\|.*\|\s*$/gm, '') // drop any table rows outright
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// The scorer writes "moderate: <reasoning>" — pull the level off the front so
// it can be colour-coded, and fall back to neutral if the shape varies.
function riskLevel(text) {
  const m = String(text || '').match(/^\s*(none|low|moderate|high)\b/i)
  return m ? m[1].toLowerCase() : 'unknown'
}

// Short label for the location_fit badge — kept in sync with the tiers
// scoring.js's LOCATION FIT prompt section asks the model to classify into.
function locationLabel(fit) {
  switch (fit) {
    case 'remote_montreal': return 'Remote · Montreal OK'
    case 'onsite_close': return 'Close to Côte St-Luc'
    case 'onsite_far': return 'Montreal · farther out'
    case 'remote_unclear': return 'Remote · Canada unclear'
    case 'not_montreal': return 'Not Montreal · no remote'
    default: return null
  }
}

function slug(s) {
  return String(s || 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
}

export default function JobCard({ job, onChanged }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [docs, setDocs] = useState(null)
  // Collapsed by default — the full letter + CV text is long enough that
  // auto-expanding it (whether just generated or loaded from an earlier
  // visit) pushes the rest of the page out of view.
  const [docsOpen, setDocsOpen] = useState(false)
  const [err, setErr] = useState('')

  async function setStatus(status) {
    await supabase.from('job_applications').upsert(
      { posting_id: job.id, status, updated_at: new Date().toISOString() },
      { onConflict: 'posting_id' }
    )
    onChanged?.()
  }

  async function generate() {
    setBusy(true)
    setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('generate-application', {
        body: { posting_id: job.id },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setDocs(data)
      onChanged?.()
    } catch (e) {
      setErr(e.message || 'Generation failed')
    }
    setBusy(false)
  }

  async function loadExisting() {
    const { data } = await supabase
      .from('job_applications')
      .select('cover_letter, tailored_cv')
      .eq('posting_id', job.id)
      .maybeSingle()
    if (data?.cover_letter) setDocs({ cover_letter: data.cover_letter, tailored_cv: data.tailored_cv })
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !docs && job.has_cover_letter) loadExisting()
  }

  const pay = money(job)

  return (
    <article className={`job ${open ? 'open' : ''}`}>
      <button className="job-head" onClick={toggle}>
        <span className={`score tier-${job.tier}`}>{job.score}</span>
        <span className="job-title">
          <strong>{job.title}</strong>
          <span className="job-meta">
            {job.company || 'Unknown company'}
            {job.location ? ` · ${job.location}` : ''}
            {job.remote ? ' · Remote' : ''}
            {pay ? ` · ${pay}` : ''}
          </span>
        </span>
        <span className="job-tags">
          {job.app_status && job.app_status !== 'interested' && (
            <span className="tag status">{job.app_status}</span>
          )}
          {job.location_fit && (
            <span className={`tag loc-${job.location_fit}`}>{locationLabel(job.location_fit)}</span>
          )}
          <span className={`tag tier-${job.tier}`}>{job.tier}</span>
        </span>
      </button>

      {open && (
        <div className="job-body">
          {job.why_fit && (
            <section>
              <h4>Why this fits you</h4>
              <p>{job.why_fit}</p>
            </section>
          )}
          {job.gaps && (
            <section>
              <h4>The honest gaps</h4>
              <p className="muted">{job.gaps}</p>
            </section>
          )}
          {job.overqualification_risk && (
            <section>
              <h4>Screening risk</h4>
              <p className={`risk risk-${riskLevel(job.overqualification_risk)}`}>
                {job.overqualification_risk}
              </p>
            </section>
          )}
          {job.negotiation_note && (
            <section>
              <h4>Not remote — worth asking anyway?</h4>
              <p className="risk risk-moderate">{job.negotiation_note}</p>
            </section>
          )}
          {job.comp_assessment && (
            <section>
              <h4>Total compensation</h4>
              <p className={`risk comp-${compLevel(job.comp_assessment)}`}>
                {job.comp_assessment}
              </p>
            </section>
          )}
          {(job.ats_keywords_covered || job.ats_keywords_missing) && (
            <section>
              <h4>Screening keywords</h4>
              {job.ats_keywords_covered && (
                <div className="kw-row">
                  <span className="kw-label">You can back</span>
                  <span className="kw-terms">
                    {job.ats_keywords_covered.split(';').map(t => (
                      <span className="kw kw-have" key={t}>{t.trim()}</span>
                    ))}
                  </span>
                </div>
              )}
              {job.ats_keywords_missing && (
                <div className="kw-row">
                  <span className="kw-label">Not evidenced</span>
                  <span className="kw-terms">
                    {job.ats_keywords_missing.split(';').map(t => (
                      <span className="kw kw-miss" key={t}>{t.trim()}</span>
                    ))}
                  </span>
                </div>
              )}
              <p className="muted sm">
                Terms you can back are woven into the generated documents in this
                posting&apos;s own wording. Terms you can&apos;t are never inserted — they
                show you where real experience may be described in the wrong words.
              </p>
            </section>
          )}
          {job.pitch_angle && (
            <section>
              <h4>Lead with</h4>
              <p className="pitch">{job.pitch_angle}</p>
            </section>
          )}

          <div className="job-actions">
            {job.url && (
              <a className="btn ghost" href={job.url} target="_blank" rel="noreferrer">
                View posting ↗
              </a>
            )}
            {job.source?.startsWith('adzuna:') && (
              // Adzuna sometimes walls off its own listing page ("Sorry,
              // this job is not available in your region") for a US-located
              // employer, even when that posting was surfaced through
              // Adzuna's CANADIAN search — the block tracks the listing's
              // own location, not which of Adzuna's endpoints returned it in
              // our results. There's no reliable way to predict which
              // specific links will hit it, so every Adzuna-sourced card
              // gets this fallback alongside the direct link rather than
              // only the ones a (wrong) heuristic guessed were at risk.
              <a
                className="btn ghost sm"
                href={`https://www.google.com/search?q=${encodeURIComponent(
                  `${job.company || ''} ${job.title} -site:adzuna.com -site:adzuna.ca`.trim()
                )}`}
                target="_blank"
                rel="noreferrer"
                title="If the link above says 'not available in your region', Adzuna is blocking its own page — this searches for the posting elsewhere instead"
              >
                Search instead ↗
              </a>
            )}
            <button className="btn" onClick={generate} disabled={busy}>
              {busy ? 'Drafting…' : docs ? 'Regenerate' : 'Draft cover letter + CV'}
            </button>
            <select
              value={job.app_status || 'interested'}
              onChange={e => setStatus(e.target.value)}
            >
              {STATUSES.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {err && <div className="err">{err}</div>}

          {docs && (
            <div className="docs">
              <button className="doc-head docs-toggle" onClick={() => setDocsOpen(v => !v)}>
                <h4>Cover letter &amp; CV {docsOpen ? '▾' : '▸'}</h4>
                <span className="muted sm">{docsOpen ? 'Hide' : 'Ready — tap to view'}</span>
              </button>
              {docsOpen && (
                <>
                  <section>
                    <div className="doc-head">
                      <h4>Cover letter</h4>
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          download(`cover-letter-${slug(job.company)}-${slug(job.title)}.txt`, docs.cover_letter)
                        }
                      >
                        Download
                      </button>
                    </div>
                    <pre className="doc">{docs.cover_letter}</pre>
                  </section>
                  {docs.tailored_cv && (
                    <section>
                      <div className="doc-head">
                        <h4>Tailored CV</h4>
                        <span className="row">
                          <button
                            className="btn ghost sm"
                            onClick={() =>
                              download(
                                `cv-${slug(job.company)}-${slug(job.title)}.txt`,
                                toPlainText(docs.tailored_cv)
                              )
                            }
                            title="Plain text, no formatting — safest for application portals and resume parsers"
                          >
                            Download .txt (ATS-safe)
                          </button>
                          <button
                            className="btn ghost sm"
                            onClick={() =>
                              download(`cv-${slug(job.company)}-${slug(job.title)}.md`, docs.tailored_cv)
                            }
                            title="Markdown source, for reformatting into a designed version"
                          >
                            .md
                          </button>
                        </span>
                      </div>
                      <pre className="doc">{docs.tailored_cv}</pre>
                    </section>
                  )}
                  <p className="muted sm">
                    Drafts, not final copy — read them before sending. Every factual claim should be
                    one you can stand behind in an interview. The <code>.txt</code> version is the
                    one to upload to a portal: no tables, columns or graphics, which are the usual
                    reason a real CV parses as near-empty.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}
