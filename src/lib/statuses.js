// Pipeline statuses, in one place — they were previously spelled out three
// times (the card's dropdown, the Pipeline page's columns, and the Matches
// query's exclusion list), which is how a status can end up settable but
// invisible, or hidden from Matches but with no way to undo it.

// The stored values. Order is the order the dropdown and the Pipeline page
// use, so the two closing-out states sit together at the end.
export const STATUSES = [
  'interested',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'passed',
  'unavailable',
]

// What each one is called on screen. The stored values are deliberately left
// alone — 'passed' has been written to rows since the first scan and renaming
// it in the database would orphan them — but "passed" reads as jargon, and
// "passed the screen?" is the opposite of what it means. The label says it
// plainly instead.
export const STATUS_LABELS = {
  interested: 'Interested',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected by employer',
  passed: 'Not interested',
  unavailable: 'No longer available',
  // Set by the document generator, never chosen by hand, but a row can be
  // sitting in one of these when the dropdown renders.
  generating: 'Drafting…',
  ready: 'Docs ready',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

// Statuses that take a role out of Matches. Two kinds of "done with this",
// deliberately kept distinct:
//   rejected/passed  — a decision about the ROLE (they said no, or you did)
//   unavailable      — a fact about the POSTING (it's gone; nobody decided
//                      anything). Worth separating, because "I passed on 40
//                      roles" and "40 roles evaporated before I could apply"
//                      say very different things about a job search.
// Nothing is deleted: every one of these still shows on the Pipeline page,
// which is where a mistaken click gets undone.
export const CLOSED_STATUSES = ['rejected', 'passed', 'unavailable']
