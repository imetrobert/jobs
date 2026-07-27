-- Personal Job Matcher — schema
-- Paste this whole file into the Supabase SQL editor of the shared project
-- (same project as the invoicing and ETF apps). Safe to re-run: everything
-- is IF NOT EXISTS / ON CONFLICT DO NOTHING. Table names are prefixed job_
-- so they can't collide with the invoicing or etf_ tables.

-- ---------------------------------------------------------------------
-- Profile: one row (id = 1). Everything the scorer knows about you.
-- Edited in the app's Profile tab; read by the scan job.
-- ---------------------------------------------------------------------
create table if not exists job_profile (
  id int primary key default 1 check (id = 1),
  headline text,
  summary text,
  years_experience int,
  location text,
  -- Free-text resume. Pasted once; used verbatim as grounding for both
  -- match scoring and cover-letter/CV generation.
  resume_text text,
  -- What counts as a good job. Arrays of text.
  target_titles text[] not null default '{}',
  target_industries text[] not null default '{}',
  must_haves text[] not null default '{}',
  deal_breakers text[] not null default '{}',
  -- Geography the scan searches and the scorer accepts.
  locations text[] not null default '{}',
  remote_ok boolean not null default true,
  -- The real bar is TOTAL compensation, not base. A posting listing 110k base
  -- can clear a 128k total-comp floor once bonus, pension, benefits and equity
  -- are counted, so base is never used as a rejection threshold anywhere.
  min_total_comp numeric,
  -- Free text: which components count toward that total, and at what value
  -- (bonus target %, pension match, equity, benefits). Fed to the scorer so it
  -- can estimate a posting's total package the way you actually would.
  comp_components text,
  -- Optional hard floor on base alone, for roles where a low base is a
  -- non-starter regardless of the package. Usually left blank.
  min_base_salary numeric,
  -- Legacy: superseded by min_total_comp. Kept so re-running this file on an
  -- existing install doesn't drop data; migrated across just below.
  min_salary numeric,
  salary_currency text not null default 'CAD',
  -- Seniority floor — postings below this are filtered out before scoring
  -- so Gemini quota isn't spent rejecting junior roles.
  min_seniority text not null default 'director'
    constraint job_profile_seniority_chk
    check (min_seniority in ('any','senior','manager','director','vp','c_level')),
  updated_at timestamptz not null default now()
);

-- Migrations for installs created before total-comp handling existed.
alter table job_profile add column if not exists min_total_comp numeric;
alter table job_profile add column if not exists comp_components text;
alter table job_profile add column if not exists min_base_salary numeric;
-- Carry any old base-salary floor over to the new total-comp field once, so an
-- existing profile keeps a sensible bar instead of silently losing it.
update job_profile
  set min_total_comp = min_salary
  where min_total_comp is null and min_salary is not null;

-- ---------------------------------------------------------------------
-- Sources: which feeds the scan job pulls from.
-- kind = 'adzuna' | 'jooble' | 'jsearch' | 'greenhouse' | 'lever' | 'ashby'
-- For ATS kinds, `token` is the company's board slug, e.g.
--   greenhouse → boards.greenhouse.io/<token>
--   lever      → jobs.lever.co/<token>
--   ashby      → jobs.ashbyhq.com/<token>
-- For aggregator kinds, `token` is unused (keys come from env).
-- ---------------------------------------------------------------------
create table if not exists job_sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in
    ('adzuna','jooble','jsearch','greenhouse','lever','ashby')),
  label text not null,
  token text,
  enabled boolean not null default true,
  last_ok_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  constraint job_sources_kind_token_key unique (kind, token)
);

-- ---------------------------------------------------------------------
-- Postings: every job seen, deduped. `fingerprint` is a normalized
-- company+title+location hash so the same role syndicated across Adzuna,
-- Jooble and the company's own ATS collapses into one row.
-- ---------------------------------------------------------------------
create table if not exists job_postings (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  source text not null,
  source_ids jsonb not null default '{}'::jsonb,
  title text not null,
  company text,
  location text,
  remote boolean not null default false,
  url text,
  description text,
  salary_min numeric,
  salary_max numeric,
  salary_currency text,
  -- True when the aggregator ESTIMATED the salary rather than reading it off
  -- the posting (Adzuna does this). Estimates must not be presented as
  -- disclosed pay.
  salary_predicted boolean not null default false,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Set when a posting stops appearing in feeds, so the UI can grey it out
  -- rather than deleting history you may have already applied against.
  stale boolean not null default false
);
create index if not exists job_postings_posted_idx on job_postings (posted_at desc);
create index if not exists job_postings_stale_idx on job_postings (stale);

