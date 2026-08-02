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

  // `.select()` is what makes this trustworthy. A DELETE that row-level
  // security refuses does NOT come back as an error: PostgREST answers 204 No
  // Content having removed nothing, and supabase-js reports error: null. The
  // first version of this trusted that, so a blocked delete looked exactly
  // like a successful one — the button said "Deleting…", nothing failed, and
  // the posting was still sitting there afterwards.
  //
  // Asking for the deleted rows back turns silence into an answer: an empty
  // array means the database declined, and that is reported rather than
  // celebrated.
  const { data: removed, error: delErr } = await supabase
    .from('job_postings')
    .delete()
    .eq('id', job.id)
    .select('id')
  if (delErr) throw new Error(`Recorded, but could not delete it yet: ${delErr.message}`)
  if (!removed || removed.length === 0) {
    throw new Error(
      'The database refused to delete this posting — row-level security removed nothing. ' +
        'It is recorded as dismissed, so it will disappear from this list and the next scan ' +
        'will clear it, but re-run supabase/schema.sql to fix the delete policy.'
    )
  }
}
