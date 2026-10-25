-- Allow 'workday' as a job_sources kind.
--
-- The repo's schema.sql already lists 'workday' in the kind check, but the
-- live database was built by hand plus migrations, so it may still carry
-- the old list. Run this once in the Supabase SQL editor before adding the
-- first Workday board; until then, inserting a workday source fails on the
-- check constraint with a clear error, and nothing else breaks.
--
-- If the live database never had the check constraint at all (only the
-- unique constraint), this is a harmless no-op to verify first — the
-- DO block below only alters when the constraint exists.
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
