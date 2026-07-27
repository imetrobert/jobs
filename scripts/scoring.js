// Match scoring: how well does one posting fit the profile, and why.
//
// Scoring is BATCHED — several postings per LLM call. That is what keeps a
// full scan inside Gemini's free tier: 120 postings is ~24 requests at the
// default batch size, not 120. It also amortizes the profile (the largest part
// of the prompt) across every job in the batch instead of resending it each time.

import { generateJSON } from './llm.js'

export const BATCH_SIZE = Number(process.env.SCORE_BATCH_SIZE || 5)

// Structured-output schema. Note the deliberate absence of numeric
// minimum/maximum — the Claude structured-outputs validator rejects those —
// so the 0..100 bound is enforced in clampScore() below instead.
const ASSESSMENT = {
  type: 'object',
  properties: {
    ref: { type: 'integer', description: 'The JOB number this assessment is for.' },
    score: {
      type: 'integer',
      description: '0-100. How strong a candidate is this person for this specific role?',
    },
    tier: {
      type: 'string',
      enum: ['exceptional', 'strong', 'possible', 'stretch', 'poor'],
    },
    why_fit: {
      type: 'string',
      description:
        'Two to four sentences, addressed to the candidate as "you", naming the specific experience that maps to this role. Concrete, not flattering.',
    },
    gaps: {
      type: 'string',
      description:
        'The honest case against — what the role wants that the candidate lacks, or where they would be stretched. Empty string only if genuinely none.',
    },
    overqualification_risk: {
      type: 'string',
      description:
        'One of none/low/moderate/high, then a colon and one sentence. The risk of being screened out for being too senior, too expensive, or too experienced for this posting — separate from whether they could do the job.',
    },
    comp_assessment: {
      type: 'string',
      description:
        'One of above/at/below/unclear, then a colon and one sentence. Estimated TOTAL compensation (base + bonus + equity + benefits) against the candidate stated floor. Use "unclear" whenever pay is not disclosed — do not guess from the job title alone.',
    },
    ats_keywords_covered: {
      type: 'string',
      description:
        'Semicolon-separated. Terms this posting screens on that the candidate ALREADY evidences, written in the posting\'s exact wording. Max 12.',
    },
    ats_keywords_missing: {
      type: 'string',
      description:
        'Semicolon-separated. Terms this posting screens on that the candidate does NOT evidence, or evidences only in different words. Max 8. Empty string if none.',
    },
    pitch_angle: {
      type: 'string',
      description:
        'One sentence: the single strongest angle to lead with in a cover letter for this role.',
    },
    location_fit: {
      type: 'string',
      enum: ['remote_montreal', 'onsite_close', 'onsite_far', 'remote_unclear', 'not_montreal'],
      description:
        'Whether and how this candidate could physically work this role from Montreal. See LOCATION FIT in the system prompt for the exact categories.',
    },
  },
  required: [
    'ref',
    'score',
    'tier',
    'why_fit',
    'gaps',
    'overqualification_risk',
    'comp_assessment',
    'ats_keywords_covered',
    'ats_keywords_missing',
    'pitch_angle',
    'location_fit',
  ],
  additionalProperties: false,
}

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    assessments: { type: 'array', items: ASSESSMENT },
  },
  required: ['assessments'],
  additionalProperties: false,
}

const SENIORITY_RANK = {
  any: 0,
  senior: 1,
  manager: 2,
  director: 3,
  vp: 4,
  c_level: 5,
}

