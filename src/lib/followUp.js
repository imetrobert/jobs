// Pipeline follow-ups, stored in the job_applications.notes column.
//
// There is deliberately no migration for this. The notes column already
// exists on job_applications and nothing in the app reads or writes it —
// the card loads cover_letter/tailored_cv from that table directly, and
// notes was never surfaced — so it is free to hold the follow-up without
// touching the job_ranked view or asking for a SQL run. The format stays
// human-readable in the database on purpose: a row should still make sense
// when read outside the app.
//
//   Follow-up: 2026-11-03
//   <freeform note, any number of lines>
//
// Parsing is forgiving: a notes value written by hand (no Follow-up line)
// loads with its whole text in the note field, so nothing is ever silently
// destroyed — the editor shows it before any save rewrites the field.

const DATE_LINE = /^Follow-up:\s*(\d{4}-\d{2}-\d{2})\s*$/m

export function parseFollowUp(notes) {
  const text = String(notes || '')
  const m = text.match(DATE_LINE)
  const date = m ? m[1] : ''
  const note = text
    .split('\n')
    .filter(line => !DATE_LINE.test(line))
    .join('\n')
    .trim()
  return { date, note }
}

export function formatFollowUp(date, note) {
  const d = String(date || '').trim()
  const n = String(note || '').trim()
  if (!d && !n) return null
  return [d ? `Follow-up: ${d}` : null, n || null].filter(Boolean).join('\n')
}

export function isFollowUpDue(date, today = new Date()) {
  if (!date) return false
  const day = new Date(`${date}T00:00:00`)
  if (Number.isNaN(day.getTime())) return false
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return day <= start
}
