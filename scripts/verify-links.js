// Link verification: does this posting's URL still lead to a live job?
//
// THE PROBLEM THIS SOLVES
//
// Aggregators keep syndicating a posting long after the employer closed it.
// Jooble, Adzuna and JSearch all return closed roles in ordinary search
// results — the feed row still exists, so the "stopped appearing in any feed"
// staleness signal in run-job-scan.js never fires, and the posting sits in
// the list at full score until you click it and get "The job position is no
// longer available". That is a false positive in the only place it really
// costs anything: after you've read the match write-up and decided to apply.
//
// None of the feed APIs expose a "still open" flag, so the only ground truth
// available is the posting page itself. This module fetches it and reads the
// answer off the response.
//
// FAIL-OPEN, DELIBERATELY
//
// Three outcomes, never two:
//   live    — the page loaded and says nothing about being closed
//   dead    — the page (or its status code) says the posting is gone
//   unknown — we could not tell: bot wall, timeout, region block, 5xx
//
// "unknown" exists so that a site which simply refuses robots never gets a
// live posting hidden from you. Hiding a real job is a worse error than
// showing a dead one, so anything short of positive evidence of death is
// surfaced with a caveat rather than acted on.
//
// The requests are plain, identify themselves honestly, and are paced per
// host. There is no attempt to look like a browser or work around a block:
// a site that says no is recorded as "unknown" and left alone.

const UA = 'imetrobert-job-matcher/1.0 (link check; contact via imetrobert.com)'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_CONCURRENCY = 6
// Minimum gap between two requests to the same host. Aggregator-heavy runs
// would otherwise fire the whole batch at jooble.org at once.
const PER_HOST_DELAY_MS = 600
// Enough to cover any expiry banner, which is always near the top of the
// document. Reading megabytes of a careers-site SPA bundle buys nothing.
const MAX_BODY_CHARS = 120_000
// Expiry notices sit at the top of the page. Matching further down risks
// hitting a "similar jobs" module or a footer FAQ that mentions expired
// postings in the abstract, which would kill a live posting.
const HEAD_TEXT_CHARS = 4_000

