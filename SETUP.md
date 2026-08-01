# Job Match — setup

A private, login-gated job matcher: it pulls postings from job APIs and company
ATS boards, scores each one against your profile with an LLM, ranks them, explains
why each fits, and drafts a tailored cover letter and CV on demand.

Built to sit alongside your invoicing and ETF apps on the **same Supabase project**
— same login, tables namespaced `job_` so they can't collide.

```
1st of the month (or you click "Refresh now")
    │
    ▼
job-scan.yml runs
    │
    ├── Fetches from Adzuna / Jooble / your ATS company boards
    ├── Normalizes → dedupes (same role across 3 feeds = 1 row)
    ├── Prefilters out obvious misses (wrong level, deal-breakers)
    ├── Scores the rest with Claude or Gemini → score, why it fits, gaps, pitch angle
    ├── Opens the link of everything it's about to show and drops the closed ones
    └── Writes to Supabase
    │
    ▼
You open jobs.imetrobert.com, sign in, read the ranked list
    │
    └── "Draft cover letter + CV" on anything you like
            └── generate-application edge function → both documents, downloadable
```

---

## Why not LinkedIn and Indeed

Both block automated access and prohibit it in their terms — LinkedIn returns
`403` to anything without a browser session. A scraper would break within weeks
and put your name on a ToS complaint while you're job hunting.

You lose less than it sounds. LinkedIn and Indeed are themselves aggregators
pulling from the same ATS feeds this app reads directly — often getting the
posting *later* than the source. Adzuna and Jooble cover the broad market
legitimately; company boards give you the sharp edge (see step 6).

If you want literal LinkedIn/Indeed-sourced rows, JSearch resells Google-for-Jobs
results as a paid API — add `JSEARCH_RAPIDAPI_KEY` and it turns on. Optional.

---

## One-time setup

Roughly 30 minutes, most of it waiting on signups.

### 1. Create the database tables

Supabase Dashboard → your shared project → **SQL Editor** → paste all of
`supabase/schema.sql` → Run.