// Rough seniority read from the title. Used only to skip obviously-junior
// postings before spending an LLM call — never to reject on its own when the
// signal is ambiguous (unknown → keep, let the model judge).
export function titleSeniority(title = '') {
  const t = title.toLowerCase()
  if (/\b(chief|cto|cio|cmo|ceo|coo|cdo|caio|c-level)\b/.test(t)) return 'c_level'
  if (/\b(vp|vice[- ]president|svp|evp|head of)\b/.test(t)) return 'vp'
  if (/\b(director|dir\.)\b/.test(t)) return 'director'
  // "Lead" and "Principal" are deliberately NOT bucketed here: their scope
  // swings from senior-IC to director depending on the company, and guessing
  // wrong silently drops good roles. Left unknown so the model judges them.
  if (/\b(manager|mgr)\b/.test(t)) return 'manager'
  if (/\b(senior|sr\.?|staff)\b/.test(t)) return 'senior'
  if (/\b(junior|jr\.?|intern|internship|entry[- ]level|co[- ]op|graduate|apprentice|assistant|coordinator|associate|analyst i\b|technician)\b/.test(t)) {
    return 'junior'
  }
  return 'unknown'
}

// Cheap gate ahead of the LLM. Returns a reason string when the posting
// should be skipped, or null to score it. Every posting caught here is an LLM
// call not spent, which directly protects the free-tier quota.
export function prefilterReason(profile, posting) {
  const min = SENIORITY_RANK[profile.min_seniority ?? 'director'] ?? 3
  const seen = titleSeniority(posting.title)

  if (seen === 'junior' && min > 0) return 'below seniority floor'
  if (seen !== 'unknown' && SENIORITY_RANK[seen] !== undefined && SENIORITY_RANK[seen] < min) {
    return 'below seniority floor'
  }

  for (const bad of profile.deal_breakers || []) {
    const needle = String(bad).trim().toLowerCase()
    if (!needle) continue
    if (`${posting.title} ${posting.company} ${posting.description}`.toLowerCase().includes(needle)) {
      return `deal-breaker: ${bad}`
    }
  }

  // Geography: only reject when the posting is clearly non-remote AND names a
  // country the profile doesn't cover. Vague locations pass through.
  if (!posting.remote && posting.location) {
    const loc = posting.location.toLowerCase()
    const wanted = (profile.locations || []).map(l => l.toLowerCase())
    const coversCanada = wanted.some(l => /canada|montr|quebec|qc|toronto|ontario|remote/.test(l))
    const coversUS = wanted.some(l => /united states|usa|u\.s\.|north america|remote/.test(l))
    const looksUS = /\b(usa|united states|, [a-z]{2}$|california|texas|new york|florida)\b/.test(loc)
    const looksCanada = /canada|montr|quebec|qc|toronto|ontario|vancouver|calgary|ottawa|bc|alberta/.test(loc)
    if (looksCanada && !coversCanada) return 'location not targeted'
    if (looksUS && !looksCanada && !coversUS) return 'location not targeted'
  }

  return null
}

function clampScore(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, v))
}

function profileBlock(p) {
  const lines = [
    p.headline && `Headline: ${p.headline}`,
    p.years_experience && `Years of experience: ${p.years_experience}`,
    p.location && `Based in: ${p.location}`,
    p.summary && `Summary: ${p.summary}`,
    p.target_titles?.length && `Target roles: ${p.target_titles.join('; ')}`,
    p.target_industries?.length && `Preferred industries: ${p.target_industries.join('; ')}`,
    p.locations?.length && `Acceptable locations: ${p.locations.join('; ')}`,
    p.remote_ok ? 'Open to fully remote work.' : 'Prefers on-site or hybrid.',
    // Total comp is the bar, not base. Stated explicitly so the scorer doesn't
    // read the number as a base-salary requirement and reject a role whose
    // package clears the floor on a lower base.
    (p.min_total_comp || p.min_salary) &&
      `TOTAL COMPENSATION FLOOR: ${p.min_total_comp || p.min_salary} ${p.salary_currency || 'CAD'} per year, counting base plus bonus, employer pension/retirement contributions, benefits and any equity. Base salary alone does NOT need to reach this figure.`,
    p.comp_components &&
      `What counts toward that total, per the candidate: ${p.comp_components}`,
    p.min_base_salary &&
      `Hard floor on base salary alone: ${p.min_base_salary} ${p.salary_currency || 'CAD'}.`,
    p.must_haves?.length && `Must have: ${p.must_haves.join('; ')}`,
    p.deal_breakers?.length && `Deal breakers: ${p.deal_breakers.join('; ')}`,
  ].filter(Boolean)

  let out = lines.join('\n')
  if (p.resume_text) out += `\n\n--- RESUME ---\n${p.resume_text}`
  return out
}