-- ---------------------------------------------------------------------
-- Matches: the LLM's verdict on one posting against the profile.
-- One row per posting (re-scoring updates in place).
-- ---------------------------------------------------------------------
create table if not exists job_matches (
  posting_id uuid primary key references job_postings(id) on delete cascade,
  score int not null check (score between 0 and 100),
  tier text not null check (tier in ('exceptional','strong','possible','stretch','poor')),
  why_fit text,
  gaps text,
  -- Screening risk, kept deliberately separate from `gaps` and from `score`:
  -- being read as too senior or too expensive is a reason you never get the
  -- call, not a reason you couldn't do the job. Conflating the two either
  -- hides real risk or unfairly depresses good matches.
  overqualification_risk text,
  -- Estimated TOTAL compensation against the profile's floor, kept separate
  -- from `score` for the same reason as overqualification_risk: most postings
  -- disclose nothing, and guessing must never quietly depress a good match.
  comp_assessment text,
  -- Applicant-tracking keywords. Semicolon-separated terms the posting appears
  -- to screen on, split by whether the profile already evidences them.
  -- `covered` feeds the document writer the employer's own vocabulary for
  -- things you have actually done. `missing` is NEVER inserted into a document
  -- — it exists so you can see, across many postings, which real experience you
  -- are describing in the wrong words.
  ats_keywords_covered text,
  ats_keywords_missing text,
  pitch_angle text,
  -- Where this posting sits relative to Côte Saint-Luc: fully remote and
  -- confidently Montreal-eligible, on-site/hybrid close by, on-site/hybrid
  -- but a real commute, remote with genuinely unclear Canadian eligibility,
  -- or no way to do it from Montreal at all (outside Montreal with no
  -- stated remote-from-Canada option). That last one keeps its real score
  -- — it's excluded from the default list by a query filter, not by being
  -- zeroed here — since it's excluded on location, not on merit. Null on
  -- rows scored before this column existed, or where the model genuinely
  -- failed to return a value: hard-excluded (score zeroed) since that's a
  -- real unknown, not a confirmed classification.
  location_fit text
    check (location_fit is null or location_fit in ('remote_montreal','onsite_close','onsite_far','remote_unclear','not_montreal')),
  -- Populated only when location_fit is 'not_montreal' AND the fit is
  -- exceptional/strong enough that proactively asking about a remote or
  -- hybrid arrangement is a reasonable move despite the posting not
  -- offering one. Empty for the (much more common) ordinary not_montreal row.
  negotiation_note text,
  -- Only set when the posting's OWN text states a closing/apply-by date.
  -- The scan marks the posting stale once this date passes — a stronger,
  -- immediate signal than the general "stopped appearing in any feed" one,
  -- for the minority of postings that state a deadline at all.
  application_deadline date,
  model text,
  scored_at timestamptz not null default now()
);
alter table job_matches add column if not exists overqualification_risk text;
alter table job_matches add column if not exists comp_assessment text;
alter table job_matches add column if not exists ats_keywords_covered text;
alter table job_matches add column if not exists ats_keywords_missing text;
alter table job_matches add column if not exists location_fit text;
alter table job_matches add column if not exists negotiation_note text;
alter table job_matches add column if not exists application_deadline date;
create index if not exists job_matches_score_idx on job_matches (score desc);

