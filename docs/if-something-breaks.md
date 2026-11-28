# If something breaks (read this first, then fix only what it names)

1. **A red check or an email from GitHub:** Actions tab, open the failed run, read the last 20 lines of the red step. "Pages build and deployment" red once: re-run the job (usually a transient GitHub error).
2. **A pull request (for example from Dependabot) has a red "PR build check" or "Checks":** do not merge it; open the red step and fix or close the PR.
3. **Monday scan did not run or failed:** Actions, Job scan, latest run; then `RUNBOOK.md` "Monday scan did not run or failed". The scan is capped at 24 Gemini requests per run on purpose; never add a paid API.
4. **A company board shows a red error on Sources:** `RUNBOOK.md` for that heading; remove or fix the board in the app, no code change.
5. **Site did not update after an edit:** `RUNBOOK.md` "Site did not update after an edit"; deploy runs on push to `main`.
