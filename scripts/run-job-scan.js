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
// available; 45 days was generous enough to leave clearly-dead postings
// visible for a month and a half. 14 gives a fair reappearance window
// (feeds aren't always re-crawled daily) without lingering nearly that long.
const STALE_AFTER_DAYS = 14

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

// ---------- main ----------

async function main() {
  const trigger = process.env.SCAN_TRIGGER === 'manual' ? 'manual' : 'schedule'
  const { data: run, error: runErr } = await db
    .from('job_runs')
    .insert({ status: 'running', trigger })
    .select()
    .single()
  if (runErr) throw new Error(`Could not open run log: ${runErr.message}`)

  const stats = { fetched: 0, new_postings: 0, scored: 0 }
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
        byPrint.set(fp, { ...job, fingerprint: fp, source_ids: { [job.source]: job.source_id } })
        continue
      }
      // Same role from a second feed: keep the richest description and record
      // the extra source id, so the row shows every place it was found.
      existing.source_ids[job.source] = job.source_id
      if ((job.description || '').length > (existing.description || '').length) {
        existing.description = job.description
      }
      existing.url = existing.url || job.url
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
      source: j.source,
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

    console.log(`\nDone. fetched=${stats.fetched} new=${stats.new_postings} scored=${stats.scored}`)
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