-- ---------------------------------------------------------------------
-- Applications: your pipeline, plus generated documents.
-- ---------------------------------------------------------------------
create table if not exists job_applications (
  posting_id uuid primary key references job_postings(id) on delete cascade,
  status text not null default 'interested'
    check (status in ('interested','generating','ready','applied','interviewing','offer','rejected','passed')),
  cover_letter text,
  tailored_cv text,
  notes text,
  generated_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Runs: log of every scan so the UI can show progress and last-run state.
-- ---------------------------------------------------------------------
create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running','ok','error')),
  trigger text not null default 'schedule',
  fetched int not null default 0,
  new_postings int not null default 0,
  scored int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists job_runs_started_idx on job_runs (started_at desc);

-- ---------------------------------------------------------------------
-- Row level security: the logged-in user (any authenticated user of this
-- project) gets full access from the app; the scan job uses the service
-- role key, which bypasses RLS.
-- ---------------------------------------------------------------------
alter table job_profile enable row level security;
alter table job_sources enable row level security;
alter table job_postings enable row level security;
alter table job_matches enable row level security;
alter table job_applications enable row level security;
alter table job_runs enable row level security;

drop policy if exists "job_profile_auth" on job_profile;
create policy "job_profile_auth" on job_profile
  for all to authenticated using (true) with check (true);

drop policy if exists "job_sources_auth" on job_sources;
create policy "job_sources_auth" on job_sources
  for all to authenticated using (true) with check (true);

drop policy if exists "job_applications_auth" on job_applications;
create policy "job_applications_auth" on job_applications
  for all to authenticated using (true) with check (true);

-- Postings, matches and runs are written only by the scan job (service
-- role). The app reads them.
drop policy if exists "job_postings_read" on job_postings;
create policy "job_postings_read" on job_postings
  for select to authenticated using (true);

drop policy if exists "job_matches_read" on job_matches;
create policy "job_matches_read" on job_matches
  for select to authenticated using (true);

drop policy if exists "job_runs_read" on job_runs;
create policy "job_runs_read" on job_runs
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- Convenience view: ranked jobs with their match verdict and pipeline
-- status in one shot, so the dashboard is a single query.
-- ---------------------------------------------------------------------
create or replace view job_ranked as
select
  p.id,
  p.title,
  p.company,
  p.location,
  p.remote,
  p.url,
  p.description,
  p.salary_min,
  p.salary_max,
  p.salary_currency,
  p.salary_predicted,
  p.source,
  p.posted_at,
  p.first_seen_at,
  p.stale,
  m.score,
  m.tier,
  m.why_fit,
  m.gaps,
  m.overqualification_risk,
  m.comp_assessment,
  m.ats_keywords_covered,
  m.ats_keywords_missing,
  m.pitch_angle,
  m.scored_at,
  a.status as app_status,
  (a.cover_letter is not null) as has_cover_letter,
  -- New columns go LAST. Postgres's CREATE OR REPLACE VIEW only allows
  -- appending — inserting a column before scored_at here once broke a
  -- live deploy with "cannot change name of view column scored_at to
  -- location_fit", because everything after the insertion point shifted
  -- ordinal position and looked like a rename to Postgres.
  m.location_fit,
  -- Sort key, not a display value: lower sorts first. Confidently
  -- remote-and-Montreal-eligible leads, then close to Côte Saint-Luc, then a
  -- real commute but still Montreal, then remote-but-unclear-eligibility —
  -- worth seeing, just not ahead of anything Montreal-confirmed.
  -- not_montreal sorts behind all of those: it's excluded from the default
  -- list entirely (Jobs.jsx filters it out unless the "worth negotiating"
  -- toggle is on) and this position only matters when that filtered set is
  -- shown. Rows with no location_fit at all (never actually judged) sort
  -- dead last — unlike not_montreal, nothing says they're even that good,
  -- and unlike everything else they never appear regardless of the toggle
  -- since their score is zeroed.
  case m.location_fit
    when 'remote_montreal' then 1
    when 'onsite_close' then 2
    when 'onsite_far' then 3
    when 'remote_unclear' then 4
    when 'not_montreal' then 5
    else 6
  end as location_priority,
  m.negotiation_note,
  m.application_deadline
from job_postings p
left join job_matches m on m.posting_id = p.id
left join job_applications a on a.posting_id = p.id;

-- Views run with the definer's rights; the underlying tables are still
-- RLS-protected, and anon has no grant here.
revoke all on job_ranked from anon;
grant select on job_ranked to authenticated;

-- ---------------------------------------------------------------------
-- Seed: profile row + a starter set of aggregator sources.
-- ATS company boards are added from the app's Sources tab.
-- ---------------------------------------------------------------------
insert into job_profile (id) values (1) on conflict (id) do nothing;

insert into job_sources (kind, label, token) values
  ('adzuna', 'Adzuna (Canada)', 'ca'),
  ('adzuna', 'Adzuna (United States)', 'us'),
  ('jooble', 'Jooble', null)
on conflict (kind, token) do nothing;
