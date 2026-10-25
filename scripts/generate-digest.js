// Weekly digest: new roles above the display bar, as a plain file.
//
// Runs AFTER the scan in the same workflow job, reading the same Supabase
// project with the same credentials the scan step already uses
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). No new secrets, no new
// service, no email setup.
//
// DELIBERATELY NOT AN LLM TASK: the digest is deterministic formatting of
// rows the scan already scored — title, company, score, location, link,
// plus the scorer's own why_fit line. Zero additional model calls, so it
// cannot add a cent (or a quota unit) to the free-tier budget. If this
// script ever needs judgement it does not have, that is a reason to stop
// and ask, not to quietly call a model.
//
// "New" means scored in the last 7 days (the weekly cadence) at or above
// the same score bar the Jobs page uses to show a role at all — 35, see
// Jobs.jsx and LINK_CHECK_MIN_SCORE in run-job-scan.js. Reusing that bar
// rather than inventing a second one means the digest never promises a
// role the app itself would hide. Stale (hidden) roles are excluded, and
// dismissed roles never reach this query: dismissing deletes the posting
// row, which cascades to its match.
//
// Output: docs/weekly-digest.md in the repo, committed by the workflow.
// The file is the whole point — it is readable without the app, and it is
// what gets forwarded to Robert each week.
//
// Failure mode: any error here exits non-zero, but the workflow step runs
// with continue-on-error, so a digest failure can never fail a scan whose
// fetching and scoring already succeeded. A stale digest file is better
// than a failed run; the next weekly run overwrites it.

import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// The Jobs page's display bar. One number, one place it is defined for the
// digest — but it MUST match Jobs.jsx's .gte('score', 35). If that changes,
// change this too; a digest with a different bar than the app is a digest
// that disagrees with the list it summarizes.
const SCORE_BAR = Number(process.env.DIGEST_MIN_SCORE || 35)
const WINDOW_DAYS = Number(process.env.DIGEST_WINDOW_DAYS || 7)
const OUT_PATH = process.env.DIGEST_OUT_PATH || 'docs/weekly-digest.md'

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function oneLine(s, max = 240) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

async function main() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()
  const { data: matches, error: matchErr } = await db
    .from('job_matches')
    .select('posting_id, score, tier, why_fit, scored_at')
    .gte('score', SCORE_BAR)
    .gte('scored_at', since)
    .order('score', { ascending: false })
  if (matchErr) throw new Error(`Could not list recent matches: ${matchErr.message}`)

  let rows = []
  if (matches && matches.length) {
    const ids = matches.map(m => m.posting_id)
    const { data: postings, error: postErr } = await db
      .from('job_postings')
      .select('id, title, company, location, remote, url, stale')
      .in('id', ids)
    if (postErr) throw new Error(`Could not list postings: ${postErr.message}`)
    const byId = new Map((postings || []).map(p => [p.id, p]))
    rows = matches
      .map(m => ({ ...m, posting: byId.get(m.posting_id) }))
      // Dismissed roles are gone from job_postings (delete cascades), and
      // stale roles are hidden in the app — neither belongs in a digest.
      .filter(r => r.posting && !r.posting.stale)
  }

  const today = new Date().toISOString().slice(0, 10)
  const lines = []
  lines.push('# Weekly job digest')
  lines.push('')
  lines.push(`Week of ${today} — roles scored in the last ${WINDOW_DAYS} days at ${SCORE_BAR}+ (the same bar the Jobs page shows).`)
  lines.push('')
  if (!rows.length) {
    lines.push(`No new roles above the bar this week.`)
    lines.push('')
  } else {
    lines.push(`${rows.length} new role${rows.length === 1 ? '' : 's'} above the bar, best first:`)
    lines.push('')
    for (const r of rows) {
      const p = r.posting
      const where = [p.location, p.remote ? 'Remote' : null].filter(Boolean).join(' · ')
      lines.push(`## ${p.title} — ${p.company || 'Unknown company'} (${r.score}, ${r.tier})`)
      if (where) lines.push(`Location: ${where}`)
      lines.push(`Link: ${p.url || '(no link on file)'}`)
      if (r.why_fit) lines.push(`Why it fits: ${oneLine(r.why_fit)}`)
      lines.push('')
    }
  }
  lines.push('---')
  lines.push('Generated from the weekly scan. Scores and fit notes are the scan\'s own; nothing here was re-judged.')
  lines.push('')

  writeFileSync(OUT_PATH, lines.join('\n'))
  console.log(`Digest: ${rows.length} role(s) → ${OUT_PATH}`)
}

main().catch(err => {
  console.error(`Digest failed: ${err.message}`)
  process.exit(1)
})
