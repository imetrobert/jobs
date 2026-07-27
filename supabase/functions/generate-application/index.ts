// Supabase Edge Function: generate-application
//
// Drafts a tailored cover letter and CV for one posting, grounded in the
// profile stored in job_profile. Saves both to job_applications and returns
// them to the browser.
//
// This runs as an edge function rather than in the scan workflow because it's
// interactive — you click, you wait a few seconds, you read the draft. The
// monthly scan stays in GitHub Actions where it has minutes to work with.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function →
// name it exactly "generate-application", paste this file, deploy (keep
// "Verify JWT" ON — that's what restricts it to your logged-in session).
// Or via CLI: supabase functions deploy generate-application
//
// Secrets (Dashboard → Edge Functions → Secrets):
//   GEMINI_API_KEY  (required)
//   ANTHROPIC_API_KEY (optional upgrade — Claude is used only if this is set;
//   nothing here needs a paid Claude account)

import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') || 'claude-opus-5'

// See scripts/llm.js for why this isn't a hardcoded list: Google deprecates
// Gemini model names for new projects faster than this file gets edited, so
// the models an old key can call and a brand-new key can call can differ.
// Ask the key itself instead of guessing.
let cachedGeminiModels: string[] | null = null

function modelRank(name: string): number {
  const m = name.match(/gemini-(\d+)(?:\.(\d+))?/)
  const version = m ? Number(m[1]) * 100 + Number(m[2] || 0) : 0
  const isPreview = /preview|exp(?:erimental)?\b/i.test(name)
  const isLite = /lite/i.test(name)
  return version * 10 - (isPreview ? 5 : 0) - (isLite ? 1 : 0)
}

