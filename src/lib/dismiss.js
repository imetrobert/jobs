import { supabase } from './supabase'

/**
 * Throw a role away for good.
 *
 * Two steps, and the ORDER IS LOAD-BEARING. Deleting the posting on its own
 * does not make a role go away: the feeds still carry it, so the next scan
 * re-imports it, spends an LLM call re-scoring it, and puts it back in the
 * list. The suppression row is what makes the deletion stick, so it is written
 * first and the delete only happens once it succeeded.
 *
 * Both failure modes therefore land somewhere safe:
 *   - suppression fails  → nothing is deleted, the card stays, you see an error
 *   - delete fails       → the row is already suppressed, and the next scan
 *                          removes it (see the drift sweep in run-job-scan.js)
 *
 * The reverse order would give the one genuinely bad outcome: the match
 * write-up thrown away and the posting back again a week later.
 */
export async function dismissPosting(job, reason) {
  if (!job?.fingerprint) {
    // Only possible if job_ranked predates the column, i.e. the schema wasn't
    // re-run. Say so plainly rather than silently deleting nothing.
    throw new Error('This posting has no fingerprint — re-run supabase/schema.sql, then try again.')
  }

  const { error: markErr } = await supabase.from('job_dismissed').upsert(
    { fingerprint: job.fingerprint, title: job.title, company: job.company, reason },
    { onConflict: 'fingerprint' }
  )
  if (markErr) throw new Error(`Could not record the dismissal: ${markErr.message}`)

  const { error: delErr } = await supabase.from('job_postings').delete().eq('id', job.id)
  if (delErr) throw new Error(`Recorded, but could not delete it yet: ${delErr.message}`)

  // A DELETE that row-level security refuses is NOT an error: PostgREST
  // answers 204 No Content having removed nothing, and supabase-js reports
  // error: null. So a blocked delete is indistinguishable from a real one
  // unless you go and look — which is why the button once said "Deleting…",
  // reported no failure, and left the posting sitting there.
  //
  // The check reads back through job_ranked rather than asking DELETE for a
  // RETURNING clause. Postgres applies SELECT policies to RETURNING, and this
  // install has none on job_postings — reads go through the view, which runs
  // with its owner's rights. Verifying via the same path the app already
  // reads by is the one that cannot fail for a reason unrelated to the delete.
  const { count, error: checkErr } = await supabase
    .from('job_ranked')
    .select('id', { count: 'exact', head: true })
    .eq('id', job.id)
  if (checkErr) return // can't verify; the scan's sweep is the backstop
  if (count) {
    throw new Error(
      'The database would not delete this posting — the delete was refused and nothing was removed. ' +
        'It is recorded as dismissed, so it has gone from your lists and the next scan will clear ' +
        'the row, but the delete policy on job_postings needs fixing.'
    )
  }
}
