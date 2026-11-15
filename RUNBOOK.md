# Runbook — jobs (phone-friendly, no terminal needed)

## Monday scan did not run or failed
1. GitHub → Actions → **Job scan** → open the latest run, read the first red step.
2. Gemini 503 / quota: just re-run (Run workflow). The scan scores only unscored postings.
3. `Invalid API key` / 401 from Supabase: rotate the secret (below).
4. No run at all for weeks: GitHub pauses schedules after 60 days without repo activity.
   Open Actions → Job scan → **Enable workflow**, then Run workflow.

## A company board shows a red error on the Sources tab
The error is stored from the LAST scan, so after a fix it stays red until the next scan (tap Refresh, or wait for Monday).
- "Invalid time value" on a Workday board: fixed 2026-11-14 (PR #23, `workdayPostedAt()` in `scripts/sources.js`); red text from before that clears on the next scan.
- 404 / "not found": the token is wrong. Tokens: ashby `lightspeedhq`, workable `mila-2`, greenhouse `coveoen`, smartrecruiters `Videotron` / `TransatAT1`; workday `<host>/<site>` such as `sunlife.wd3.myworkdayjobs.com/Experienced-Jobs`
  (open the employer's careers page in a browser, copy the address, and paste it on the Sources tab: it detects the type and token).
- Fix a wrong token: Remove the source on the Sources tab and re-add it by pasting the careers URL.
- Seed list of Montreal boards: `supabase/migrations/20261115000000_seed_company_boards.sql` (already run). Employers on their own careers systems
  (Telus, Rogers, banks, iA, IATA, UN agencies) cannot be read by the app; use their email alerts instead.

## Site did not update after an edit
Actions → **Deploy to GitHub Pages**. Re-run if red. Needs `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` secrets.

## Secrets (Settings → Secrets and variables → Actions)
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`GEMINI_API_KEY`, optional `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `JOOBLE_API_KEY`,
`JSEARCH_RAPIDAPI_KEY`. To rotate: make a new key at the provider, replace the secret,
run Job scan once to confirm.

## Quarterly check (5 minutes)
- Last Job scan run is green and `docs/weekly-digest.md` has a recent date.
- Gemini key still valid (a scan run proves it).

## Retiring this app
Remove its Supabase objects with `job_` prefix and its `app_access` rows (see the
platform repo's `migration/decommission_cartmatch.sql` for the pattern), delete the DNS
record for jobs.imetrobert.com, archive the repo.