Safe to re-run. Everything is `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, and
the `job_` prefix keeps it clear of your invoicing and `etf_` tables.

### 2. Get the job feed keys

| Service | Cost | Where | Env var |
|---|---|---|---|
| **Adzuna** | Free (~1,000 calls/month) | [developer.adzuna.com](https://developer.adzuna.com/) — instant, self-serve | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` |
| **Jooble** | Free | [jooble.org/api/about](https://jooble.org/api/about) — short request form | `JOOBLE_API_KEY` |
| **JSearch** | Free tier, then paid | [RapidAPI](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) | `JSEARCH_RAPIDAPI_KEY` |

Adzuna alone is enough to start. Skip JSearch unless you specifically want
LinkedIn/Indeed rows.

A monthly scan uses roughly 20–40 Adzuna calls, so the free tier has ample room
even with on-demand refreshes.

### 3. The scorer — Gemini, free tier

Set **`GEMINI_API_KEY`** — the same key your blog pipeline already uses. That's it.

**Nothing in this system requires a paid Claude subscription, a Claude Code seat,
or any paid Anthropic account** — not to install it, run it, or maintain it. There
is no Anthropic package in `package.json`. Once deployed, it runs unattended on
GitHub Actions, Supabase and Gemini; you never need an AI coding assistant to keep
it working.

The design is sized to stay inside Gemini's free tier rather than merely tolerate it:

| Lever | Effect |
|---|---|
| **Prefilter before scoring** | Wrong seniority, deal-breakers and wrong geography are rejected by plain code. Those postings never cost a request. |
| **Batched scoring** (`SCORE_BATCH_SIZE`, default 5) | 120 postings become **~24 requests**, not 120. It also sends your resume once per batch instead of once per job, cutting token use several-fold. |
| **Paced queue** (`GEMINI_RPM`, default 8/min) | Every call is serialized through one queue with a minimum gap. Deliberately under the free tier's ~10/min ceiling — running at the limit turns most requests into a retry and makes the scan slower, not faster. |
| **Retry with backoff** | Per-minute 429s back off (4s → 32s) and retry, then fall through the model chain: `gemini-2.5-flash` → `flash-lite` → `2.0-flash`. |
| **Graceful daily-quota stop** | If the daily quota does run out, the scan saves everything scored so far, logs why, and finishes the rest on the next run. It does not fail. |
| **`MAX_SCORES_PER_RUN`** (default 120) | Hard ceiling per run. |

A typical monthly scan is **around 24 Gemini requests over roughly three
minutes**, plus one request each time you draft a cover letter. Against a
free-tier daily allowance measured in hundreds of requests, that leaves ample
headroom even with several on-demand refreshes in the same day.

Two things worth knowing about Google's free tier:

- **Quotas are per project, not per key.** A new key inside the same Google
  project shares its allowance with anything else there — including your blog.
  The blog uses a handful of requests a month, so this doesn't matter in
  practice, but it's why a second key isn't a second allowance.
- **Google no longer publishes one universal limits table** — quotas are set per
  project and shown in the AI Studio console. If a scan reports quota errors
  unexpectedly, check there before assuming something is broken.

### Free tier and your data

On the **free** tier, Google may use prompts and responses to improve its
products, and reviewers may see them. That means your résumé text and the
postings you're being matched against. Google's paid-tier commitment not to
train on submitted content does **not** apply to free usage outside the EEA,
Switzerland and the UK — so it applies to Canada.

There's no route by which this reaches an employer, and for most people it's an
acceptable trade for a free service. But it's your career history, so it should
be a decision rather than a surprise. If you'd rather it weren't used that way,
enabling billing on the Gemini project moves you to the paid tier and its
no-training commitment — at this volume the bill would be a few cents a month,
not zero, but close to it.

If you ever want sharper reasoning, adding `ANTHROPIC_API_KEY` switches the scorer
to Claude with no other change. Purely optional — leave it unset and nothing
degrades.

### 4. Move this into its own repo

`jobs.imetrobert.com` needs its own repository, because GitHub Pages allows only
one custom domain per repo and `imetrobert.github.io` already claims
`www.imetrobert.com`.

```sh
# 1. Create an empty repo on GitHub named `jobs` (private is fine —
#    GitHub Pages serves private repos on paid plans; use public if not).

# 2. From a clone of imetrobert.github.io:
cp -r jobs-app /tmp/jobs && cd /tmp/jobs
git init && git add -A
git commit -m "Job matcher: initial import"
git branch -M main
git remote add origin https://github.com/imetrobert/jobs.git
git push -u origin main
```

The `.github/workflows/` directory travels with it and activates in the new repo.
It's intentionally inert while it sits inside `imetrobert.github.io` — workflows
only run from a repo's root.

### 5. Configure the new repo

**Settings → Secrets and variables → Actions:**

| Secret | Used by | Required |
|---|---|---|
| `VITE_SUPABASE_URL` | site build | yes |
| `VITE_SUPABASE_ANON_KEY` | site build | yes |
| `SUPABASE_URL` | scan job | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | scan job | yes |
| `GEMINI_API_KEY` | scoring | yes |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | Adzuna feed | recommended |
| `JOOBLE_API_KEY` | Jooble feed | optional |
| `JSEARCH_RAPIDAPI_KEY` | JSearch feed | optional |
| `ANTHROPIC_API_KEY` | scoring upgrade | **no — leave unset** |

**Settings → Pages:** Source = **GitHub Actions**, Custom domain = `jobs.imetrobert.com`.

**DNS** (same place you set up `invest.imetrobert.com`): add a `CNAME` record,
host `jobs`, value `imetrobert.github.io`. Wait for the Pages check to go green,
then tick **Enforce HTTPS**.

**Deploy the edge function** — Supabase Dashboard → Edge Functions → Deploy a new
function → name it exactly `generate-application`, paste
`supabase/functions/generate-application/index.ts`, deploy. Keep **Verify JWT ON** —
that's what restricts it to your logged-in session. Then add the same
`GEMINI_API_KEY` or `ANTHROPIC_API_KEY` under Edge Functions → Secrets.

### 6. Fill in your profile — this is the part that matters

Sign in at `jobs.imetrobert.com` with your existing Supabase credentials and go to
**Profile**.

**Use whichever source is most current for the Experience box — LinkedIn is fine,
and beats a stale CV.** The scorer reads plain text and doesn't care about
formatting; it cares about evidence. Fastest route: LinkedIn → your profile →
*More* → *Save to PDF*, then paste the text in. Then add what LinkedIn omits —
team sizes, budgets, P&L scope, and outcomes with real numbers.

Match quality is almost entirely downstream of this. Both the scorer and the
letter writer are forbidden from inventing experience, so thin input doesn't
produce wrong claims — it produces vague, hedged ones. Anything you leave out
simply isn't considered.

Then set:
- **Target titles** — these literally become the search queries sent to the feeds.
- **Locations** and **minimum seniority**.
- **Compensation** — see below.
- **Deal breakers** — anything matching is filtered out before it costs an LLM call.

#### Compensation is judged on the total package

The floor is on **total compensation, not base salary**. A role advertising 110k
base can clear a 128k floor once bonus, employer pension contributions, benefits
and equity are counted — so base is never used to reject a posting anywhere in
the system, and compensation never moves the fit score.

Fill in three fields:

| Field | What it does |
|---|---|
| **Total compensation floor** | The actual bar, e.g. `128000`. |
| **What counts toward that total** | Free text — bonus target %, pension match, benefits, equity. The more specific, the better the estimate on roles that publish only a base range. |
| **Hard floor on base alone** | Usually blank. Only fill it if a low base is a non-starter regardless of package. |

Each match then reports a **Total compensation** verdict, separate from the score:

- **above / at / below** — an estimate of the whole package against your floor,
  with reasoning.
- **unclear** — pay wasn't disclosed. This is the *most common* answer and is
  neutral, not a warning. The scorer is explicitly told that guessing from a job
  title is the error, not diligence.

One subtlety worth knowing: Adzuna *estimates* a salary when the employer
publishes none. Those are captured as estimates and shown as `~120,000 (est.)`,
and the scorer is told plainly that they're a guess — so an inferred number never
gets treated as a disclosed band.

Generated cover letters and CVs never mention a figure, ask for one, or state
expectations, even if the posting asks. That conversation belongs somewhere you
control the framing, not in a first-pass screening document.

---

## Getting past automated screening

Most applications are parsed and ranked by software before a human sees them.
Two things get a real candidate rejected there: **formatting the parser can't
read**, and **not using the employer's words for work you actually did**. Both
are handled.

### Formatting

Generated CVs are built to parse: linear layout, standard section headings
(`Professional Experience`, `Skills`, `Education`), reverse-chronological entries
as *title → employer → location → dates* in consistent `MM/YYYY`, plain hyphen
bullets, acronyms spelled out once with the short form beside them, and a plain
`Skills` section — the part keyword matching leans on hardest.

Explicitly excluded: tables, columns, text boxes, headers/footers, images, icons,
logos, custom glyphs, and pipe-delimited lines. These are the single most common
reason a strong CV scores as near-empty.

Each generated CV offers **`.txt` (ATS-safe)** and `.md`. **Upload the `.txt`
to portals** — many render raw Markdown literally, so `**Director**` reaches the
reviewer with the asterisks showing.

### Keywords

Every match lists the terms that posting screens on, split two ways:

- **You can back** — terms you genuinely evidence, in the posting's exact wording.
  These are woven into the generated documents inside real accomplishments.
- **Not evidenced** — terms you can't support. These are **never** inserted into
  a document. They're shown so *you* can see them.

The **Recurring screening gaps** panel on the Matches page aggregates the second
list across every scored role. That's the one to act on: a term missing once is
noise, but a term missing from nine postings usually means you've done the work
and call it something else. Adding the market's wording to your LinkedIn and CV
is then free — real experience, better described. Where you genuinely haven't
done it, that's your actual gap list; leave it out rather than claiming it.

### What this deliberately does not do

No white text, no hidden keywords, no invisible blocks, no keyword lists stuffed
in for the parser, and no claiming a skill you can't evidence. Beyond being
dishonest, modern parsers detect all of it, it's grounds for immediate rejection,
and it attaches your name to a faked application in an industry where people
talk. The system will not generate any of it.

The honest version also works better. Term overlap is only part of the ranking,
and a recruiter reading a stuffed CV bins it instantly.

### ⚠️ Your "better visuals" CV plan conflicts with this

A designed CV — two columns, a sidebar, icons, a skills bar chart, a header
block — is close to the worst case for a parser. Columns interleave into
nonsense, sidebars are dropped, and text inside graphics is invisible. A CV that
looks excellent to a person can score near-zero.

**Keep two versions of the same content:**

| Version | Use for |
|---|---|
| **Plain** (the `.txt` here) | Portal uploads, any application form, recruiter databases |
| **Designed** | Emailing a human, networking, interviews, your own site |

Same facts, same wording, different packaging. Never send the designed one
through a portal, and never assume the plain one is what a person will read.

### 7. Add company boards (the sharp edge)

**Sources** tab. Aggregators cover the market broadly; company boards get you the
role the day it posts, straight from the ATS, before any aggregator indexes it.

Add the employers you'd actually leave for. Paste either the slug or the full URL:

- Greenhouse → `boards.greenhouse.io/<slug>`
- Lever → `jobs.lever.co/<slug>`
- Ashby → `jobs.ashbyhq.com/<slug>`

Free, no key, no rate limit worth worrying about. Ten good companies here will
outperform any aggregator.

### 8. Enable the Refresh button

The in-app **Refresh now** button starts the scan workflow on your behalf, so it
needs a token — the same pattern as your blog preview page.

Create one at [github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo&description=Job%20Match%20Refresh)
with the **`repo`** scope (a fine-grained token works too, with **Actions: read and
write** on this repo). Note that **`workflow` is the wrong scope** despite the name —
it governs editing workflow files, not running them. Then paste the token into the
"Set up Refresh" box in the
app. It's stored in that browser's localStorage only — once per device, never
committed.

You can always skip this and run the scan from the repo's **Actions** tab instead.

---

## Reading the results

Scores are deliberately calibrated to be *unflattering*. A list where everything
is 85 is useless, so the scorer is told most postings are mediocre fits.

| Tier | Score | Meaning |
|---|---|---|
| Exceptional | 90–100 | Reads as though written for you |
| Strong | 75–89 | Clearly qualified, would likely get an interview |
| Possible | 55–74 | Plausible, but you're one of many |
| Stretch | 35–54 | Missing something material |
| Poor | 0–34 | Hidden from the list entirely |

Each card gives you five things:

- **Why this fits you** — the specific experience that maps to the role.
- **The honest gaps** — read this one; it's what an interviewer will probe.
- **Screening risk** — see below. Colour-coded green/amber/red.
- **Total compensation** — the whole package against your floor, not base.
- **Screening keywords** — what the posting's parser looks for, split into what
  you can back and what you can't.
- **Lead with** — the angle for the cover letter.

Three of those are deliberately *separate from the score*, because they answer
different questions. Fit asks "could you do this and would you lead the field?"
Screening risk asks "will you get the call?" Compensation asks "is it worth
taking?" Collapsing them into one number would hide whichever one you most need
to see.

### Dead postings, and why the list used to be full of them

The most annoying failure this app had was clicking a good match and getting
*"The job position is no longer available"*. That is not a scoring problem — it
is what aggregators do. Jooble, Adzuna and JSearch keep a closed role in their
index for weeks after the employer took it down, so the posting is genuinely
returned by the feed on every scan, `last_seen_at` keeps refreshing, and the
"stopped appearing anywhere" staleness rule never fires. None of the feed APIs
expose a "still open" flag.

Two signals catch this, and they work on different sources.

**1. The ATS board no longer lists it.** For Greenhouse, Lever, Ashby, Workable
and SmartRecruiters, the adapter already pulls the board's *entire* current
contents in one call. So a posting missing from that pull has been taken down —
known the same day, with no extra request and nothing for a site to refuse.
This is the strongest signal available and it is free.

It only fires when absence genuinely means something. A board that errored, or
returned zero jobs (which could equally be a changed response shape), is
skipped rather than closing everything on it. SmartRecruiters is skipped when
its list comes back at the 100-item page limit, since postings past that cap
were never seen and would look "missing". Aggregators are excluded entirely:
Adzuna, Jooble and JSearch return a *search* over a much larger index, so a
posting can fall out of the results on ranking alone while staying wide open.

**2. The posting page says so.** For everything else, the scan opens the URL
after scoring and reads the answer off the response — a `404`/`410`, an expiry
banner ("no longer available", "this position has been filled", "cette offre
n'est plus disponible"), or a redirect off the posting onto a search page.

Either way the role is marked stale and disappears before you can click it. The
Matches header reports the total: *"…, 600 links checked (38 already closed,
dropped)"*.

Two design decisions worth knowing about:

- **It fails open.** There are three outcomes, not two: `live`, `dead`, and
  `unknown`. A bot wall, a timeout, a captcha, a 5xx or Adzuna's regional block
  all produce `unknown`, and an `unknown` posting **stays in the list** with an
  amber caveat on the card saying what happened. Hiding a real job you would
  have applied to is a worse error than showing one dead link, so only positive
  evidence of closure hides anything.
- **Where several feeds carry the same role, the link now points at the most
  authoritative copy.** A company's own Greenhouse/Lever/Ashby page *is* the
  posting and 404s the moment it closes; an aggregator's page is a record of
  one and outlives it. Previously the kept URL was whichever feed happened to
  be listed first in the Sources table, which was effectively random. This
  costs nothing and fixes a good share of the problem on its own.

A posting confirmed dead stays hidden even though the aggregator keeps
re-listing it — but only while the URL is unchanged. If a later scan finds the
same role at a better link, the old verdict is cleared and it gets re-checked.

The page fetches are plain page loads: no API key, no quota, nothing to pay
for. They are the slowest part of a scan, so `MAX_LINK_CHECKS_PER_RUN`
(default 600) caps them, spending the budget on the highest-scoring roles
first. Anything verified in the last `LINK_RECHECK_HOURS` (default 20) at the
same URL is skipped. Set `MAX_LINK_CHECKS_PER_RUN=0` to turn that pass off —
the ATS board check above is unaffected, since it costs nothing.

That default lives in exactly one place: the `max_link_checks` input default in
`job-scan.yml`. The app's **Refresh now** button sends only `trigger`, so it
inherits the same number, and so does the monthly cron. Change it there and
every path changes with it.

**Triage from the list, without opening anything.** Every card carries a pill in
its tag row, first in the row, so the list can be scanned for the roles that are
certainly still open before any time goes into reading them:

| Pill | Meaning |
|---|---|
| **✓ Verified** (green) | The posting page was open when the scan last checked it. |
| **Unverified** (amber) | The check ran and couldn't reach a verdict. Hover for why. |
| **Not checked** (grey) | Never checked — the run hit its budget first. |

There is no pill for "closed": those are hidden from the list outright. Every
row gets one of the three, including the plain unchecked case, since an absent
badge would read as reassurance.

**Clearing a role yourself.** The check can only catch what a site is willing
to admit, so an expanded card carries two one-click dismissals under the link,
which is where you find out:

- **No longer available** — you opened it and the posting is gone. Sets the
  role's status to `unavailable`.
- **Not interested** — it's still up, you just don't want it. Sets `passed`.

Both remove it from Matches immediately. Neither deletes anything: the role
still appears on the **Pipeline** page under that heading, which is where a
mistaken click gets undone by setting the status back.

They're kept as separate statuses on purpose. `passed` is a decision about the
*role*; `unavailable` is a fact about the *posting* — nobody decided anything.
"I passed on 40 roles" and "40 roles evaporated before I could apply" say very
different things about how a search is going, and collapsing them into one
bucket would lose that.

**What the caveats on a card mean.** Expanding a card spells out the same
verdict in full. Only a *confirmed* close hides a posting, so anything still in
the list is one of three things:

| Card says | Meaning |
|---|---|
| *Posting page still open when checked 4h ago* | Verified. Good to go. |
| *Jooble refuses automated checks…* | Unverifiable source. Jooble 403s every request and its listings routinely outlive the job — the likeliest source of a dead click. Open it first. |
| *Adzuna blocks this page from Canada* | Regional block, **not** a closed job. Use "Search instead". |
| *This board builds its pages in the browser* | Nothing readable in the HTML. Usually fine. |
| *This link hasn't been checked yet* | Ran out of budget before reaching it. Raise the cap. |

### Screening risk is not the same as fit

This is a deliberately separate field, and it's the one most worth paying
attention to.

A deep, senior career is an asset for roles with real scope — and simultaneously
a filter risk, because hiring teams screen out candidates they read as too
senior, too expensive, or likely to leave for something bigger. Those are two
different questions, and blending them into one number would either hide the
risk or unfairly penalise good matches. So:

- **`score`** answers *could you do this job and would you be a leading
  candidate?* Depth of experience only ever helps it. Long tenure is never
  treated as a defect.
- **`overqualification_risk`** answers *will you actually get the call?* Rated
  none / low / moderate / high, with a reason. This is where a years-of-experience
  ceiling, a band below your floor, or "high-energy / digital native" language in
  the posting gets flagged.

A role scoring 88 with **high** screening risk is worth applying to *differently* —
through a referral rather than the portal, with a letter that leads hard on
current, in-demand work. That's a different action from a role scoring 88 with
low risk, and the split is what lets you tell them apart.

The generated documents are written to survive that screen without ever
misstating anything: they lead with recent and current impact rather than career
length, give full detail to roughly the last 12–15 years and compress earlier
roles into a single line, and omit graduation years. Standard executive-CV
practice — it hides nothing a hiring manager needs and removes the hooks that
trigger a reflexive filter.

They are still drafts. The prompt forbids inventing employers, titles, dates or
metrics, but read them before sending: every claim should be one you can defend
in an interview.

---

## Using this as standby readiness

If the point is to be ready to move quickly rather than to be actively job
hunting, the ordering changes:

- **Fill in the profile now, while you have time.** Reconstructing scope, budgets,
  team sizes and outcomes under pressure is slow and produces worse material than
  doing it unhurried. This is the single highest-value thing to do early, and it
  only has to be done once. Start from LinkedIn if that's what's current — a
  good-enough profile today beats a perfect one you never get to.
- **Treat the profile as the draft of your future CV.** Everything the scorer
  wants — scope, numbers, outcomes — is exactly what a strong CV needs. Filling
  this box carefully is the first pass at rewriting LinkedIn and the CV, not a
  detour from it. The tailored CVs the app generates are also useful raw
  material: they show which parts of your history land hardest against real
  postings.
- **Let the monthly scan run in the background.** The value isn't any single
  month's list — it's that the market picture and your document drafts are already
  warm on the day you need them, instead of starting cold.
- **Pre-draft documents for anything scoring "exceptional" or "strong".** They're
  saved against the posting and stay there. Even where the specific role is gone
  by the time you need it, you'll have several strong letters to adapt rather than
  a blank page.
- **Watch the screening-risk field over time.** If most strong matches come back
  moderate or high, that's a signal to adjust positioning — usually by sharpening
  the recent, current work at the top of your resume — well before it costs you
  anything real.
- **Let the recurring-gaps panel drive the LinkedIn rewrite.** After three or four
  scans it's reading dozens of real postings in your target market and telling
  you which words that market uses. That's a far better basis for rewriting a
  profile than guessing at what sounds senior — and it costs nothing to collect
  while you wait.
- **Re-run the scan the day anything changes.** One click, results in minutes.

The site is `noindex`, robots-disallowed and behind your Supabase login, so
none of this is discoverable while you're still employed.

## Running costs

| | |
|---|---|
| GitHub Pages + Actions | Free |
| Supabase | Free tier, shared with your other two apps |
| Adzuna / Jooble / ATS boards | Free |
| Gemini scoring | Free tier — ~24 requests per scan |
| **Total** | **$0/month** |
| Claude scoring | Optional, off by default. A few cents per scan if you ever enable it. |

**The steady state is free and requires no subscription of any kind.** If a scan
ever does hit the daily Gemini quota it stops cleanly, keeps what it scored, and
finishes on the next run — you lose time, never data.

To reduce request volume further, raise `SCORE_BATCH_SIZE` (8–10 still works
well; quality drifts if you push much past that) or lower `MAX_SCORES_PER_RUN`.

---

## When something goes wrong

**"No scan has run yet"** — Profile is empty. The scan refuses to run without a
resume or summary, because scoring against nothing produces noise.

**Scan failed, "Missing GEMINI_API_KEY"** — the secret isn't set on the *jobs*
repo. Secrets don't carry over from `imetrobert.github.io`.

**Log says "Gemini daily quota exhausted"** — not a failure. Everything scored
before the wall is saved, and the rest is picked up on the next run. If it keeps
happening, raise `SCORE_BATCH_SIZE` or lower `MAX_SCORES_PER_RUN`.

**Log shows "rate limited … retrying in 4s"** — normal. That's the per-minute
limiter working; it backs off and continues. Lower `GEMINI_RPM` if it's frequent.

**A batch logs "??? (no assessment returned)"** — the model skipped some postings
in that batch. They stay unscored and are retried next run. Persistent cases
usually mean `SCORE_BATCH_SIZE` is too high; drop it back toward 5.

**A source shows a red error in the Sources tab** — the message is stored per
source. Usually a bad ATS slug (check the board URL loads in a browser) or an
expired key. Other sources keep working; one bad feed never fails the run.

**Refresh button says the token was rejected** — the token needs the `workflow`
scope and access to the `jobs` repo. Fine-grained tokens need
*Actions: read and write* on that repository.

**Nothing scores above 35** — usually the seniority floor or locations are too
narrow, or the resume is too thin for the scorer to find evidence. Widen
locations first; it's the most common cause.

**Roles you expected are missing** — add the company's ATS board directly in
Sources. Aggregator coverage of senior roles is genuinely patchy; company boards
are not.

**A card carries an amber caveat instead of the green "still open" line** — the
link check ran and could not reach a verdict; see the table above for what each
one means. It is a caveat, not a verdict. Open the link before drafting
anything.

**Lots of cards say "hasn't been checked yet"** — the run hit
`MAX_LINK_CHECKS_PER_RUN` before reaching them. Raise it: Actions → Job scan →
Run workflow → `max_link_checks`. To see how many are outstanding:

```sql
select coalesce(p.link_status, 'not checked yet') as status, count(*)
from job_postings p join job_matches m on m.posting_id = p.id
where p.stale = false and m.score >= 35 group by 1 order by 2 desc;
```

**Everything from one ATS board vanished at once** — that board's adapter is
supposed to be skipped when it returns nothing, so this should not happen. Check
the Sources tab for an error on it, and `link_note` on the affected rows (it
will read *"no longer listed on the … job board"*). If the board is fine in a
browser, the adapter is misreading the response; open an issue rather than
re-running, since a re-run would keep closing them.

**A posting you clicked is still dead** — the check only catches sites that say
so. A page that returns a normal-looking 200 with no expiry wording is
indistinguishable from a live one. If a particular board does this with
consistent wording, add the phrase to `DEAD_PATTERNS` in
`scripts/verify-links.js`; keep it literal, since every pattern there can hide a
real job.

**The scan step got noticeably slower** — that's the link checks, which are
network-bound rather than CPU-bound. Lower `MAX_LINK_CHECKS_PER_RUN`, or raise
`LINK_CHECK_CONCURRENCY` (default 6; same-host requests stay paced regardless).

---

## Layout

```
jobs-app/
├── src/                          React app (login, ranked list, profile, pipeline, sources)
├── scripts/
│   ├── run-job-scan.js           orchestrator: fetch → dedupe → prefilter → score → verify → persist
│   ├── sources.js                one adapter per feed; add new feeds here
│   ├── scoring.js                the scoring prompt, schema, and prefilter
│   ├── verify-links.js           opens each posting URL; live / dead / unknown
│   └── llm.js                    Claude / Gemini switch
├── supabase/
│   ├── schema.sql                job_* tables, RLS, the job_ranked view
│   └── functions/generate-application/   cover letter + CV edge function
└── .github/workflows/
    ├── job-scan.yml              monthly cron + on-demand dispatch
    └── deploy.yml                build and publish to Pages
```

To change the *voice* of the scoring or the letters, edit the `SYSTEM` prompt in
`scripts/scoring.js` or `supabase/functions/generate-application/index.ts`. To add
a new job feed, write one adapter in `scripts/sources.js` returning the shared
posting shape and register it in `ADAPTERS`.