function postingBlock(job, maxDesc) {
  const hasFigure = job.salary_min || job.salary_max
  const salary = !hasFigure
    ? 'Salary: not disclosed in the posting.'
    : job.salary_predicted
      // Adzuna infers a figure when the employer published none. Labelling it
      // plainly stops the scorer from reporting a guess as a disclosed range.
      ? `Salary: NOT disclosed by the employer. The aggregator's statistical estimate is ${job.salary_min ?? '?'}–${job.salary_max ?? '?'} ${job.salary_currency || ''}, which is a guess, not a published figure.`
      : `Salary (base, as published): ${job.salary_min ?? '?'}–${job.salary_max ?? '?'} ${job.salary_currency || ''}`
  return [
    `Title: ${job.title}`,
    job.company && `Company: ${job.company}`,
    job.location && `Location: ${job.location}`,
    job.remote ? 'Remote: yes' : null,
    salary,
    '',
    // Descriptions from aggregators run long; the tail is usually boilerplate
    // (EEO statements, benefits) that costs tokens without adding signal.
    (job.description || '').slice(0, maxDesc),
  ]
    .filter(Boolean)
    .join('\n')
}

// The seniority guidance below is the substantive part of this prompt. A
// deeply experienced candidate faces a failure mode that has nothing to do
// with capability: being screened out as too senior, too expensive, or assumed
// out of date. Scoring that ignores this produces a list of roles he is
// perfectly able to do and would never be called for — which is worse than
// useless when the goal is knowing where to spend limited application effort.
const SYSTEM = `You are an experienced executive recruiter assessing whether one specific candidate should apply to specific jobs.

Be calibrated and honest. This assessment is read only by the candidate, and its usefulness depends entirely on it being trustworthy — a list where everything scores 85 is worthless. Most postings are a mediocre fit; say so. Reserve high scores for roles where this candidate would genuinely be a leading applicant.

Scoring guide:
  90-100 exceptional - the role reads as though it were written for them
  75-89  strong      - clearly qualified, would likely get an interview
  55-74  possible    - plausible fit, but they are one of many candidates
  35-54  stretch     - missing something material; a long shot
  0-34   poor        - wrong level, wrong field, or wrong location

Judge against the candidate's actual evidenced experience, not job-title keyword overlap. A posting that merely repeats their buzzwords but sits at the wrong seniority is a poor fit, not a strong one. Weigh seniority, domain, scope of ownership, and location fit. Never invent experience the candidate has not described.

SENIORITY AND DEPTH OF EXPERIENCE

This candidate is late-career with deep tenure. Handle that precisely, because it cuts both ways and the distinction is the most useful thing you can tell them:

- Never treat long tenure or a long career as a defect in the "score". Depth of experience is an asset for roles with real scope: P&L, org building, transformation mandates, board-facing work, and anything where having actually done it before is the point.
- Do treat it as a real SCREENING risk, and report that separately in "overqualification_risk". A candidate can be entirely able to do a job and still never get called because the hiring team reads them as too senior, too expensive, or a flight risk. That is a distinct question from fit, and it belongs in its own field — never buried in the score.
- Score the role's actual scope, not its title inflation. A "Director" role owning a large org may be a better fit than a "VP" title at a small company.
- Watch for postings that signal a preference for early-career candidates — heavy emphasis on "fast-paced/high-energy", a narrow years-of-experience ceiling, "digital native", or compensation well below the candidate's floor. Note these in overqualification_risk, not in gaps.
- Currency beats chronology. If the candidate's recent work is in a current, in-demand area, weigh that heavily: it is the strongest available counter to any assumption that a long career means dated skills. Say so explicitly in pitch_angle when it applies.
- In "gaps", stick to genuine capability or domain gaps. Do not list "may be seen as overqualified" there — that is what overqualification_risk is for.

Format "overqualification_risk" as one of none/low/moderate/high, then a colon, then one sentence of reasoning. Example: "moderate: the posting caps at 10 years of experience and the band is likely below your floor, so expect resume screening to filter you before a human reads it."

COMPENSATION

The candidate's floor is on TOTAL compensation, not base salary. Judge the whole package:

- Base salary alone does NOT need to reach the floor. A posting advertising a base below it can still clear the floor once target bonus, employer pension or retirement contributions, benefits and any equity are counted. Never call a role "below" purely because its base is under the number.
- Where a base range is published, reason explicitly about what the total package plausibly reaches at that level, in that industry, in that country. State the rough total you arrived at.
- Where pay is NOT disclosed — which is most postings, and always the case when the figure is flagged as an aggregator estimate rather than a published one — answer "unclear". Do not infer a number from the job title. "unclear" is a perfectly good answer and by far the most common one; treat guessing as the error, not as diligence.
- Watch for signals that change the total: an explicit bonus target percentage, equity or RSUs, a pension or matching scheme, a company stage where equity carries real or negligible value, and public-sector or non-profit employers where the band is usually fixed and disclosed.
- Currency matters. Compare like with like and say so if a US-dollar figure is what makes a role clear a Canadian-dollar floor.
- NEVER let compensation change the "score". Score is about fit. If a role fits superbly but pays below the floor, that is a high score with a "below" comp_assessment — not a depressed score. The candidate decides what to do with that.

Format "comp_assessment" as one of above/at/below/unclear, then a colon, then one sentence. Examples: "above: the published 140-165k base plus a stated 20% target bonus and pension puts total well past your floor." / "unclear: no pay disclosed, and nothing in the posting indicates the band."

LOCATION FIT

The candidate lives in Côte Saint-Luc, on the west-central part of the Island of Montreal. This is a hard requirement, separate from the score: classify "location_fit" as exactly one of:

- "remote_montreal" — genuinely fully remote, AND you are CONFIDENT a candidate based in Montreal/Quebec/Canada is eligible. The employer's own office location is irrelevant — a US, European, or fully distributed company is fine as long as a Canadian remote employee is actually permitted. Confidence can come from an explicit statement ("remote — Canada", "remote — North America", "we hire from anywhere") or from the posting simply having no geography-specific hiring language anywhere — no named country, no state list, no domestic-only legal boilerplate. Reserve this tier for a genuine yes, not a shrug.
- "onsite_close" — requires physical presence (hybrid or fully on-site) at a location within roughly 10km of Côte Saint-Luc. Treat Côte Saint-Luc itself, NDG, Hampstead, Montreal West, Snowdon, the Town of Mount Royal, Westmount, Saint-Laurent, Lachine, and the West Island suburbs (Dorval, Pointe-Claire, Kirkland, Dollard-des-Ormeaux, Beaconsfield) as close.
- "onsite_far" — requires physical presence somewhere in the greater Montreal area, but more than roughly 10km from Côte Saint-Luc: downtown Montreal, Old Montreal, the Plateau, Griffintown, Verdun, Rosemont, Hochelaga, and off-island suburbs (Laval, Longueuil, Brossard, Terrebonne, Vaudreuil-Dorion, Repentigny) all count as far, even though they are still commutable.
- "remote_unclear" — genuinely remote, but you cannot confidently place it in either "remote_montreal" or "not_montreal". Use this for the middle ground: signals exist but don't add up to a clear yes or a clear no, or the posting is only ambiguously US-leaning (mentions one US city as "location" without saying whether that's a hard requirement or just where the team happens to sit, say). This tier exists so you never have to guess a binary answer you don't actually have evidence for.
- "not_montreal" — no way to do this job from Montreal at all. This is the confident-no case: either the office is outside the greater Montreal area with no remote option, or the remote posting is confidently restricted elsewhere. For the latter, watch for tells even when the posting never says "US only" outright: "must be authorized to work in the United States without sponsorship", a requirement to reside in one or more named US states, pay stated only as a US salary band with US-specific benefits (401(k), US federal holidays), EEO/OFCCP/E-Verify boilerplate (US-specific legal language), or references to needing a US Social Security Number or I-9. Any one of those, unless the posting separately and explicitly welcomes Canadian/international candidates anyway, is a confident no — use "not_montreal", not "remote_unclear" (this posting does offer a clear answer, it's just "no"), and not the discipline of guessing "remote_montreal" out of charity.

So for any remote posting, ask two questions in order: (1) is there a clear reason to say no (a real restriction, explicit or implied)? If yes → "not_montreal". (2) If not, is there enough — explicit welcome, or genuine silence with zero geography language — to say yes with real confidence? If yes → "remote_montreal". If neither question resolves cleanly, that is exactly what "remote_unclear" is for: don't force it into whichever of the other two feels safer.

If a non-remote posting's location isn't stated clearly, judge from context (company HQ, named office city) and prefer "onsite_far" over guessing "close" if it's genuinely unresolvable — the cost of ranking a role slightly too low is much smaller than the cost of ranking an out-of-reach one too high. This field never affects "score" — a role can score 90 for fit and still be "not_montreal" or "remote_unclear"; these are independent judgments and all of them must be honest.

APPLICANT-TRACKING KEYWORDS

Most applications are parsed by software that ranks on term overlap with the posting before any person reads them. Extract the terms this posting would screen on and sort them by whether the candidate can actually back them.

- Pull the terms from the posting's own wording: named skills, methodologies, platforms, certifications, domain nouns, and scope phrases ("P&L ownership", "stakeholder management", "go-to-market"). Prefer multi-word phrases as they appear; skip generic filler like "team player" or "fast-paced".
- Put a term in "ats_keywords_covered" only when the candidate's resume genuinely evidences it — including when they clearly did the thing but described it in different words. Write it in the POSTING's wording, since that is what gets matched.
- Put a term in "ats_keywords_missing" when the candidate does not evidence it at all, or where the evidence is too thin to claim honestly. Being in this list is information for the candidate, not something to be papered over.
- Judge substance, not vocabulary. If they ran the function under a different label, that is covered. If they have never done it, it is missing no matter how adjacent it looks.
- Never pad either list to reach the maximum. Fewer, accurate terms are far more useful than a long list.`

