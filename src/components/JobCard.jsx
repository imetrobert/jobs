import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { STATUSES, statusLabel, DISMISS_REASONS } from '../lib/statuses'
import { dismissPosting } from '../lib/dismiss'

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

// How long ago the scan last confirmed the posting page still loads. Recency
// is the whole point of the claim, so it is always stated alongside it.
function checkedAgo(iso) {
  if (!iso) return null
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

// `link_note` is written for the scan log — "HTTP 403 — the site refused an
// automated request" is the right level of detail there and the wrong one on a
// card. This turns it into what actually matters: is this worth your time, and
// what should you do about it.
//
// The distinction that earns its keep is between "the check failed" and "this
// source can never be checked". Jooble is the second kind — it refuses every
// request, and its listings routinely outlive the job — so saying so plainly
// is more use than any number of retries.
function linkCaveat(job) {
  const feed = String(job.source || '').split(':')[0]
  const note = job.link_note || ''

  if (/blocked in this region/i.test(note)) {
    return 'Adzuna blocks this page from Canada. That is a regional block, not a closed job — use “Search instead” above to find the posting at its source.'
  }
  if (feed === 'jooble') {
    return 'Jooble refuses automated checks, and its listings often outlive the job itself — this is the source most likely to send you to a dead posting. Open it before you spend time on it.'
  }
  if (/almost no readable content/i.test(note)) {
    return 'This board builds its pages in the browser, so there was nothing for the check to read. The role is probably fine.'
  }
  if (/refused an automated request/i.test(note)) {
    return 'This site refuses automated checks, so the posting could not be confirmed either way.'
  }
  if (/no response in|could not reach/i.test(note)) {
    return 'The posting page did not respond in time, so it could not be confirmed either way.'
  }
  return note
    ? `Could not confirm this is still open — ${note}.`
    : 'Could not confirm this is still open.'
}

// The same verdict as the caveat below, compressed to a pill for the collapsed
// card — so the list can be triaged on "is this posting definitely still up?"
// without opening anything. 'dead' is deliberately absent: those are hidden
// from the list entirely and can never reach a card.
//
// Every row gets one, including the plain "not checked" case. An absent badge
// would read as reassurance, which is the exact ambiguity this is here to end.
function linkBadge(job) {
  switch (job.link_status) {
    case 'live':
      return {
        cls: 'link-live',
        label: '✓ Verified',
        title: `The posting page was open when the scan checked it ${checkedAgo(job.link_checked_at)}.`,
      }
    case 'unknown':
      return { cls: 'link-unknown', label: 'Unverified', title: linkCaveat(job) }
    default:
      return {
        cls: 'link-unchecked',
        label: 'Not checked',
        title: "This link hasn't been checked, so there's no telling whether the role is still open.",
      }
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

  async function dismiss(reason) {
    setBusy(true)
    setErr('')
    try {
      await dismissPosting(job, reason)
      onChanged?.()
    } catch (e) {
      setErr(e.message || 'Could not remove this role')
      setBusy(false)
    }
    // On success the row is gone and this card unmounts on the parent's
    // reload, so `busy` is deliberately left set — flipping it back would
    // briefly re-enable buttons on a posting that no longer exists.
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
  const link = linkBadge(job)

  return (
    <article className={`job ${open ? 'open' : ''}`}>
      <button className="job-head" onClick={toggle}>
        <span className={`score tier-${job.tier}`}>{job.score}</span>
        <span className="job-headline">
          <span className="job-title">
            <strong>{job.title}</strong>
            <span className="job-meta">
              {job.company || 'Unknown company'}
              {job.location ? ` · ${job.location}` : ''}
              {job.remote ? ' · Remote' : ''}
              {pay ? ` · ${pay}` : ''}
              {job.application_deadline ? ` · Apply by ${job.application_deadline}` : ''}
            </span>
          </span>
          <span className="job-tags">
            {/* First in the row on purpose: "is this posting actually still
                up?" is the question worth answering before any of the others,
                since a dead link makes the rest of the card moot. */}
            <span className={`tag ${link.cls}`} title={link.title}>{link.label}</span>
            {job.app_status && job.app_status !== 'interested' && (
              <span className="tag status">{statusLabel(job.app_status)}</span>
            )}
            {job.location_fit && (
              <span className={`tag loc-${job.location_fit}`}>{locationLabel(job.location_fit)}</span>
            )}
            <span className={`tag tier-${job.tier}`}>{job.tier}</span>
          </span>
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
          {job.location_fit === 'remote_montreal' && job.location_evidence && (
            <section>
              <h4>Where the posting says Montreal/Canada is eligible</h4>
              <p className="pitch">&ldquo;{job.location_evidence}&rdquo;</p>
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
                <option key={s} value={s}>{statusLabel(s)}</option>
              ))}
            </select>
          </div>

          {/* The two ways a role stops being worth looking at, one click each
              and sitting right under the link — because that is where you
              find out. These DELETE the posting rather than filing it under a
              status: a status still has to be shown somewhere, and the point
              is that it stops existing. Said plainly above the buttons, since
              there is no undo in the app. */}
          <div className="job-dismiss">
            <span className="muted sm">Delete this role for good:</span>
            <span className="row">
              {Object.entries(DISMISS_REASONS).map(([reason, label]) => (
                <button
                  key={reason}
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => dismiss(reason)}
                  title="Deletes the posting and stops future scans re-importing it. Permanent."
                >
                  {label}
                </button>
              ))}
            </span>
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
