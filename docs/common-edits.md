# Common edits — recipes (Job Match, jobs.imetrobert.com)

Edit the one file named, commit to main. The site redeploys on push (Actions → Deploy to GitHub
Pages). Scan changes take effect on the next run (Actions → Job scan → Run workflow).
Free tier only; never commit a secret.

## 1. Add or fix a company board
No code. App → Sources tab → paste the employer's careers page address; it detects the type
(ashby, greenhouse, workable, smartrecruiters, workday) and token. To fix a wrong one, Remove
it and add it again. Red errors clear on the next scan. Seed list: `supabase/migrations/20261115000000_seed_company_boards.sql`.

## 2. Change your profile, resume or target roles
No code. App → Profile tab. The scoring reads it on every scan.

## 3. Change how jobs are scored or what counts as a fit
`scripts/scoring.js`: the `SYSTEM` prompt (the recruiter instructions, including the location
tiers `remote_montreal`, `onsite_close`, `onsite_far`, `remote_unclear`, `not_montreal`) and the
`ASSESSMENT` object. Change wording only; keep the JSON field names the UI reads
(`score`, `location_fit`, `ats_keywords_covered`, `ats_keywords_missing`).

## 4. Change the AI model (scan errors like 404, "model not found", quota 0)
`scripts/llm.js`: the list `DEFAULT_GEMINI_CHAIN`. Gemini names are retired often and a pinned
name can silently route elsewhere (see the comment in that file). To change without a code edit,
set the repo variable or workflow env `GEMINI_MODEL_CHAIN` (comma list) or `GEMINI_MODEL` (one model).
Key: secret `GEMINI_API_KEY`.

## 5. Change how many jobs are scored per scan (free-tier budget)
`.github/workflows/job-scan.yml`: `MAX_SCORES_PER_RUN` (default 120) and `SCORE_BATCH_SIZE`
(default 5) near the `env:` block. Requests = max / batch, so keep it at or below 24. Also settable
when you press Run workflow.

## 6. Change when the scan runs
`.github/workflows/job-scan.yml`: the `cron:` line (UTC). Default `0 11 * * 1` = Mondays 11:00 UTC.
GitHub pauses schedules after 60 days of no repo activity: Actions → Job scan → Enable workflow.

## 7. Add a new job source type
`scripts/sources.js` (one fetcher per kind, returns postings in the common shape). Then register the
kind where the Sources tab lists types (`src/components/Sources.jsx`) and in the database check
constraint if one exists (see how `20261025000000_add_workday_source_kind.sql` did it).
Do NOT scrape LinkedIn or Indeed.

## 8. Change what the page shows
`src/components/Jobs.jsx` and `JobCard.jsx` (list and card), `Applications.jsx` (tracker),
`KeywordGaps.jsx`, `Profile.jsx`, `Layout.jsx` (menu). Text changes: edit the string there.

## 9. Add a database table or column
A new migration file in `supabase/migrations/` (name `YYYYMMDDHHMMSS_what.sql`) AND mirror it in
`supabase/schema.sql`. Tables start with `job_`. In the same file: `enable row level security`, a
policy using `has_app_access('job')` and explicit grants to `authenticated`. Run it in the Supabase
SQL editor. Never apply a destructive change without exporting first.

## 10. Check it works after any change
Actions: latest Job scan and Deploy runs are green; open jobs.imetrobert.com, Jobs tab loads;
`docs/weekly-digest.md` has a recent date after a scan.