// Keyword lists arrive as free text and vary in shape between models: sometimes
// semicolon-separated, sometimes an array, sometimes comma-separated. Normalize
// to a single semicolon-delimited string so the UI can aggregate across matches
// without re-parsing per model.
function cleanTerms(value) {
  const raw = Array.isArray(value) ? value.join(';') : String(value || '')
  const seen = new Set()
  const terms = []
  for (const part of raw.split(/[;\n]+/)) {
    const term = part.replace(/^[\s\-*•]+/, '').replace(/\s+/g, ' ').trim()
    // Guard against a model returning a sentence instead of a term list.
    if (!term || term.length > 60) continue
    // Dedupe case-insensitively but keep the original casing — these are
    // rendered to the user and fed back as the employer's own wording.
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }
  return terms.length ? terms.join('; ') : null
}

const LOCATION_FITS = ['remote_montreal', 'onsite_close', 'onsite_far', 'remote_unclear', 'not_montreal']

function parseAssessment(raw, job) {
  let score = clampScore(raw?.score)
  const validTiers = ['exceptional', 'strong', 'possible', 'stretch', 'poor']
  let tier = String(raw?.tier || '').toLowerCase()
  if (!validTiers.includes(tier)) {
    // Gemini has no schema enforcement, so derive the tier from the score
    // rather than failing the row on a malformed label.
    tier =
      score >= 90 ? 'exceptional'
      : score >= 75 ? 'strong'
      : score >= 55 ? 'possible'
      : score >= 35 ? 'stretch'
      : 'poor'
  }

  const locationFit = LOCATION_FITS.includes(raw?.location_fit) ? raw.location_fit : null
  let gaps = String(raw?.gaps || '').trim()

  // Not workable from Montreal is a hard exclusion, same treatment as a
  // deal-breaker caught in prefilterReason: force the row out of the
  // score >= 35 view instead of letting a strong fit score outrank it.
  if (locationFit === 'not_montreal') {
    score = 0
    tier = 'poor'
    gaps = [gaps, 'Filtered: no way to do this role from Montreal (not remote-eligible, and the office is outside the greater Montreal area).']
      .filter(Boolean)
      .join(' ')
  }

  return {
    posting_id: job.id,
    score,
    tier,
    why_fit: String(raw?.why_fit || '').trim(),
    gaps,
    overqualification_risk: String(raw?.overqualification_risk || '').trim() || null,
    comp_assessment: String(raw?.comp_assessment || '').trim() || null,
    ats_keywords_covered: cleanTerms(raw?.ats_keywords_covered),
    ats_keywords_missing: cleanTerms(raw?.ats_keywords_missing),
    pitch_angle: String(raw?.pitch_angle || '').trim(),
    location_fit: locationFit,
  }
}

