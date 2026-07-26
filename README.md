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

**Scores fit and screening risk separately.** A long, senior career helps the fit
score and never counts against it — but it's a real filter risk with hiring teams,
so that's reported as its own rated field rather than hidden inside the number.
Generated CVs follow standard executive practice: recent impact first, full detail
on the last 12–15 years, earlier roles compressed, no graduation years.

Deliberately does not scrape LinkedIn or Indeed: both block automated access and
forbid it in their terms. Sources are documented APIs and the public ATS endpoints
that Greenhouse, Lever and Ashby publish for embedding company job boards.
See SETUP.md for what that does and doesn't cost you in coverage.
