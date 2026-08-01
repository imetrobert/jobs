// Pipeline statuses, in one place — they were previously spelled out three
// times (the card's dropdown, the Pipeline page's columns, and the Matches
// query's exclusion list), which is how a status can end up settable but
// invisible, or hidden from Matches with no way to get it back.

// The statuses you can actually set. These are stages of a live pipeline:
// every one of them means the role is still in play.
//
// Throwing a role away is deliberately NOT one of them. A dismissed role is
// deleted outright (see lib/dismiss.js) rather than parked in a status,
// because a status still has to be displayed somewhere, and the point is that
// it stops existing.
export const STATUSES = ['interested', 'applied', 'interviewing', 'offer', 'rejected']

// No longer settable, but rows written before dismissal deleted things still
// carry it. Rendered wherever it turns up so those roles remain reachable,
// and still kept out of Matches.
export const LEGACY_STATUSES = ['passed']

// Column order on the Pipeline page.
export const PIPELINE_COLUMNS = [...STATUSES, ...LEGACY_STATUSES]

export const STATUS_LABELS = {
  interested: 'Interested',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected by employer',
  passed: 'Not interested (old)',
  // Set by the document generator, never chosen by hand, but a row can be
  // sitting in one of these when the dropdown renders.
  generating: 'Drafting…',
  ready: 'Docs ready',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

// Statuses that keep a role out of Matches without deleting it: the employer
// said no, or (legacy) you passed. Both still show on Pipeline.
export const CLOSED_STATUSES = ['rejected', 'passed']

// Why a role was thrown away. Both delete it; the distinction is recorded
// because "I passed on 40 roles" and "40 roles evaporated before I could
// apply" say very different things about how a search is going.
export const DISMISS_REASONS = {
  unavailable: 'No longer available',
  not_interested: 'Not interested',
}