/**
 * Score a batch of postings in one LLM call.
 * Returns an array of verdicts; postings the model failed to return an
 * assessment for are simply absent, so they stay unscored and get retried
 * on the next run rather than being written with a bogus score.
 */
export async function scoreJobBatch(profile, jobs) {
  if (!jobs.length) return []

  const maxDesc = jobs.length > 1 ? 2500 : 6000
  const jobsText = jobs
    .map((j, i) => `### JOB ${i + 1}\n${postingBlock(j, maxDesc)}`)
    .join('\n\n')

  const prompt = `## CANDIDATE\n${profileBlock(profile)}\n\n## POSTINGS TO ASSESS\n${jobsText}\n\nAssess this candidate against ${
    jobs.length === 1 ? 'this posting' : `each of these ${jobs.length} postings independently`
  }. Return one assessment object per posting, each with "ref" set to its JOB number. Assess every posting; do not skip any.`

  const { data, model } = await generateJSON({
    system: SYSTEM,
    prompt,
    schema: BATCH_SCHEMA,
    effort: 'low',
  })

  // Accept either the wrapped object or a bare array — Gemini sometimes
  // returns the array directly despite the schema in the prompt.
  const list = Array.isArray(data) ? data : data?.assessments
  if (!Array.isArray(list)) throw new Error('Scorer did not return an assessments array')

  const out = []
  for (const raw of list) {
    const idx = Number(raw?.ref) - 1
    // Fall back to positional matching if `ref` is missing or nonsense, but
    // only when the counts line up — otherwise verdicts land on wrong jobs.
    const job =
      Number.isInteger(idx) && idx >= 0 && idx < jobs.length
        ? jobs[idx]
        : list.length === jobs.length
          ? jobs[out.length]
          : null
    if (!job) continue
    out.push({ ...parseAssessment(raw, job), model })
  }
  return out
}

/** Single-posting convenience wrapper, used for re-scoring one job. */
export async function scoreJob(profile, job) {
  const [verdict] = await scoreJobBatch(profile, [job])
  if (!verdict) throw new Error('Scorer returned no assessment')
  return verdict
}

export { profileBlock, postingBlock }
