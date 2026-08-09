import { supabase } from './supabase'

/**
 * Throw a role away for good.
 *
 * One step: write the suppression row. Nothing is deleted.
 *
 * The suppression row is what actually makes a role go away, and it always
 * was — it does the whole job on both paths that matter. The list filters
 * against it the moment it is written (Jobs.jsx, Applications.jsx), so the card
 * disappears immediately; and the scan filters re-imported feed results against
 * it before persisting, so the role never comes back. Neither of those ever
 * consulted job_postings.
 *
 * This used to also delete the posting row, which looked like tidying up and
 * was not. job_matches and job_applications both declare
 *
 *   references job_postings(id) on delete cascade
 *
 * so deleting a posting silently destroyed its match write-up, its application
 * status, and any generated cover letter. Dismiss a role you had already
 * applied to and your own pipeline entry went with it. On a Supabase project
 * shared by several people it was worse: one person dismissing a role destroyed
 * everybody else's verdicts and applications for it, because the posting is a
 * single shared row.
 *
 * What is lost by not deleting: dismissed postings stay in job_postings. They
 * are filtered out of every list and never re-scored, so this costs some rows
 * and nothing else — a fair price for not cascading through other people's
 * data.
 */
export async function dismissPosting(job, reason) {
  if (!job?.fingerprint) {
    // Only possible if job_ranked predates the column, i.e. the schema wasn't
    // re-run. Say so plainly rather than silently suppressing nothing.
    throw new Error('This posting has no fingerprint — re-run supabase/schema.sql, then try again.')
  }

  const { error } = await supabase.from('job_dismissed').upsert(
    { fingerprint: job.fingerprint, title: job.title, company: job.company, reason },
    { onConflict: 'fingerprint' }
  )
  if (error) throw new Error(`Could not record the dismissal: ${error.message}`)
}
