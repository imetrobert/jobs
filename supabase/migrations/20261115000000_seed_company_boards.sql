-- Seed company boards (Montreal-relevant employers), 2026-11-15.
--
-- One paste in the Supabase SQL editor. Safe to re-run (on conflict do nothing).
-- Step 1 makes sure 'workday' is an allowed kind (same fix as
-- 20261025000000_add_workday_source_kind.sql); step 2 adds the boards.
-- No new table, so no grants are needed.
--
-- Not included: employers whose careers site is not a supported board
-- (Telus, Rogers, BMO, Scotiabank, National Bank, iA, IATA, UN agencies).
-- Desjardins is Workday but its exact site name is unverified; add it from the
-- Sources tab by pasting its Workday search URL once you have it open.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'job_sources_kind_check'
      and conrelid = 'public.job_sources'::regclass
  ) then
    alter table public.job_sources drop constraint job_sources_kind_check;
    alter table public.job_sources add constraint job_sources_kind_check
      check (kind in
        ('adzuna','jooble','remotive','jsearch','greenhouse','lever','ashby',
         'smartrecruiters','workable','workday'));
  end if;
end $$;

insert into job_sources (kind, label, token) values
  ('smartrecruiters', 'Videotron / Quebecor', 'Videotron'),
  ('smartrecruiters', 'Transat', 'TransatAT1'),
  ('ashby',           'Lightspeed', 'lightspeedhq'),
  ('workable',        'Mila', 'mila-2'),
  ('greenhouse',      'Coveo', 'coveoen'),
  ('workday',         'Sun Life', 'sunlife.wd3.myworkdayjobs.com/Experienced-Jobs'),
  ('workday',         'Manulife', 'manulife.wd3.myworkdayjobs.com/MFCJH_Jobs'),
  ('workday',         'CAE', 'cae.wd3.myworkdayjobs.com/career'),
  ('workday',         'NAV Canada', 'navcanada.wd10.myworkdayjobs.com/NAV_Careers'),
  ('workday',         'CDPQ', 'cdpq.wd10.myworkdayjobs.com/CDPQ')
on conflict (kind, token) do nothing;
