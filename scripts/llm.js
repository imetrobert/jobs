// LLM layer for match scoring and application drafting.
//
// GEMINI IS THE PRIMARY AND ONLY REQUIRED PROVIDER. It uses the same
// GEMINI_API_KEY the blog pipeline already has, and the whole system is sized
// to run inside Gemini's free tier — see the pacing and batching below.
//
// Claude is an optional upgrade, off unless ANTHROPIC_API_KEY is set. It is
// called over plain fetch so there is no Anthropic package in the dependency
// tree: nothing here requires a Claude subscription, a Claude Code seat, or
// any paid Anthropic account to install, run, or maintain.
//
// Override the choice with LLM_PROVIDER=gemini|claude.

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5'

// Model selection: PINNED chain, Lite-first — do not go back to asking the
// key what it can call and ranking newest first. That ranking caused the
// Oct 25, 2026 scan failure, and the research behind this chain (Oct 25,
// 2026) explains why: on the free tier a full Flash model gives roughly
// 20 requests/day — less than one weekly scan (24 calls) — while a Lite
// model gives roughly 500/day, and the newest Flash is also the model most
// likely to 503 under load. Chasing "newest Flash first" picks the smallest
// quota pool and the most congested model first.
//
// Never pin these, however tempting an old guide looks: gemini-3.5-flash
// and gemini-3.7-flash were deprecated Oct 8, 2026 and are silently routed
// to 3.6/3.8 (the name you pin is not the model answering); gemini-2.0
// was retired Jun 1, 2026; gemini-2.5 is access-limited since Sep 18, 2026
// to past users, and ListModels still lists models a new project cannot
// call — which is exactly why discovery is not trusted in the hot path.
//
// Google no longer publishes per-model free-tier numbers; AI Studio's
// per-project page is the only official source. The figures above are
// measured (Sep/Oct 2026, new free key), not official, and they vary by
// project — treat them as the reason for Lite-first, not as exact quotas.
//
// Staying on the best model as things change: this chain is the default,
// not a tombstone. Change it without a code edit through GEMINI_MODEL_CHAIN
// (comma-separated, in fallback order). A future scheduled canary may
// RECOMMEND a new chain by probing candidates with real calls — discovery
// alone never proves a model works — but promotion is always a reviewed
// config change, never silent auto-switching in the scoring path.
const DEFAULT_GEMINI_CHAIN = [
  'gemini-3.5-flash-lite', // primary — the free-tier workhorse
  'gemini-3.1-flash-lite', // second, separate ~500/day quota pool
  'gemini-3.8-flash', // only if a Lite model fails for a non-quota reason
  'gemini-3.6-flash', // last Flash pool
  'gemini-flash-lite-latest', // emergency-only alias; log the resolved modelVersion
]

// An explicit GEMINI_MODEL always wins (single model, no chain).
// Otherwise GEMINI_MODEL_CHAIN overrides the default chain; otherwise the
// default chain above is used. Discovery via ListModels is deliberately
// NOT consulted here: it lists models the project cannot call (2.5) and
// says nothing about quota pools or overload.
async function geminiModelsToTry() {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL]
  if (process.env.GEMINI_MODEL_CHAIN) {
    const chain = process.env.GEMINI_MODEL_CHAIN.split(',').map(s => s.trim()).filter(Boolean)
    if (chain.length) return chain
  }
  return DEFAULT_GEMINI_CHAIN
}

// Free-tier pacing. Gemini's free tier is limited per minute AND per day, and
// the per-minute limit is the one that bites during a scan. Requests are
// serialized through a single queue with a minimum gap between them.
//
// Default 8/min sits deliberately under a typical Gemini flash model's free-tier
// ceiling of ~10 requests/minute. Running at or above the ceiling still "works" — the
// backoff below absorbs the 429s — but it turns most requests into a retry and
// makes a two-minute scan take ten. Slower pacing is faster overall here.
// Google sets these per project and no longer publishes one universal table;
// check AI Studio for yours, and raise this only on a paid tier.
const GEMINI_RPM = Number(process.env.GEMINI_RPM || 8)
const MIN_GAP_MS = Math.ceil(60_000 / Math.max(1, GEMINI_RPM))
const MAX_RETRIES = 2

// Thrown when the daily quota is gone. The scan catches this and stops
// cleanly with partial results saved, rather than burning the remaining
// postings against a wall.
export class QuotaExhaustedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QuotaExhaustedError'
  }
}

