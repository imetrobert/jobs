// Job feed adapters.
//
// Every adapter returns a flat array of postings in one shape:
//   { source, source_id, title, company, location, remote, url, description,
//     salary_min, salary_max, salary_currency, salary_predicted, posted_at }
//
// `salary_predicted` matters: Adzuna fills in an ESTIMATED salary when the
// employer didn't publish one. Treating that as a disclosed figure would give
// false confidence to the total-compensation assessment downstream, so it is
// carried through and reported as "not disclosed" rather than as a real number.
//
// Deliberately NOT here: LinkedIn and Indeed scraping. Both block automated
// access (LinkedIn answers 403 to anything without a session) and forbid it
// in their terms. Anything built on that breaks within weeks and puts your
// name on a ToS complaint while you're job hunting. The adapters below read
// either a documented API or a public ATS endpoint the vendor publishes for
// exactly this purpose — and because LinkedIn/Indeed are themselves
// aggregating these same ATS feeds, the coverage overlap is high and the
// ATS copy is usually fresher.

const UA = 'imetrobert-job-matcher/1.0'

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) {
    // Include the provider's own explanation. A bare "400 Bad Request" says
    // nothing about WHICH parameter it objected to, which turns a one-line fix
    // into a guessing game.
    let detail = ''
    try {
      detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300)
    } catch {
      /* body already consumed or unreadable — status alone will have to do */
    }
    throw new Error(
      `${res.status} ${res.statusText} for ${url.split('?')[0]}${detail ? ` — ${detail}` : ''}`
    )
  }
  return res.json()
}

function stripHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function looksRemote(text) {
  return /\b(remote|work from home|télétravail|teletravail|distributed|anywhere)\b/i.test(text || '')
}

// ---------------------------------------------------------------------
// Adzuna — documented, self-serve, free tier (~1k calls/month).
// Docs: https://developer.adzuna.com/
// `token` on the source row is the country code ('ca', 'us').
// ---------------------------------------------------------------------
export async function fetchAdzuna({ token = 'ca', queries, maxPages = 1, env }) {
  const { ADZUNA_APP_ID, ADZUNA_APP_KEY } = env
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error('ADZUNA_APP_ID / ADZUNA_APP_KEY not set')
  }
  const out = []
  for (const q of queries) {
    for (let page = 1; page <= maxPages; page++) {
      // Only documented parameters. `content_type` used to be sent here and is
      // not one — Adzuna spells it `content-type`, and rejects the whole
      // request with a 400 rather than ignoring the unknown key. JSON is the
      // default for this endpoint anyway, so it is simply gone.
      const params = new URLSearchParams({
        app_id: ADZUNA_APP_ID,
        app_key: ADZUNA_APP_KEY,
        results_per_page: '50',
        what: q,
        max_days_old: '45',
        sort_by: 'date',
      })
      const url = `https://api.adzuna.com/v1/api/jobs/${token}/search/${page}?${params}`
      let data
      try {
        data = await getJSON(url)
      } catch (err) {
        // One bad query shouldn't kill the whole source.
        console.warn(`  adzuna[${token}] "${q}" p${page}: ${err.message}`)
        break
      }
      const results = data?.results || []
      for (const r of results) {
        const desc = stripHtml(r.description)
        out.push({
          source: `adzuna:${token}`,
          source_id: String(r.id),
          title: r.title ? stripHtml(r.title) : '',
          company: r.company?.display_name || null,
          location: r.location?.display_name || null,
          remote: looksRemote(`${r.title} ${r.location?.display_name} ${desc}`),
          url: r.redirect_url || null,
          description: desc,
          salary_min: r.salary_min ?? null,
          salary_max: r.salary_max ?? null,
          salary_currency: token === 'us' ? 'USD' : 'CAD',
          // Adzuna sets this to "1" when it inferred the figure rather than
          // reading it off the posting.
          salary_predicted: String(r.salary_is_predicted ?? '0') === '1',
          posted_at: r.created || null,
        })
      }
      if (results.length < 50) break
    }
  }
  return out
}

