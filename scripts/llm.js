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

// Same fallback chain as the blog pipeline (scripts/gemini.py), so a quota
// wall on one model doesn't fail the whole scan.
const GEMINI_MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']

// Free-tier pacing. Gemini's free tier is limited per minute AND per day, and
// the per-minute limit is the one that bites during a scan. Requests are
// serialized through a single queue with a minimum gap between them.
//
// Default 8/min sits deliberately under gemini-2.5-flash's free-tier ceiling of
// ~10 requests/minute. Running at or above the ceiling still "works" — the
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
    // Carry Google's own wording through. A 429 can mean a per-minute limit
    // that clears in seconds or a per-day one that doesn't, and its body
    // frequently lists BOTH metrics — so this is never classified here, only
    // reported. Retrying and failing is cheap; giving up on a recoverable
    // limit costs a whole scan.
    const err = new Error(`429 from ${model}: ${summarizeQuotaError(await res.text())}`)
    err.retryable = true
    throw err
  }
  if (res.status >= 500) {
    const err = new Error(`${model} returned ${res.status}`)
    err.retryable = true
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

async function geminiCall(body) {
  let lastErr
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await paced(() => geminiOnce(model, body))
      } catch (err) {
        lastErr = err
        if (!err.retryable) {
          // A non-429/5xx error (bad model name, permission issue, malformed
          // request…) was previously dropped here with zero output — the log
          // would jump straight to whichever model failed next, making that
          // one look like the sole cause when it was really the last domino.
          console.warn(`    ${model}: ${err.message} — not retryable, moving to next model`)
          break
        }
        if (attempt === MAX_RETRIES) {
          console.warn(`    ${model}: ${err.message} — out of retries, moving to next model`)
          break
        }
        // Exponential backoff: 4s then 8s. Deliberately short — a per-minute
        // limit clears inside that, and anything that doesn't is better
        // reported than waited out.
        const backoff = 4000 * 2 ** attempt
        console.warn(`    ${err.message}`)
        console.warn(`    retrying ${model} in ${backoff / 1000}s`)
        await sleep(backoff)
      }
    }
  }
  // Every model refused after retries. Whether that's a per-day wall or
  // something else, the run can't continue — but Google's own message goes
  // with it, so the cause is visible in the log and in job_runs.error rather
  // than being guessed at.
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
export async function generateJSON({ system, prompt, schema, effort }) {
  const provider = activeProvider()
  if (provider === 'claude') {
    const { text, model } = await claudeCall({ system, prompt, schema, effort })
    return { data: JSON.parse(stripFence(text)), model }
  }
  if (provider === 'gemini') {
    const { text, model } = await geminiCall({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
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