export function activeProvider(env = process.env) {
  const forced = (env.LLM_PROVIDER || '').toLowerCase()
  if (forced === 'claude') return env.ANTHROPIC_API_KEY ? 'claude' : null
  if (forced === 'gemini') return env.GEMINI_API_KEY ? 'gemini' : null
  if (env.ANTHROPIC_API_KEY) return 'claude'
  if (env.GEMINI_API_KEY) return 'gemini'
  return null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Serial queue: every provider call goes through here, so concurrency
// upstream can never outrun the rate limit.
let _chain = Promise.resolve()
let _lastCallAt = 0
function paced(fn) {
  const run = async () => {
    const wait = _lastCallAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    _lastCallAt = Date.now()
    return fn()
  }
  _chain = _chain.then(run, run)
  return _chain
}

// ---------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------
function stripFence(s) {
  return String(s)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

// A Gemini 429 body is mostly a boilerplate paragraph of documentation links,
// and the one useful fact — WHICH quota ran out, and what its limit was — sits
// past it in a `details` array. Truncating the raw text cuts off exactly the
// part worth reading, so pull the quota facts out first.
function summarizeQuotaError(raw) {
  try {
    const parsed = JSON.parse(raw)
    const details = parsed?.error?.details || []
    const bits = []
    for (const d of details) {
      for (const v of d.violations || []) {
        const name = v.quotaId || v.quotaMetric || 'unknown quota'
        bits.push(v.quotaValue ? `${name} (limit ${v.quotaValue})` : name)
      }
      if (d.retryDelay) bits.push(`retry after ${d.retryDelay}`)
    }
    if (bits.length) return `exceeded ${bits.join('; ')}`
    if (parsed?.error?.message) {
      return parsed.error.message.split('. ')[0].replace(/\s+/g, ' ').slice(0, 200)
    }
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return String(raw).replace(/\s+/g, ' ').slice(0, 300)
}

async function geminiOnce(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 429) {
    // Carry Google's own wording through, and never let a 429 abort the
    // whole scan on its own — a per-minute limit clears in seconds and is
    // always worth retrying. The one thing worth distinguishing is a
    // per-DAY violation specifically, which retrying cannot fix: without
    // this, a model whose free tier caps at (say) 20 requests/day gets
    // re-tried and re-backed-off on every single batch for the rest of the
    // run, each one burning ~15s before falling through — 24 batches turns
    // a 3-minute scoring pass into 10+ minutes of pure retry overhead.
    const raw = await res.text()
    const err = new Error(`429 from ${model}: ${summarizeQuotaError(raw)}`)
    err.retryable = true
    err.dailyExhausted = /PerDay/i.test(raw)
    throw err
  }
  if (res.status >= 500) {
    const err = new Error(`${model} returned ${res.status}`)
    err.retryable = true
    err.is5xx = true
    throw err
  }
  if (!res.ok) {
    throw new Error(`Gemini ${res.status} on ${model}: ${(await res.text()).slice(0, 200)}`)
  }

  const json = await res.json()
  const text = (json?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('')
  if (!text.trim()) throw new Error(`Gemini returned empty text on ${model}`)
  return { text, model }
}

// Models found to be out of daily quota THIS PROCESS. A fresh scan (a new
// GitHub Actions run) starts with this empty again — it's not persisted
// anywhere, and doesn't need to be: it only exists to stop one model from
// being retried 24 times in the same run once its daily wall is already known.
const _dailyExhausted = new Set()

async function geminiCall(body) {
  let lastErr
  for (const model of await geminiModelsToTry()) {
    if (_dailyExhausted.has(model)) continue
    // Retry budget and backoff depend on the failure kind. A 429 is a
    // per-minute limit that clears in seconds, so the old 4s/8s ladder is
    // right for it. A 5xx is Google overloaded: that clears in minutes, not
    // seconds, and the old ladder gave up on the whole scan after ~2 minutes
    // (Oct 25, 2026: every flash model 503'd on the first batch and the run
    // died before a single posting was scored). 5xx retries therefore get
    // more attempts and a much longer ladder — 15s, 30s, 60s. Waiting costs
    // no quota and no money; giving up early costs the entire scan.
    let attempt = 0
    while (true) {
      try {
        return await paced(() => geminiOnce(model, body))
      } catch (err) {
        lastErr = err
        if (err.dailyExhausted) {
          _dailyExhausted.add(model)
          console.warn(`    ${model}: ${err.message} — daily quota gone, skipping it for the rest of this run`)
          break
        }
        if (!err.retryable) {
          // A non-429/5xx error (bad model name, permission issue, malformed
          // request…) was previously dropped here with zero output — the log
          // would jump straight to whichever model failed next, making that
          // one look like the sole cause when it was really the last domino.
          console.warn(`    ${model}: ${err.message} — not retryable, moving to next model`)
          break
        }
        const maxRetries = err.is5xx ? 3 : MAX_RETRIES
        if (attempt >= maxRetries) {
          console.warn(`    ${model}: ${err.message} — out of retries, moving to next model`)
          break
        }
        const backoff = err.is5xx ? [15000, 30000, 60000][attempt] : 4000 * 2 ** attempt
        console.warn(`    ${err.message}`)
        console.warn(`    retrying ${model} in ${backoff / 1000}s`)
        await sleep(backoff)
        attempt++
      }
    }
  }
  // Every model refused after retries. A 5xx abort is NOT a quota abort:
  // it used to surface as QuotaExhaustedError, which made the app report a
  // quota wall when Google was simply overloaded. Keep the same abort
  // behaviour (the scan stops cleanly with partial results saved) but say
  // what actually happened, so the next run's operator can tell overload
  // from exhaustion at a glance.
  if (lastErr?.is5xx) {
    throw new QuotaExhaustedError(
      `Gemini overloaded: every model returned 503 after retries. Scores saved before the failing batch are kept — re-running the scan later usually succeeds. Last response — ${lastErr.message}`
    )
  }
  if (lastErr?.retryable) {
    throw new QuotaExhaustedError(
      `Gemini rejected every model after retries. Anything already scored is saved. Last response — ${lastErr.message}`
    )
  }
  throw lastErr || new Error('All Gemini models failed')
}

// ---------------------------------------------------------------------
// Claude (optional — only if ANTHROPIC_API_KEY is set)
// ---------------------------------------------------------------------
async function claudeCall({ system, prompt, schema, effort }) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system,
    output_config: schema
      ? { effort: effort || 'low', format: { type: 'json_schema', schema } }
      : { effort: effort || 'medium' },
    messages: [{ role: 'user', content: prompt }],
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the request')
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  return { text, model: CLAUDE_MODEL }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------
// Gemini's responseSchema accepts a subset of JSON Schema/OpenAPI — notably
// not additionalProperties, which our schemas set for a different reason
// (catching a model returning surprise keys). Without stripping it, passing
// the schema through as-is either gets ignored or rejected depending on the
// model. Strip just that, recursively, rather than maintain a second
// hand-written copy of every schema for Gemini specifically.
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema)
  if (schema && typeof schema === 'object') {
    const { additionalProperties, ...rest } = schema
    for (const k of Object.keys(rest)) rest[k] = toGeminiSchema(rest[k])
    return rest
  }
  return schema
}

export async function generateJSON({ system, prompt, schema, effort }) {
  const provider = activeProvider()
  if (provider === 'claude') {
    const { text, model } = await claudeCall({ system, prompt, schema, effort })
    return { data: JSON.parse(stripFence(text)), model }
  }
  if (provider === 'gemini') {
    // Previously `schema` was accepted by this function but never actually
    // reached Gemini's request — only responseMimeType was set, so "required"
    // fields were nothing more than a prompt suggestion. Gemini could (and
    // did) drop a field like location_fit some fraction of the time with
    // nothing to catch it. responseSchema makes the API itself enforce it.
    const { text, model } = await geminiCall({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        ...(schema ? { responseSchema: toGeminiSchema(schema) } : {}),
      },
    })
    return { data: JSON.parse(stripFence(text)), model }
  }
  throw new Error('No LLM key set (GEMINI_API_KEY, or optionally ANTHROPIC_API_KEY)')
}

export async function generateText({ system, prompt, effort }) {
  const provider = activeProvider()
  if (provider === 'claude') return claudeCall({ system, prompt, effort })
  if (provider === 'gemini') {
    return geminiCall({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6 },
    })
  }
  throw new Error('No LLM key set (GEMINI_API_KEY, or optionally ANTHROPIC_API_KEY)')
}

export { GEMINI_RPM, MIN_GAP_MS }