// ---------------------------------------------------------------------
// Jooble — free API key on request. POST /api/{key}.
// Docs: https://jooble.org/api/about
// ---------------------------------------------------------------------
export async function fetchJooble({ queries, locations, env }) {
  const { JOOBLE_API_KEY } = env
  if (!JOOBLE_API_KEY) throw new Error('JOOBLE_API_KEY not set')
  const out = []
  for (const q of queries) {
    for (const loc of locations.length ? locations : ['']) {
      let data
      try {
        const res = await fetch(`https://jooble.org/api/${JOOBLE_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ keywords: q, location: loc, page: '1' }),
        })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        data = await res.json()
      } catch (err) {
        console.warn(`  jooble "${q}" @ "${loc}": ${err.message}`)
        continue
      }
      for (const r of data?.jobs || []) {
        const desc = stripHtml(r.snippet)
        out.push({
          source: 'jooble',
          source_id: String(r.id ?? r.link),
          title: stripHtml(r.title || ''),
          company: r.company || null,
          location: r.location || null,
          remote: looksRemote(`${r.title} ${r.location} ${desc}`),
          url: r.link || null,
          description: desc,
          salary_min: null,
          salary_max: null,
          salary_currency: null,
          posted_at: r.updated || null,
        })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------
// Remotive — free, public, no API key at all. 100% remote-jobs board, so
// every posting is remote by definition; `candidate_required_location` is
// often an explicit eligibility statement ("USA Only", "Canada", "Worldwide"),
// which is exactly the kind of quotable evidence the Montreal-eligibility
// scoring looks for. Docs: https://github.com/remotive-com/remote-jobs-api
// ---------------------------------------------------------------------
export async function fetchRemotive({ queries, env }) {
  const out = []
  const seen = new Set()
  for (const q of queries) {
    let data
    try {
      data = await getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`)
    } catch (err) {
      console.warn(`  remotive "${q}": ${err.message}`)
      continue
    }
    for (const r of data?.jobs || []) {
      const id = String(r.id)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        source: 'remotive',
        source_id: id,
        title: r.title || '',
        company: r.company_name || null,
        // The board's own eligibility statement when it states one, not a
        // physical office — this IS the "Location" field the scorer reads.
        location: r.candidate_required_location || null,
        remote: true,
        url: r.url || null,
        description: stripHtml(r.description),
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        posted_at: r.publication_date || null,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------
// JSearch (OpenWeb Ninja, via RapidAPI) — OPTIONAL, paid beyond a small
// free tier. This is the one adapter that surfaces LinkedIn/Indeed-sourced
// rows, because JSearch resells Google-for-Jobs results. Enabled only if
// JSEARCH_RAPIDAPI_KEY is set; the scan skips it silently otherwise.
// ---------------------------------------------------------------------
export async function fetchJSearch({ queries, env }) {
  const { JSEARCH_RAPIDAPI_KEY } = env
  if (!JSEARCH_RAPIDAPI_KEY) throw new Error('JSEARCH_RAPIDAPI_KEY not set')
  const out = []
  for (const q of queries) {
    const params = new URLSearchParams({
      query: q,
      page: '1',
      num_pages: '1',
      date_posted: 'month',
    })
    let data
    try {
      data = await getJSON(`https://jsearch.p.rapidapi.com/search?${params}`, {
        headers: {
          'X-RapidAPI-Key': JSEARCH_RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
      })
    } catch (err) {
      console.warn(`  jsearch "${q}": ${err.message}`)
      continue
    }
    for (const r of data?.data || []) {
      out.push({
        source: `jsearch:${r.job_publisher || 'unknown'}`,
        source_id: String(r.job_id),
        title: r.job_title || '',
        company: r.employer_name || null,
        location: [r.job_city, r.job_state, r.job_country].filter(Boolean).join(', ') || null,
        remote: Boolean(r.job_is_remote),
        url: r.job_apply_link || null,
        description: stripHtml(r.job_description),
        salary_min: r.job_min_salary ?? null,
        salary_max: r.job_max_salary ?? null,
        salary_currency: r.job_salary_currency || null,
        posted_at: r.job_posted_at_datetime_utc || null,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------
// ATS boards. These are the public JSON endpoints each vendor publishes so
// companies can embed their own careers page — free, no key, no scraping,
// and the authoritative copy of the posting.
// `token` is the company's board slug.
// ---------------------------------------------------------------------
export async function fetchGreenhouse({ token, label }) {
  const data = await getJSON(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
  )
  return (data?.jobs || []).map(j => ({
    source: `greenhouse:${token}`,
    source_id: String(j.id),
    title: j.title || '',
    company: label || token,
    location: j.location?.name || null,
    remote: looksRemote(`${j.title} ${j.location?.name}`),
    url: j.absolute_url || null,
    description: stripHtml(j.content),
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    posted_at: j.updated_at || null,
  }))
}

export async function fetchLever({ token, label }) {
  const data = await getJSON(
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
  )
  return (Array.isArray(data) ? data : []).map(j => ({
    source: `lever:${token}`,
    source_id: String(j.id),
    title: j.text || '',
    company: label || token,
    location: j.categories?.location || null,
    remote: looksRemote(`${j.text} ${j.categories?.location} ${j.workplaceType}`),
    url: j.hostedUrl || j.applyUrl || null,
    description: stripHtml(j.descriptionPlain || j.description),
    salary_min: j.salaryRange?.min ?? null,
    salary_max: j.salaryRange?.max ?? null,
    salary_currency: j.salaryRange?.currency || null,
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }))
}

export async function fetchAshby({ token, label }) {
  const data = await getJSON(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`
  )
  return (data?.jobs || []).map(j => ({
    source: `ashby:${token}`,
    source_id: String(j.id),
    title: j.title || '',
    company: label || data?.name || token,
    location: j.location || null,
    remote: Boolean(j.isRemote) || looksRemote(`${j.title} ${j.location}`),
    url: j.jobUrl || j.applyUrl || null,
    description: stripHtml(j.descriptionHtml || j.descriptionPlain),
    salary_min: j.compensation?.scrapeableCompensationSalarySummary ? null : null,
    salary_max: null,
    salary_currency: null,
    posted_at: j.publishedAt || null,
  }))
}

// SmartRecruiters — free, public, no key. Docs: developers.smartrecruiters.com.
// Real customers include Visa, Bosch and Skechers.
//
// The list endpoint (verified against a live response) carries only
// metadata — no description — so each posting needs a second call to the
// single-posting endpoint for the actual text. That makes this adapter
// N+1 requests instead of 1, unlike Greenhouse/Lever/Ashby; there's no
// documented rate limit, and a thin description on one bad detail fetch
// shouldn't sink the rest of the board, so failures there are per-posting.
export async function fetchSmartRecruiters({ token, label }) {
  const list = await getJSON(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`
  )
  const out = []
  for (const j of list?.content || []) {
    let desc = ''
    try {
      const detail = await getJSON(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${encodeURIComponent(j.id)}`
      )
      desc = detail?.jobAd?.sections?.jobDescription?.text || ''
    } catch (err) {
      console.warn(`  smartrecruiters:${token} #${j.id} detail: ${err.message}`)
    }
    out.push({
      source: `smartrecruiters:${token}`,
      source_id: String(j.id),
      title: j.name || '',
      company: label || j.company?.name || token,
      location:
        [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', ') ||
        null,
      remote: Boolean(j.location?.remote) || looksRemote(`${j.name} ${j.location?.city}`),
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(label || token)}/${j.id}`,
      description: stripHtml(desc),
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      posted_at: j.releasedDate || null,
    })
  }
  return out
}

// Workable — free, public widget API, no key.
//
// Same shape as SmartRecruiters above: the list endpoint (verified) has no
// description even with details=true, so each job needs a second call to
// its own endpoint for the real text.
export async function fetchWorkable({ token, label }) {
  const list = await getJSON(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`
  )
  const out = []
  for (const j of list?.jobs || []) {
    let desc = ''
    if (j.shortcode) {
      try {
        const detail = await getJSON(
          `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}/jobs/${encodeURIComponent(j.shortcode)}`
        )
        desc = [detail?.description, detail?.requirements, detail?.benefits]
          .filter(Boolean)
          .join('\n\n')
      } catch (err) {
        console.warn(`  workable:${token} #${j.shortcode} detail: ${err.message}`)
      }
    }
    out.push({
      source: `workable:${token}`,
      source_id: String(j.shortcode || j.title),
      title: j.title || '',
      company: label || list?.name || token,
      location: [j.city, j.state || j.region, j.country].filter(Boolean).join(', ') || null,
      remote: Boolean(j.telecommuting) || looksRemote(`${j.title} ${j.city}`),
      url: j.url || (j.shortcode ? `https://apply.workable.com/${token}/j/${j.shortcode}/` : null),
      description: stripHtml(desc),
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      posted_at: j.published_on || null,
    })
  }
  return out
}

export const ADAPTERS = {
  adzuna: fetchAdzuna,
  jooble: fetchJooble,
  remotive: fetchRemotive,
  jsearch: fetchJSearch,
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
  ashby: fetchAshby,
}

export { stripHtml, looksRemote }
