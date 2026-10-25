// Normalize a pasted company careers/board URL (or a bare slug) into the
// { kind, slug, label } a job_sources row needs.
//
// The Sources form used to pull the slug out with a single regex —
// `^.*\/([^/?#]+).*$` — which takes the LAST path segment whatever it is.
// That mis-parses the two forms that actually show up in the wild:
//   - Greenhouse embed URLs: boards.greenhouse.io/embed/job_board?for=<slug>
//     (the regex returned "job_board", a board that does not exist)
//   - URLs with a trailing path or query string after the slug.
// Parsing the URL properly also means the board type can be detected from
// the hostname, so pasting a careers URL is enough — no need to pick the
// ATS kind first.
//
// Workday is the odd one: its "slug" is not a single token. A Workday board
// is identified by its host AND its site, so the token stored for kind
// 'workday' is "<host>/<site>" (myworkdayjobs) or
// "<host>/recruiting/<tenant>/<site>" (myworkdaysite). The fetchWorkday
// adapter in scripts/sources.js parses that same form back apart.
//
// Deliberately NOT here: LinkedIn, Indeed, Job Bank. LinkedIn and Indeed
// block automated access and forbid it in their terms; Job Bank has no free
// live API. See scripts/sources.js for the same rule on the scan side.

const HOST_KINDS = {
  'boards.greenhouse.io': 'greenhouse',
  'jobs.lever.co': 'lever',
  'jobs.ashbyhq.com': 'ashby',
  'jobs.smartrecruiters.com': 'smartrecruiters',
  'apply.workable.com': 'workable',
}

function segments(pathname) {
  return String(pathname || '')
    .split('/')
    .filter(Boolean)
    .map(s => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
}

export function parseBoardUrl(input, fallbackKind = null) {
  const raw = String(input || '').trim()
  if (!raw) return null

  // Bare slug, no host, no path: only meaningful with a kind picked already.
  if (!raw.includes('/') && !raw.includes('.')) {
    return fallbackKind ? { kind: fallbackKind, slug: raw, label: raw } : null
  }

  let url
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const segs = segments(url.pathname)

  // Workday: <tenant>.wd<N>.myworkdayjobs.com/<site>, or
  // <tenant>.wd<N>.myworkdaysite.com/recruiting/<tenant>/<site>.
  const wd = host.match(/^([^.]+)\.wd\d+\.(myworkdayjobs\.com|myworkdaysite\.com)$/)
  if (wd) {
    if (host.endsWith('.myworkdayjobs.com')) {
      const site = segs[0]
      if (site) return { kind: 'workday', slug: `${host}/${site}`, label: wd[1] }
    } else if (segs[0] === 'recruiting' && segs[1] && segs[2]) {
      return { kind: 'workday', slug: `${host}/recruiting/${segs[1]}/${segs[2]}`, label: segs[1] }
    }
    return null
  }

  const kind = HOST_KINDS[host]
  if (!kind) return null

  // Greenhouse embed form carries the real board in ?for=.
  if (kind === 'greenhouse') {
    const forSlug = url.searchParams.get('for')
    if (forSlug) return { kind, slug: forSlug, label: forSlug }
  }
  if (!segs[0]) return null
  return { kind, slug: segs[0], label: segs[0] }
}
