# jobs (Job Match) — read this first, it is the map

Private job matcher at jobs.imetrobert.com. React + Vite static site on GitHub Pages;
Supabase (shared project, `job_*` tables); a weekly GitHub Actions scan scores postings
with the Gemini free tier. Maintenance steps: `RUNBOOK.md`. Setup history: `SETUP.md`
(730 lines — read only the section you need, see the index below).

## Rules (non-negotiable)
- Free tier only. Never add a paid API dependency. Scan budget is capped
  (`MAX_SCORES_PER_RUN` / `SCORE_BATCH_SIZE`, at most 24 Gemini requests per run).
- Never commit secrets. The anon key is public by design; the service-role key lives
  only in GitHub Actions secrets.
- New Supabase tables: include explicit Data API grants in the same migration, and
  keep the `job_` prefix. Access is gated by `has_app_access('job')`.
- Do not scrape LinkedIn/Indeed. Fail open on link checks (never hide a real job).
- This repo is its own source of truth. Edit here; there is no upstream copy.

## Where things are
- UI: `src/components/*` (Jobs, JobCard, Applications, Profile, Sources, KeywordGaps)
- Scan pipeline: `scripts/run-job-scan.js` (entry), `sources.js`, `scoring.js`, `llm.js`,
  `verify-links.js`, `generate-digest.js`
- Edge function (cover letter/CV): `supabase/functions/generate-application/index.ts`
- DB: `supabase/schema.sql` + `supabase/migrations/`
- Workflows: `deploy.yml` (Pages, on push to main), `job-scan.yml` (Mondays 11:00 UTC + manual)
- Weekly output: `docs/weekly-digest.md` (committed by the scan)

## SETUP.md index (grep the heading, do not read the whole file)
Why not LinkedIn/Indeed · 1 tables · 2 feed keys · 3 Gemini scorer · 5 repo secrets ·
6 profile · Getting past screening · 7 company boards · 8 Refresh button ·
Reading the results · Running costs · **When something goes wrong** (line ~640) · Layout

## Cheap-change guide
- Copy/text change: edit the one component, commit to main, Pages redeploys (~1 min).
- Add a company board: Sources page in the app, no code change.
- Scan problem: Actions → Job scan → latest run log; then RUNBOOK.md.