// Positive statements that a posting is gone. Kept narrow and literal —
// every pattern here can hide a real job, so "probably" is not good enough.
const DEAD_PATTERNS = [
  /\bno longer (available|active|posted|open|accepting applications)\b/i,
  /\b(job|position|vacancy|posting|offer|listing|role|opportunity)\b[^.!?]{0,60}\b(has expired|is expired|has closed|is closed|has been filled|been filled|is filled|is unavailable|was removed|has been removed)\b/i,
  /\b(this|that) (job|position|vacancy|posting|offer|listing) (is|was) not (available|found)\b/i,
  /\b(job|vacancy|posting|offer) (expired|not found)\b/i,
  /\bwe(?:'re| are) no longer accepting applications\b/i,
  /\bapplications? (are |have been |is )?closed\b/i,
  /\bsorry,? (this|that) (job|position|posting|listing|vacancy)\b/i,
  /\bposition has been filled\b/i,
  // A soft 404: the page returned 200 but is the site's not-found page.
  /\b(page|job) not found\b/i,
  /\bthis (page|job|posting) (doesn'?t|does not) exist\b/i,
  // French — Quebec employers and Jooble's FR pages both surface these.
  /\bn'est plus (disponible|en ligne|affich|ouvert)/i,
  /\boffre (a expir|expir[ée]e|pourvue|est cl[ôo]tur|n'existe plus)/i,
  /\b(poste|emploi) (est )?(pourvu|combl[ée]|ferm[ée])\b/i,
  /\bpage introuvable\b/i,
]

// Reasons the page told us nothing, which must never be read as "dead".
// Checked BEFORE the dead patterns: a Cloudflare interstitial or a regional
// block can easily contain wording that trips one of them.
const INCONCLUSIVE_PATTERNS = [
  { re: /not available in your (region|country|location)/i, note: 'blocked in this region by the aggregator, not necessarily closed' },
  { re: /\b(checking your browser|verify (you are|yourself as) (a )?human|enable javascript and cookies|attention required|access denied|are you a robot)\b/i, note: 'bot check — the page would not load for an automated request' },
  { re: /\bcaptcha\b/i, note: 'captcha wall — could not read the page' },
  { re: /\byou need to enable javascript\b/i, note: 'page renders client-side; nothing readable in the HTML' },
]

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function titleOf(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  return m ? stripTags(m[1]) : ''
}

// A URL that identifies ONE posting, as opposed to a board or a search page.
// Used only to interpret a redirect: being bounced off a detail page onto a
// search page is how several aggregators say "gone" without saying it.
function looksLikeDetailUrl(url) {
  try {
    const path = new URL(url).pathname
    return (
      /\/(jdp|job|jobs|joblist|posting|postings|careers|opportunit|vacanc|position)s?\//i.test(path) ||
      /\/j\/[^/]+/i.test(path) ||
      /\/\d{5,}(?:\/|$)/.test(path) ||
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(path)
    )
  } catch {
    return false
  }
}

function looksLikeSearchUrl(url) {
  try {
    const u = new URL(url)
    if (u.pathname === '/' || u.pathname === '') return true
    return /(^|\/)(search|searchresult|results?|find|browse)(\/|$)/i.test(u.pathname)
  } catch {
    return false
  }
}

/**
 * Decide what a fetched response says about the posting.
 * Pure and exported so the rules can be exercised without network access.
 *
 * @param {object} r
 * @param {string} r.requestUrl  the URL we asked for
 * @param {string} [r.finalUrl]  where we ended up after redirects
 * @param {number} r.status      HTTP status (0 for a transport failure)
 * @param {string} [r.body]      response body, may be truncated
 * @returns {{status: 'live'|'dead'|'unknown', note: string|null}}
 */
export function classifyResponse({ requestUrl, finalUrl, status, body = '' }) {
  if (status === 404 || status === 410) {
    return { status: 'dead', note: `HTTP ${status} — the posting page is gone` }
  }
  // 401/403/405/429 are the site refusing us, not the employer closing the
  // role. 5xx is the site being broken. Neither is evidence about the job.
  if (status === 0) return { status: 'unknown', note: 'could not reach the page' }
  if (status >= 500) return { status: 'unknown', note: `HTTP ${status} — the site is erroring` }
  if (status === 401 || status === 403 || status === 405 || status === 429) {
    return { status: 'unknown', note: `HTTP ${status} — the site refused an automated request` }
  }
  if (status >= 400) return { status: 'unknown', note: `HTTP ${status}` }

  const title = titleOf(body)
  const head = `${title} ${stripTags(body).slice(0, HEAD_TEXT_CHARS)}`

  for (const { re, note } of INCONCLUSIVE_PATTERNS) {
    if (re.test(head)) return { status: 'unknown', note }
  }

  for (const re of DEAD_PATTERNS) {
    const m = head.match(re)
    if (m) return { status: 'dead', note: `the page says: "${m[0].trim().slice(0, 120)}"` }
  }

  // Bounced off the posting onto the board's search page — how Jooble and
  // several ATS mirrors handle a posting that has been taken down.
  if (
    finalUrl &&
    finalUrl !== requestUrl &&
    looksLikeDetailUrl(requestUrl) &&
    looksLikeSearchUrl(finalUrl)
  ) {
    return { status: 'dead', note: 'redirected off the posting onto a search page' }
  }

  // An essentially empty response body from a 200 tells us nothing — some
  // boards render entirely client-side.
  if (stripTags(body).length < 200) {
    return { status: 'unknown', note: 'the page returned almost no readable content' }
  }

  return { status: 'live', note: null }
}

/** Fetch one posting URL and classify it. Never throws. */
export async function checkLink(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { status: 'unknown', note: 'no usable URL on this posting' }
  }
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), timeoutMs)
  try {
    // GET, not HEAD: the whole point is reading the expiry banner, and plenty
    // of job boards answer HEAD with a 405 or a misleading 200 anyway.
    const res = await fetch(url, {
      redirect: 'follow',
      signal: control.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    })
    let body = ''
    try {
      body = (await res.text()).slice(0, MAX_BODY_CHARS)
    } catch {
      /* body unreadable — the status code still classifies most cases */
    }
    return classifyResponse({ requestUrl: url, finalUrl: res.url, status: res.status, body })
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `no response in ${Math.round(timeoutMs / 1000)}s` : err.message
    return { status: 'unknown', note: `could not reach the page (${reason})` }
  } finally {
    clearTimeout(timer)
  }
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'unknown-host'
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Check a list of postings, bounded in parallelism and paced per host.
 *
 * @param {Array<{id: string, url: string}>} postings
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.timeoutMs]
 * @param {(posting: object, result: object) => void} [opts.onResult]
 * @returns {Promise<Array<{posting: object, status: string, note: string|null}>>}
 */
export async function verifyLinks(postings, opts = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, timeoutMs = DEFAULT_TIMEOUT_MS, onResult } = opts
  const results = []
  const lastHit = new Map()
  let next = 0

  async function worker() {
    while (next < postings.length) {
      const posting = postings[next++]
      const host = hostOf(posting.url)
      // Space out same-host requests without stalling the other workers on
      // a different host.
      const wait = (lastHit.get(host) || 0) + PER_HOST_DELAY_MS - Date.now()
      lastHit.set(host, Date.now() + Math.max(0, wait))
      if (wait > 0) await sleep(wait)

      const result = await checkLink(posting.url, { timeoutMs })
      results.push({ posting, ...result })
      onResult?.(posting, result)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, postings.length) }, worker))
  return results
}

export { looksLikeDetailUrl, looksLikeSearchUrl }
