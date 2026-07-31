// Monthly (or on-demand) job scan.
//
// Fetch → normalize → dedupe → prefilter → score → persist.
//
// Sized to run inside Gemini's free tier: postings are prefiltered before any
// LLM call, then scored in batches through a rate-limited queue.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required)
//      GEMINI_API_KEY                          (required — the scorer)
//      ANTHROPIC_API_KEY                       (optional upgrade; not needed)
//      ADZUNA_APP_ID, ADZUNA_APP_KEY           (optional, per source)
//      JOOBLE_API_KEY, JSEARCH_RAPIDAPI_KEY    (optional, per source)
//      SCAN_TRIGGER                            (optional: 'schedule' | 'manual')
//      MAX_SCORES_PER_RUN, SCORE_BATCH_SIZE, GEMINI_RPM (optional tuning)

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { ADAPTERS } from './sources.js'
import { prefilterReason, scoreJobBatch, BATCH_SIZE } from './scoring.js'
import { activeProvider, QuotaExhaustedError, GEMINI_RPM } from './llm.js'
import { verifyLinks } from './verify-links.js'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!activeProvider()) {
  console.error('Missing GEMINI_API_KEY (or the optional ANTHROPIC_API_KEY) — nothing could be scored')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Cap per run so a bad month can't drain the LLM budget or the Adzuna quota.
const MAX_SCORES_PER_RUN = Number(process.env.MAX_SCORES_PER_RUN || 120)
// Postings not seen in any feed for this long are marked stale (greyed out in
// the UI) rather than deleted — you may have already applied against them.
// None of the source APIs expose a "still accepting applications" flag, so
// this absence-from-every-feed signal is the only general-purpose one
// available. 7 days is a deliberate middle ground: long enough to absorb a
// feed having an off run or a pagination gap without a still-open posting
// flickering out, short enough that "not shown" tracks "probably gone"
// within about a week rather than lingering.
//
// It is also, on its own, far too weak. Aggregators keep returning roles the
// employer closed weeks ago, so those rows are re-seen every single scan and
// never age out — which is why the link-verification pass below exists.
const STALE_AFTER_DAYS = 7

// ---- link verification tuning ----
// Cap on how many posting URLs one run will fetch. These are ordinary page
// loads, not API calls against a quota, but they are the slowest part of a
// scan, so the budget goes to the postings you are actually likely to click.
const MAX_LINK_CHECKS_PER_RUN = Number(process.env.MAX_LINK_CHECKS_PER_RUN || 150)
// Don't spend the budget re-checking a posting that was verified recently and
// whose URL hasn't changed since. Slightly under a day so a daily scan
// re-checks everything it shows.
const LINK_RECHECK_HOURS = Number(process.env.LINK_RECHECK_HOURS || 20)
// Only verify what clears the same score bar the Jobs page uses. A posting
// nobody will ever see is not worth a request.
const LINK_CHECK_MIN_SCORE = Number(process.env.LINK_CHECK_MIN_SCORE || 35)
const LINK_CHECK_CONCURRENCY = Number(process.env.LINK_CHECK_CONCURRENCY || 6)

// How far a URL from a given feed can be trusted to still resolve to the real
// posting. The company's own ATS page IS the posting; an aggregator's copy is
// a record of one, and keeps resolving to a dead end (or silently bouncing to
// a search page) for weeks after the role closed. When the same job arrives
// from several feeds, link to the most authoritative copy — the single
// cheapest reduction in "no longer available" clicks available here, since it
// costs nothing and applies to every syndicated row.
const URL_RANK = {
  greenhouse: 5,
  lever: 5,
  ashby: 5,
  smartrecruiters: 5,
  workable: 5,
  // Curated, small, and prunes closed roles reasonably promptly.
  remotive: 3,
  // Big aggregators: links usually resolve, but to their own listing page,
  // which outlives the posting behind it.
  adzuna: 2,
  jsearch: 2,
  // Worst offender in practice — this is the one in the bug report.
  jooble: 1,
}

function urlRank(source) {
  return URL_RANK[String(source || '').split(':')[0]] ?? 0
}

// Feeds whose adapter returns the COMPLETE current job board in a single call,
// rather than a page of search results. For these, absence is authoritative:
// a posting the board no longer lists has been taken down, and we know it the
// same day instead of waiting out the 7-day "stopped appearing" window.
//
// This is the only signal here that needs no extra request and cannot be
// refused: several of these boards (Ashby especially) build their public pages
// in the browser, so fetching the posting URL returns markup with nothing to
// read — the JSON board we already pulled is both cheaper and more reliable.
//
// The aggregators are deliberately absent from this list. Adzuna, Jooble and
// JSearch return a SEARCH over a far larger index, so a posting can fall out
// of the results on ranking or pagination alone while remaining wide open.
// Absence there means nothing at all.
const COMPLETE_BOARD_KINDS = new Set([
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
])

// What fetchSmartRecruiters asks for. A full page back means there may be more
// postings we never saw — and the ones we never saw would look "missing",
// which is precisely the false positive this whole feature exists to remove.
const SMARTRECRUITERS_PAGE_LIMIT = 100

// Record every posting id a complete board is currently advertising, so the
// ones it has stopped advertising can be closed below.
function indexCompleteBoard(index, src, rows) {
  if (!COMPLETE_BOARD_KINDS.has(src.kind)) return
  // An empty board is ambiguous: the company may genuinely have nothing open,
  // or the vendor may have changed a response shape and we are reading zero
  // jobs out of a perfectly good payload. Closing every posting on the board
  // on the strength of that guess is far too destructive, so an empty result
  // is left to the ordinary 7-day absence rule instead.
  if (!rows.length) return
  if (src.kind === 'smartrecruiters' && rows.length >= SMARTRECRUITERS_PAGE_LIMIT) {
    console.log(`    (${rows.length} postings — board may be truncated, skipping the closed check)`)
    return
  }
  for (const r of rows) {
    if (!index.has(r.source)) index.set(r.source, new Set())
    index.get(r.source).add(String(r.source_id))
  }
}

// ---------- helpers ----------

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Collapses the same role syndicated across Adzuna, Jooble and the company's
// own ATS into one row. City is deliberately excluded — the same posting is
// often listed as "Montreal", "Montreal, QC" and "Quebec, Canada".
function fingerprint(job) {
  const title = normalize(job.title)
    // Strip req numbers and bracketed noise that differ per syndicator.
    .replace(/\b(job|req|requisition)?\s*#?\d{3,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const company = normalize(job.company)
  return crypto.createHash('sha1').update(`${company}|${title}`).digest('hex')
}

function toISO(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// Search queries are derived from the profile's target titles so the feeds
// return what you actually want, rather than a hardcoded list going stale.
function buildQueries(profile) {
  const titles = (profile.target_titles || []).filter(Boolean)
  if (titles.length) return titles.slice(0, 8)
  return ['director digital', 'head of digital', 'vp digital']
}

function buildLocations(profile) {
  return (profile.locations || []).filter(Boolean).slice(0, 4)
}

// ---------- closed-posting detection ----------

/**
 * Close every posting a complete ATS board has stopped listing.
 *
 * The strongest signal available, and the cheapest: these adapters already
 * pulled the board's entire current contents, so a posting missing from that
 * pull has been taken down. No HTTP request, no HTML parsing, nothing for a
 * site to refuse — which matters because the ATS boards are exactly the ones
 * whose public pages render in the browser and read as empty to a fetcher.
 *
 * Only boards that fetched successfully and returned a plausibly complete list
 * are in `boardIndex` (see indexCompleteBoard), so reaching this point already
 * means absence is meaningful. Never throws.
 */
async function closeMissingFromBoards(db, boardIndex, stats) {
  if (!boardIndex.size) return
  const { data: postings, error } = await db
    .from('job_postings')
    .select('id, title, company, url, source_ids')
    .eq('stale', false)
  if (error) {
    console.warn(`Closed-posting check skipped — could not list postings: ${error.message}`)
    return
  }

  const closed = []
  for (const p of postings) {
    for (const [board, stillListed] of boardIndex) {
      const id = p.source_ids?.[board]
      // This posting never came from that board — it says nothing either way.
      if (id == null) continue
      if (stillListed.has(String(id))) continue
      // The ATS is the employer's own system and outranks any aggregator that
      // is still syndicating this role: if the board dropped it, it is closed.
      closed.push({ posting: p, board })
      break
    }
  }

  if (!closed.length) {
    console.log(`Closed-posting check: every posting on ${boardIndex.size} board(s) is still listed.`)
    return
  }

  const checkedAt = new Date().toISOString()
  let written = 0
  for (let i = 0; i < closed.length; i += 20) {
    const chunk = closed.slice(i, i + 20)
    const settled = await Promise.all(
      chunk.map(({ posting, board }) =>
        db
          .from('job_postings')
          .update({
            stale: true,
            link_status: 'dead',
            link_note: `no longer listed on the ${board} job board`,
            link_checked_at: checkedAt,
            // Records what the verdict applies to, same as a fetched check, so
            // the "dead survives the next upsert" rule holds for these too.
            link_checked_url: posting.url,
          })
          .eq('id', posting.id)
      )
    )
    for (const { error: upErr } of settled) {
      if (upErr) console.warn(`  could not close a delisted posting: ${upErr.message}`)
      else written++
    }
  }

  for (const { posting, board } of closed.slice(0, 20)) {
    console.log(`  closed  ${posting.title} @ ${posting.company || '?'} — gone from ${board}`)
  }
  if (closed.length > 20) console.log(`  … and ${closed.length - 20} more`)
  stats.links_dead += written
  console.log(`Closed-posting check: ${written} postings delisted by their own ATS board.`)
}

// ---------- link verification ----------

/**
 * Fetch the URL of every posting that would actually be shown, and hide the
 * ones whose page says the role is closed.
 *
 * Only a confirmed 'dead' hides anything. A page that refused the request, a
 * timeout, a region block — all 'unknown', all left visible with a caveat on
 * the card, because hiding a live posting is a worse failure than showing a
 * dead one. Never throws: a link check going wrong must not fail a scan whose
 * fetching and scoring already succeeded.
 */
async function verifyPostingLinks(db, stats) {
  if (MAX_LINK_CHECKS_PER_RUN <= 0) {
    console.log('Link check disabled (MAX_LINK_CHECKS_PER_RUN=0).')
    return
  }
  const { data: postings, error } = await db
    .from('job_postings')
    .select('id, title, company, url, link_checked_at, link_checked_url')
    .eq('stale', false)
    .not('url', 'is', null)
  if (error) {
    console.warn(`Link check skipped — could not list postings: ${error.message}`)
    return
  }

  const { data: matchRows, error: matchErr } = await db.from('job_matches').select('posting_id, score')
  if (matchErr) {
    console.warn(`Link check skipped — could not list scores: ${matchErr.message}`)
    return
  }
  const scoreById = new Map((matchRows || []).map(m => [m.posting_id, m.score]))

  const freshCutoff = Date.now() - LINK_RECHECK_HOURS * 3600_000
  const candidates = postings
    // Unscored postings, and ones scoring below what the Jobs page shows,
    // are never clicked — checking them would spend the budget on rows
    // nobody sees.
    .filter(p => (scoreById.get(p.id) ?? -1) >= LINK_CHECK_MIN_SCORE)
    .filter(p => {
      // A verdict about a different URL is not a verdict about this one.
      if (!p.link_checked_at || p.link_checked_url !== p.url) return true
      return new Date(p.link_checked_at).getTime() < freshCutoff
    })
    // Best matches first, so if the cap bites it bites the roles you were
    // least likely to open.
    .sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0))
    .slice(0, MAX_LINK_CHECKS_PER_RUN)

  if (!candidates.length) {
    console.log('Link check: every shown posting was verified recently.')
    return
  }

  console.log(`Checking ${candidates.length} posting links (${LINK_CHECK_CONCURRENCY} at a time)…`)
  let results
  try {
    results = await verifyLinks(candidates, {
      concurrency: LINK_CHECK_CONCURRENCY,
      onResult: (p, r) => {
        // Only the interesting outcomes — a run that verifies 150 live links
        // should not print 150 lines saying so.
        if (r.status !== 'live') {
          console.log(`  ${r.status.padEnd(7)} ${p.title} @ ${p.company || '?'} — ${r.note}`)
        }
      },
    })
  } catch (err) {
    console.warn(`Link check failed: ${err.message}`)
    return
  }

  const checkedAt = new Date().toISOString()
  let written = 0
  for (let i = 0; i < results.length; i += 20) {
    const chunk = results.slice(i, i + 20)
    const settled = await Promise.all(
      chunk.map(({ posting, status, note }) =>
        db
          .from('job_postings')
          .update({
            link_status: status,
            link_note: note,
            link_checked_at: checkedAt,
            link_checked_url: posting.url,
            // Confirmed closed — hide it the same way an aged-out posting is
            // hidden, rather than deleting a row you may have applied against.
            ...(status === 'dead' ? { stale: true } : {}),
          })
          .eq('id', posting.id)
      )
    )
    for (const { error: upErr } of settled) {
      if (upErr) console.warn(`  could not save a link verdict: ${upErr.message}`)
      else written++
    }
  }

  const dead = results.filter(r => r.status === 'dead').length
  const unknown = results.filter(r => r.status === 'unknown').length
  stats.links_checked = written
  stats.links_dead = dead
  console.log(
    `Link check: ${results.length - dead - unknown} live, ${dead} closed (hidden), ` +
      `${unknown} could not be verified (still shown, with a caveat).`
  )
}

// ---------- main ----------

async function main() {
  const trigger = process.env.SCAN_TRIGGER === 'manual' ? 'manual' : 'schedule'
  const { data: run, error: runErr } = await db
    .from('job_runs')
    .insert({ status: 'running', trigger })
    .select()
    .single()
  if (runErr) throw new Error(`Could not open run log: ${runErr.message}`)

  const stats = { fetched: 0, new_postings: 0, scored: 0, links_checked: 0, links_dead: 0 }
  let quotaStopped = false
  let scoringError = null

  try {
    const { data: profile, error: profErr } = await db
      .from('job_profile')
      .select('*')
      .eq('id', 1)
      .single()
    if (profErr) throw new Error(`Could not load profile: ${profErr.message}`)
    if (!profile.resume_text && !profile.summary) {
      throw new Error('Profile is empty — fill in the Profile tab before scanning')
    }

    const { data: sources, error: srcErr } = await db
      .from('job_sources')
      .select('*')
      .eq('enabled', true)
    if (srcErr) throw new Error(`Could not load sources: ${srcErr.message}`)

    const queries = buildQueries(profile)
    const locations = buildLocations(profile)
    console.log(`Profile targets: ${queries.join(' | ')}`)
    console.log(`Sources enabled: ${sources.length}`)

    // ---- fetch ----
    const raw = []
    // source key ('ashby:acme') -> every posting id that board still lists.
    const boardIndex = new Map()
    for (const src of sources) {
      const adapter = ADAPTERS[src.kind]
      if (!adapter) {
        console.warn(`  skip ${src.label}: no adapter for kind "${src.kind}"`)
        continue
      }
      try {
        const rows = await adapter({
          token: src.token,
          label: src.label,
          queries,
          locations,
          env: process.env,
        })
        console.log(`  ${src.label}: ${rows.length}`)
        raw.push(...rows)
        // Only reached when the adapter SUCCEEDED. A board that threw tells us
        // nothing about what it does or doesn't still list, and must never be
        // read as "everything on it is closed".
        indexCompleteBoard(boardIndex, src, rows)
        await db
          .from('job_sources')
          .update({ last_ok_at: new Date().toISOString(), last_error: null })
          .eq('id', src.id)
      } catch (err) {
        console.warn(`  ${src.label}: FAILED — ${err.message}`)
        await db.from('job_sources').update({ last_error: err.message }).eq('id', src.id)
      }
    }
    stats.fetched = raw.length

    // ---- dedupe within this run ----
    const byPrint = new Map()
    for (const job of raw) {
      if (!job.title || !job.title.trim()) continue
      const fp = fingerprint(job)
      const existing = byPrint.get(fp)
      if (!existing) {
        byPrint.set(fp, {
          ...job,
          fingerprint: fp,
          source_ids: { [job.source]: job.source_id },
          // Which feed the kept URL came from — not necessarily the feed the
          // rest of the row came from, once a better link wins below.
          url_source: job.url ? job.source : null,
        })
        continue
      }
      // Same role from a second feed: keep the richest description and record
      // the extra source id, so the row shows every place it was found.
      existing.source_ids[job.source] = job.source_id
      if ((job.description || '').length > (existing.description || '').length) {
        existing.description = job.description
      }
      // Link to the most authoritative copy, not merely the first one seen.
      // Feed order is whatever order the sources table happens to be in, so
      // "first wins" was effectively picking the link at random — and an
      // aggregator's link is markedly more likely to outlive the posting.
      if (job.url && (!existing.url || urlRank(job.source) > urlRank(existing.url_source))) {
        existing.url = job.url
        existing.url_source = job.source
      }
      // Prefer a genuinely published figure over an aggregator's estimate,
      // even when the estimate arrived first.
      if (
        (existing.salary_min == null && job.salary_min != null) ||
        (existing.salary_predicted && !job.salary_predicted && job.salary_min != null)
      ) {
        existing.salary_min = job.salary_min
        existing.salary_max = job.salary_max
        existing.salary_currency = job.salary_currency || existing.salary_currency
        existing.salary_predicted = Boolean(job.salary_predicted)
      }
      existing.remote = existing.remote || job.remote
    }
    const unique = [...byPrint.values()]
    console.log(`Deduped: ${raw.length} → ${unique.length}`)

    // ---- persist postings ----
    const now = new Date().toISOString()
    const rows = unique.map(j => ({
      fingerprint: j.fingerprint,
      // Follows the URL, not the first feed that happened to return the role:
      // the UI reads this to explain where the link goes (and to offer the
      // Adzuna fallback search), so it has to describe the link that's
      // actually on the card. source_ids keeps the full record of every feed.
      source: j.url_source || j.source,
      source_ids: j.source_ids,
      title: j.title.trim(),
      company: j.company || null,
      location: j.location || null,
      remote: Boolean(j.remote),
      url: j.url || null,
      description: j.description || null,
      salary_min: j.salary_min ?? null,
      salary_max: j.salary_max ?? null,
      salary_currency: j.salary_currency || null,
      salary_predicted: Boolean(j.salary_predicted),
      posted_at: toISO(j.posted_at),
      last_seen_at: now,
      stale: false,
    }))

    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200)
      const { error } = await db
        .from('job_postings')
        .upsert(chunk, { onConflict: 'fingerprint', ignoreDuplicates: false })
      if (error) throw new Error(`Upsert failed: ${error.message}`)
    }

    // ---- re-apply verdicts the upsert just cleared ----
    // Every row above was written with stale=false, which is correct for the
    // "stopped appearing in the feeds" signal: it was in a feed, so it is not
    // absent. It is wrong for a posting whose page we have already fetched and
    // found closed — aggregators re-list those for weeks, so without this they
    // would resurface at full score on every single scan.
    //
    // The verdict only holds while the URL is unchanged. If a later scan found
    // the same role at a better link (an ATS page replacing an aggregator's),
    // the old verdict says nothing about the new URL, so it is cleared and the
    // row is re-checked below.
    const { data: deadRows, error: deadErr } = await db
      .from('job_postings')
      .select('id, url, link_checked_url')
      .eq('link_status', 'dead')
    if (deadErr) {
      console.warn(`Could not re-apply confirmed-dead links: ${deadErr.message}`)
    } else if (deadRows.length) {
      const sameUrl = deadRows.filter(r => r.url && r.url === r.link_checked_url).map(r => r.id)
      const newUrl = deadRows.filter(r => !r.url || r.url !== r.link_checked_url).map(r => r.id)
      if (sameUrl.length) {
        const { error } = await db
          .from('job_postings')
          .update({ stale: true })
          .in('id', sameUrl)
          .eq('stale', false)
        if (error) console.warn(`Could not keep dead links hidden: ${error.message}`)
      }
      if (newUrl.length) {
        const { error } = await db
          .from('job_postings')
          .update({ link_status: null, link_note: null })
          .in('id', newUrl)
        if (error) console.warn(`Could not reset link status on relinked postings: ${error.message}`)
      }
      console.log(`Confirmed-dead links kept hidden: ${sameUrl.length}` +
        (newUrl.length ? ` (${newUrl.length} relinked, will be re-checked)` : ''))
    }

    // ---- close anything its own ATS board has stopped listing ----
    // Runs before scoring so a role that has already been taken down never
    // costs an LLM call, and never reaches the list at all.
    await closeMissingFromBoards(db, boardIndex, stats)

    // ---- find what still needs scoring ----
    // Two plain queries rather than an embedded "is null" filter — the
    // anti-join form is easy to get subtly wrong in PostgREST and silently
    // returns everything, which would re-score the whole table every run.
    const { data: live, error: liveErr } = await db
      .from('job_postings')
      .select('*')
      .eq('stale', false)
      .order('posted_at', { ascending: false, nullsFirst: false })
    if (liveErr) throw new Error(`Could not list postings: ${liveErr.message}`)

    const { data: scoredRows, error: scoredErr } = await db
      .from('job_matches')
      .select('posting_id')
    if (scoredErr) throw new Error(`Could not list existing matches: ${scoredErr.message}`)

    const alreadyScored = new Set((scoredRows || []).map(r => r.posting_id))
    const unscored = live.filter(p => !alreadyScored.has(p.id))

    stats.new_postings = unscored.length
    console.log(`Unscored postings: ${unscored.length}`)

    const queue = []
    for (const job of unscored) {
      const reason = prefilterReason(profile, job)
      if (reason) {
        // Record a cheap 'poor' verdict so it isn't re-examined every run.
        queue.push({ job, skip: reason })
      } else {
        queue.push({ job, skip: null })
      }
    }

    const skipped = queue.filter(q => q.skip)
    if (skipped.length) {
      const { error } = await db.from('job_matches').upsert(
        skipped.map(({ job, skip }) => ({
          posting_id: job.id,
          score: 0,
          tier: 'poor',
          why_fit: '',
          gaps: `Filtered before scoring: ${skip}.`,
          pitch_angle: '',
          model: 'prefilter',
        })),
        { onConflict: 'posting_id' }
      )
      if (error) console.warn(`Could not record prefiltered rows: ${error.message}`)
      console.log(`Prefiltered out: ${skipped.length}`)
    }

    const toScore = queue.filter(q => !q.skip).map(q => q.job).slice(0, MAX_SCORES_PER_RUN)
    const batches = []
    for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
      batches.push(toScore.slice(i, i + BATCH_SIZE))
    }
    const provider = activeProvider()
    console.log(
      `Scoring ${toScore.length} postings in ${batches.length} batches of ${BATCH_SIZE} ` +
        `(provider: ${provider}${provider === 'gemini' ? `, paced at ${GEMINI_RPM} req/min` : ''})`
    )

    const titleOf = j => `${j.title} @ ${j.company || '?'}`

    for (const [n, batch] of batches.entries()) {
      try {
        const verdicts = await scoreJobBatch(profile, batch)
        if (verdicts.length) {
          // Persist per batch, not at the end: if the daily quota runs out
          // mid-scan, everything scored so far is already saved.
          const { error } = await db.from('job_matches').upsert(
            verdicts.map(v => ({ ...v, scored_at: new Date().toISOString() })),
            { onConflict: 'posting_id' }
          )
          if (error) throw new Error(error.message)
          stats.scored += verdicts.length
        }
        const byId = new Map(verdicts.map(v => [v.posting_id, v]))
        for (const job of batch) {
          const v = byId.get(job.id)
          console.log(
            v
              ? `  ${String(v.score).padStart(3)} ${v.tier.padEnd(11)} ${titleOf(job)}`
              : `  ??? (no assessment returned) ${titleOf(job)}`
          )
        }
        console.log(`  — batch ${n + 1}/${batches.length} done (${stats.scored} scored so far)`)
      } catch (err) {
        // Keep the first failure: it is almost always the real cause, and the
        // run summary reports it so a scan that scored nothing can't look
        // like a success.
        if (!scoringError) scoringError = err.message
        if (err instanceof QuotaExhaustedError) {
          console.warn(`\n${err.message}`)
          quotaStopped = true
          break
        }
        // One bad batch shouldn't abort the run; those postings stay unscored
        // and are retried next time.
        console.warn(`  batch ${n + 1} failed: ${err.message}`)
      }
    }

    // A run that tried to score and scored nothing is a failed run, however
    // gracefully it stopped. Reporting "ok" here hid a broken API key across
    // three consecutive scans.
    if (toScore.length > 0 && stats.scored === 0) {
      throw new Error(
        `Scoring failed for all ${toScore.length} postings. First error: ${scoringError || 'unknown'}`
      )
    }

    // ---- verify the links actually still lead to an open posting ----
    // The one check that catches what every other signal here misses: a role
    // still sitting in an aggregator's index, freshly re-seen this run, that
    // the employer closed a fortnight ago. Runs after scoring so the budget
    // can be spent on the postings that scored well enough to be shown.
    await verifyPostingLinks(db, stats)

    // ---- age out postings that stopped appearing ----
    const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86400_000).toISOString()
    const { error: staleErr } = await db
      .from('job_postings')
      .update({ stale: true })
      .lt('last_seen_at', cutoff)
      .eq('stale', false)
    if (staleErr) console.warn(`Could not mark stale postings: ${staleErr.message}`)

    // ---- age out postings whose OWN stated deadline has passed ----
    // A stronger, immediate signal than "stopped appearing in feeds" —
    // straight from the posting's own text, when it states one at all.
    const today = new Date().toISOString().slice(0, 10)
    const { data: expired, error: expiredErr } = await db
      .from('job_matches')
      .select('posting_id')
      .not('application_deadline', 'is', null)
      .lt('application_deadline', today)
    if (expiredErr) {
      console.warn(`Could not check deadline-expired postings: ${expiredErr.message}`)
    } else if (expired.length) {
      const { error } = await db
        .from('job_postings')
        .update({ stale: true })
        .in('id', expired.map(e => e.posting_id))
        .eq('stale', false)
      if (error) console.warn(`Could not mark deadline-expired postings: ${error.message}`)
      else console.log(`Marked ${expired.length} postings stale — their own stated deadline has passed.`)
    }

    await db
      .from('job_runs')
      .update({ status: 'ok', ...stats, finished_at: new Date().toISOString() })
      .eq('id', run.id)

    console.log(
      `\nDone. fetched=${stats.fetched} new=${stats.new_postings} scored=${stats.scored} ` +
        `links_checked=${stats.links_checked} links_dead=${stats.links_dead}`
    )
    if (quotaStopped) {
      console.log('Stopped early on the daily LLM quota — the remainder is scored on the next run.')
    }
  } catch (err) {
    console.error(`Scan failed: ${err.message}`)
    await db
      .from('job_runs')
      .update({
        status: 'error',
        ...stats,
        error: err.message,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
    process.exit(1)
  }
}

main()
