// On-demand scan: fires the GitHub Actions workflow that runs the scan
// script. A full scan hits several APIs and then makes dozens of LLM calls, so
// it runs where it has minutes to spare (Actions) rather than inside a Supabase
// edge function's request timeout.
//
// Same browser-PAT pattern as the blog preview page: a token kept in
// localStorage, never committed.
//
// Scope note, because it is counter-intuitive: TRIGGERING a workflow needs
// `repo` on a classic token, or `Actions: write` on a fine-grained one. The
// `workflow` scope sounds right but governs EDITING workflow files, and a
// token holding only that is rejected here.

const REPO = import.meta.env.VITE_GITHUB_REPO || 'imetrobert/jobs'
const WORKFLOW = 'job-scan.yml'
const REF = import.meta.env.VITE_GITHUB_REF || 'main'
const TOKEN_KEY = 'jobs.githubToken'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token.trim())
  else localStorage.removeItem(TOKEN_KEY)
}

export async function triggerScan() {
  const token = getToken()
  if (!token) throw new Error('No GitHub token saved — add one below to enable Refresh.')

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      // Only `trigger` is sent. Everything else — how many postings get
      // scored, how many links get verified — deliberately falls through to
      // the workflow's own input defaults, so those numbers live in one place
      // (job-scan.yml) rather than being duplicated here and silently
      // overriding it. A scan started from this button gets exactly the same
      // settings as one started from the Actions tab.
      body: JSON.stringify({ ref: REF, inputs: { trigger: 'manual' } }),
    }
  )

  if (res.status === 204) return true
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'GitHub rejected the token. Triggering a workflow needs the "repo" scope on a classic token, ' +
        'or "Actions: read and write" on a fine-grained one. The "workflow" scope alone is not enough — ' +
        'that one only allows editing workflow files.'
    )
  }
  if (res.status === 404) {
    throw new Error(`Workflow not found. Check that ${WORKFLOW} exists on ${REF} in ${REPO}.`)
  }
  const body = await res.text()
  throw new Error(`GitHub returned ${res.status}: ${body.slice(0, 200)}`)
}
