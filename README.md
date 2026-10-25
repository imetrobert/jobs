# Job Match

Private job matcher for [imetrobert](https://www.imetrobert.com) — pulls postings
from job APIs and company ATS boards, ranks them against your profile with an LLM,
explains the fit, and drafts a tailored cover letter and CV on request.

Login-gated via Supabase Auth (same project and credentials as the invoicing and
ETF apps; tables namespaced `job_`).

**→ [SETUP.md](./SETUP.md) — start here.**

```sh
npm install
npm run dev     # local dev server
npm run build   # production build
npm run scan    # run a scan locally (needs .env — see .env.example)
```

**Runs free.** Scoring uses Gemini's free tier, sized to fit via prefiltering,
batched requests and a paced queue (~24 requests per scan). No paid Claude
subscription, Claude Code seat, or Anthropic account is needed to install, run or
maintain it — there is no Anthropic package in the dependency tree. Setting
`ANTHROPIC_API_KEY` is an optional upgrade, nothing more.

**Built to survive automated screening.** Generated CVs use parser-safe structure
(no tables, columns, graphics or pipe separators; standard headings; `.txt`
export for portals) and mirror each posting's own vocabulary — but only for work
the profile genuinely evidences. Terms you can't back are surfaced to you and
never inserted into a document, and no hidden-text or keyword-stuffing tricks are
generated. A recurring-gaps panel aggregates the misses across every scored role,
which is the useful input for rewriting a LinkedIn profile.

**Checks the link before you do.** Aggregators keep listing roles for weeks after
the employer closed them, which is why a good match so often opened on "this job
is no longer available". Every posting about to be shown gets its page fetched
and read; confirmed-closed roles are dropped, and where several feeds carry the
same job the card links to the company's own ATS page rather than an aggregator's
copy of it. A page that can't be read is flagged, never hidden — the check fails
open, because hiding a real job is the worse mistake.

**Scores fit and screening risk separately.** A long, senior career helps the fit
score and never counts against it — but it's a real filter risk with hiring teams,
so that's reported as its own rated field rather than hidden inside the number.
Generated CVs follow standard executive practice: recent impact first, full detail
on the last 12–15 years, earlier roles compressed, no graduation years.

Deliberately does not scrape LinkedIn or Indeed: both block automated access and
forbid it in their terms. Sources are documented APIs and the public ATS endpoints
that Greenhouse, Lever, Ashby, SmartRecruiters, Workable, and Workday publish for
embedding company job boards.
See SETUP.md for what that does and doesn't cost you in coverage.

**Runs weekly, and tells you what it found.** The scan runs every Monday at
11:00 UTC (`.github/workflows/job-scan.yml`), plus on demand from the Actions
tab or the in-app Refresh button. After each run, a digest of the week's new
roles at 35+ — the same bar the Jobs page shows — is written to
`docs/weekly-digest.md` in this repo: title, company, score, location, link,
and the scorer's fit line. The digest is plain formatting of rows already
scored; it makes zero model calls.

**Free tier, by construction.** Gemini usage here must never charge. The
per-scan LLM budget is at most 24 requests (120 postings max, scored 5 per
call), enforced by slicing the scoring queue before batching — adding more
sources changes which postings get scored, never how many. Prefiltering,
batched requests, the paced queue, and stopping early on quota are all
unchanged.

**Follow-ups on the Pipeline page.** Open any tracked role's card and set a
follow-up date (and an optional note). Roles due today or overdue appear
first on the Pipeline page in their own section, instead of inside their
status group. Follow-ups are stored in the existing `job_applications.notes`
column — no migration, no view change; see `src/lib/followUp.js` for the
format.

**Watch a company.** On the Sources tab, paste a company careers URL and the
board type is detected from the hostname — Greenhouse, Lever, Ashby,
SmartRecruiters, Workable, or Workday — and normalized to that board's
public feed. A bare slug works too, with the board type picked from the
dropdown. Workday boards need one thing first: the live database's source
kind list must include `'workday'` — run
`supabase/migrations/20261025000000_add_workday_source_kind.sql` once in
the Supabase SQL editor (the repo's `schema.sql` already includes it).
