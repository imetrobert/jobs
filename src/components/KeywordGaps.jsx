import { useMemo, useState } from 'react'

/**
 * Aggregates screening keywords across every scored match.
 *
 * A term missing from one posting is noise. The same term missing from nine of
 * them is a positioning problem — and almost always means the experience exists
 * but is described in different words. This is the panel worth acting on when
 * rewriting a LinkedIn profile or CV, because it is derived from real postings
 * in the target market rather than from guesswork.
 */
export default function KeywordGaps({ jobs }) {
  const [open, setOpen] = useState(false)

  const { missing, covered, scored } = useMemo(() => {
    const miss = new Map()
    const have = new Map()
    let n = 0

    const tally = (map, field, job) => {
      if (!job[field]) return
      for (const raw of job[field].split(';')) {
        const term = raw.trim()
        if (!term) continue
        const key = term.toLowerCase()
        const prev = map.get(key)
        // Keep the first spelling seen; count case-insensitively.
        map.set(key, { term: prev?.term || term, count: (prev?.count || 0) + 1 })
      }
    }

    for (const job of jobs) {
      if (!job.ats_keywords_covered && !job.ats_keywords_missing) continue
      n++
      tally(miss, 'ats_keywords_missing', job)
      tally(have, 'ats_keywords_covered', job)
    }

    const sort = m => [...m.values()].sort((a, b) => b.count - a.count)
    return { missing: sort(miss), covered: sort(have), scored: n }
  }, [jobs])

  if (scored < 3) return null

  // Only surface terms that recur — a single sighting is not a pattern.
  const recurring = missing.filter(m => m.count > 1)
  if (!recurring.length) return null

  const top = open ? recurring : recurring.slice(0, 8)

  return (
    <div className="card gaps">
      <h3>Recurring screening gaps</h3>
      <p className="muted sm">
        Across {scored} scored roles. These are terms the postings screen on that your
        profile doesn&apos;t currently evidence. Where you <em>have</em> done the work
        and simply call it something else, adding the market&apos;s wording to your
        LinkedIn and CV is a free win. Where you genuinely haven&apos;t, this is your
        real gap list — leave it out rather than claiming it.
      </p>
      <div className="kw-terms">
        {top.map(m => (
          <span className="kw kw-miss" key={m.term}>
            {m.term}
            <em>×{m.count}</em>
          </span>
        ))}
      </div>
      {recurring.length > 8 && (
        <button className="btn ghost sm" onClick={() => setOpen(v => !v)}>
          {open ? 'Show fewer' : `Show all ${recurring.length}`}
        </button>
      )}
      {covered.length > 0 && (
        <p className="muted sm">
          Strongest recurring matches you already back:{' '}
          {covered.slice(0, 6).map(c => c.term).join(', ')}.
        </p>
      )}
    </div>
  )
}