async function discoverGeminiModels(key: string): Promise<string[]> {
  if (cachedGeminiModels) return cachedGeminiModels
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`)
    if (!res.ok) throw new Error(`ListModels ${res.status}`)
    const data = await res.json()
    const usable = (data.models || [])
      .filter((m: { supportedGenerationMethods?: string[] }) =>
        (m.supportedGenerationMethods || []).includes('generateContent')
      )
      .map((m: { name: string }) => m.name.replace(/^models\//, ''))
      .filter((n: string) => !/embedding|image|imagen|tts|audio|aqa|vision|veo/i.test(n))
    const flashOnly = usable.filter((n: string) => /flash/i.test(n))
    const pool = (flashOnly.length ? flashOnly : usable).sort(
      (a: string, b: string) => modelRank(b) - modelRank(a)
    )
    if (pool.length) {
      cachedGeminiModels = [...new Set(pool)].slice(0, 4) as string[]
      return cachedGeminiModels
    }
  } catch {
    // fall through to the hardcoded fallback below
  }
  cachedGeminiModels = ['gemini-flash-latest', 'gemini-2.0-flash']
  return cachedGeminiModels
}

async function callClaude(system: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system,
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the request')
  return (data.content || [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('\n')
}

async function callGemini(system: string, prompt: string): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY')!
  let lastErr: Error | null = null
  for (const model of await discoverGeminiModels(key)) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.6 },
          }),
        }
      )
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        lastErr = new Error(`Gemini ${res.status} on ${model}: ${detail.slice(0, 200)}`)
        console.error(`  ${lastErr.message}`)
        continue
      }
      const data = await res.json()
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((p: { text: string }) => p.text)
        .join('')
      if (text.trim()) return text
      lastErr = new Error(`Gemini returned empty text on ${model}`)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr || new Error('All Gemini models failed')
}

async function generate(system: string, prompt: string): Promise<string> {
  if (Deno.env.get('ANTHROPIC_API_KEY')) return callClaude(system, prompt)
  if (Deno.env.get('GEMINI_API_KEY')) return callGemini(system, prompt)
  throw new Error('No LLM key configured — set GEMINI_API_KEY in Edge Functions → Secrets')
}

const SYSTEM = `You write job application documents for one specific candidate applying to one specific role.

Hard rules:
- Use ONLY facts present in the candidate's profile and resume. Never invent an employer, title, date, metric, certification, or degree. If the posting asks for something the candidate does not have, do not manufacture it — either omit it or address it honestly as transferable experience.
- Write in the candidate's own register: direct, specific, and confident without inflation. No "I am writing to express my keen interest", no "passionate about leveraging synergies", no filler superlatives.
- Lead with the single strongest reason this candidate fits this role. Earn the rest of the letter with concrete evidence — scope owned, outcomes, numbers already in the resume.
- Reference the actual company and role. If the posting names a specific problem, challenge, or product, speak to it directly.
- Cover letter: under 300 words, four short paragraphs at most, no bullet lists.

POSITIONING A LONG CAREER

This candidate is late-career with deep experience. That is an asset, and the documents must read that way — but resume screening frequently filters experienced candidates before a human ever reads the application. Write to survive that screen without ever misrepresenting anything:

- Lead with current, in-demand capability, not with longevity. Never open with "25+ years of experience" or similar — it invites a filter before it demonstrates anything. Open with recent, specific, quantified impact.
- Foreground the most recent and most current work, especially anything in a presently in-demand area. The strongest available counter to any assumption that a long career means dated skills is concrete evidence of current work. Put it first and be specific about it.
- On the CV, give full detail to roughly the last 12–15 years. Compress everything earlier into a single short "Earlier career" line naming the employers and the nature of the work, without a year-by-year breakdown. This is standard executive-CV practice and loses nothing that matters to a hiring manager.
- Never include education graduation years, or any date that exists only to establish chronology rather than to demonstrate achievement.
- Emphasise appetite for the actual work of the role, not just oversight of it. The most common reason an experienced candidate is passed over is a fear that they want a title rather than the job.
- Never apologise for the depth of the candidate's experience, never call attention to career length as something to be explained, and never write a line that draws attention to age. Simply lead with what is most relevant and current.
- If a screening risk is supplied below, write to defuse it — through emphasis and framing, never by hiding or misstating a fact.

SURVIVING AUTOMATED SCREENING

Most applications are parsed and ranked by software before a person sees them. Both documents must be machine-readable and must use the employer's own vocabulary for things the candidate has genuinely done.

Formatting — the CV must parse cleanly:
- Plain linear Markdown only. NO tables, NO multiple columns, NO text boxes, NO headers or footers, NO images, icons, logos, charts or symbols. These are the most common reason a real CV is scored as near-empty.
- Standard section headings, spelled conventionally: "Professional Experience", "Skills", "Education", "Certifications". Parsers look for these exact concepts; a creative heading like "Where I've Made an Impact" often maps to nothing.
- Reverse-chronological. One role per entry, in the order: job title, then employer, then location, then dates. Dates as MM/YYYY - MM/YYYY, in a consistent format throughout.
- Separate those fields with commas or put them on their own lines. Do NOT use pipe characters, tabs, or multiple spaces as separators — parsers read a pipe-delimited line as table structure and can lose the fields around it.
- Simple hyphen bullets. No custom glyphs.
- Spell out every acronym once with the abbreviation beside it — "Artificial Intelligence (AI)", "Customer Relationship Management (CRM)" — because a screen may be searching for either form.
- Include a plain "Skills" section listing genuine competencies as short comma-separated terms. This is the section keyword matching leans on hardest.

Vocabulary — mirror the posting, truthfully:
- A KEYWORDS TO MIRROR list may be supplied below. Those are terms the posting screens on that the candidate genuinely evidences. Work them into the CV and letter in the posting's exact wording, placed inside real accomplishments. If the candidate ran a function the posting calls "stakeholder management", call it stakeholder management.
- A KEYWORDS NOT EVIDENCED list may also be supplied. These are terms the candidate cannot back. DO NOT use them. Do not imply them, do not hint at them, do not include them in a skills list. They appear only so the candidate knows what is missing.
- Mirror the posting's job title only where it is genuinely equivalent to a role held. Never restate the candidate's history under a title they did not hold.
- Integrate terms into sentences that describe real work. Never produce a bare keyword list appended for the parser, never repeat a term unnaturally, and never use hidden text, white-on-white text, or any device intended to be read by software but not by a person. Modern parsers detect these, they are grounds for immediate rejection, and they would put the candidate's name to a dishonest application.

COMPENSATION

Never state, imply, or negotiate a compensation figure in either document. Do not mention salary expectations, a current package, or a floor, even if the posting asks for them — that belongs in a separate conversation where the candidate controls the framing, not in a first-pass screening document. If a compensation note is supplied below it is context for you only: it may inform how seniority and scope are emphasised, and must never appear as a number on the page.

Output format — return exactly these two sections and nothing else:

===COVER_LETTER===
<the letter, ready to send, no placeholders>

===CV===
<the full CV in Markdown, reordered and reworded to foreground what this role wants. Same facts as the source resume — same employers and titles — but with emphasis, phrasing and ordering tuned to the posting, and recent work given the most space.>`

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Not authenticated' }, 401)

    // Verify the caller is a real logged-in user before spending an LLM call.
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'Not authenticated' }, 401)

    const { posting_id } = await req.json()
    if (!posting_id) return json({ error: 'posting_id is required' }, 400)

    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const [{ data: profile }, { data: job }, { data: match }] = await Promise.all([
      db.from('job_profile').select('*').eq('id', 1).single(),
      db.from('job_postings').select('*').eq('id', posting_id).single(),
      db.from('job_matches').select('*').eq('posting_id', posting_id).maybeSingle(),
    ])

    if (!job) return json({ error: 'Posting not found' }, 404)
    if (!profile?.resume_text) {
      return json({ error: 'Add your resume in the Profile tab first — there is nothing to tailor.' }, 400)
    }

    // Regenerating documents must not rewind the pipeline: if you've already
    // marked this applied/interviewing/offer, that status survives.
    const { data: existingApp } = await db
      .from('job_applications')
      .select('status')
      .eq('posting_id', posting_id)
      .maybeSingle()
    const keepStatus =
      existingApp?.status && !['interested', 'generating', 'ready'].includes(existingApp.status)
        ? existingApp.status
        : null

    await db
      .from('job_applications')
      .upsert(
        { posting_id, status: keepStatus || 'generating', updated_at: new Date().toISOString() },
        { onConflict: 'posting_id' }
      )

    const prompt = [
      '## CANDIDATE',
      profile.headline ? `Headline: ${profile.headline}` : '',
      profile.location ? `Based in: ${profile.location}` : '',
      profile.summary ? `Summary: ${profile.summary}` : '',
      '',
      '### RESUME',
      profile.resume_text,
      '',
      '## THE ROLE',
      `Title: ${job.title}`,
      job.company ? `Company: ${job.company}` : '',
      job.location ? `Location: ${job.location}` : '',
      '',
      (job.description || '').slice(0, 8000),
      '',
      match?.pitch_angle ? `## SUGGESTED ANGLE\n${match.pitch_angle}` : '',
      match?.gaps ? `## KNOWN GAPS TO HANDLE HONESTLY\n${match.gaps}` : '',
      match?.overqualification_risk
        ? `## SCREENING RISK TO WRITE AGAINST\n${match.overqualification_risk}`
        : '',
      match?.comp_assessment
        ? `## COMPENSATION CONTEXT (never put a figure in the documents)\n${match.comp_assessment}`
        : '',
      match?.ats_keywords_covered
        ? `## KEYWORDS TO MIRROR (the candidate genuinely evidences these — use the posting's wording, inside real accomplishments)\n${match.ats_keywords_covered}`
        : '',
      match?.ats_keywords_missing
        ? `## KEYWORDS NOT EVIDENCED (the candidate CANNOT back these — do not use, imply, or hint at any of them)\n${match.ats_keywords_missing}`
        : '',
      '',
      'Write the cover letter and the tailored CV.',
    ]
      .filter(Boolean)
      .join('\n')

    const raw = await generate(SYSTEM, prompt)

    // Tolerate the model varying the marker spacing or dropping the CV block.
    const letterMatch = raw.match(/===\s*COVER_LETTER\s*===\s*([\s\S]*?)(?:===\s*CV\s*===|$)/i)
    const cvMatch = raw.match(/===\s*CV\s*===\s*([\s\S]*)$/i)
    const cover_letter = (letterMatch?.[1] || raw).trim()
    const tailored_cv = (cvMatch?.[1] || '').trim() || null

    await db.from('job_applications').upsert(
      {
        posting_id,
        status: keepStatus || 'ready',
        cover_letter,
        tailored_cv,
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'posting_id' }
    )

    return json({ cover_letter, tailored_cv })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
