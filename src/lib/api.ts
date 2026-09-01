export type Repo = {
  name: string
  path: string
  nwo?: string | null
  /** The saved prompt this repo reviews with. Null means Default. */
  prompt?: string | null
}

/** One review prompt, under the name it is picked by. */
export type Prompt = {
  name: string
  body: string
  /** Comes from the server rather than the list you edit, so it is read only. */
  builtin?: boolean
}

/** One entry in a fixed list the server offers, like the models or the efforts. */
export type Option = {
  id: string
  name: string
  note: string
}

export type Settings = {
  model: string
  effort: string
  open_prs: boolean
}

export type Version = {
  current: string
  /** null when GitHub could not be asked. */
  latest: string | null
  outdated: boolean
}

/** One repo or one author, over the range asked for. */
export type Breakdown = {
  name: string
  reviews: number
  posted: number
  discarded: number
  findings: number
  cost_usd: number
  tokens: number
  median_run_ms: number | null
  median_to_post_ms: number | null
}

export type Analytics = {
  days: number
  totals: {
    reviews: number
    posted: number
    discarded: number
    findings: number
    cost_usd: number
    tokens: number
    median_run_ms: number | null
    median_to_post_ms: number | null
  }
  series: Array<{ date: string; repos: Record<string, number>; authors: Record<string, number> }>
  repos: Breakdown[]
  authors: Breakdown[]
}

/** An open PR on GitHub, which may or may not have a card here yet. */
export type OpenPr = {
  number: number
  title: string
  url: string
  author: string
  created_at: number | null
  draft: boolean
  queued: boolean
}

/** One commit on a PR, as GitHub lists them, oldest first. */
export type PrCommit = {
  sha: string
  subject: string
  author: string
  date: number | null
}

export type Finding = {
  path: string
  line: number
  severity: 'bug' | 'blocker'
  body: string
}

export type Comment = {
  path: string
  line: number
  body: string
  /** Written by the user rather than the agent. */
  mine?: boolean
}

export type Review = {
  id: string
  repo: string
  pr: number
  title: string
  author: string
  url: string
  head_sha: string
  status: 'staged' | 'running' | 'done' | 'posted' | 'discarded' | 'failed'
  verdict?: 'REQUEST_CHANGES' | 'APPROVE' | null
  summary?: string | null
  findings?: string | null
  cost_usd?: number | null
  error?: string | null
  comments?: string | null
  pr_created_at?: number | null
  model?: string | null
  effort?: string | null
  /** The saved prompt this review actually ran on. */
  prompt?: string | null
  /** The one commit this review reads. Null means the whole PR. */
  commit_sha?: string | null
  tokens?: number | null
  /** Set when staging found a card for this PR already open. */
  existing?: boolean
  created_at: number
  posted_at?: number | null
}

// The raw claude stream-json event. Only the fields the UI reads are named.
export type StreamEvent = {
  type: string
  subtype?: string
  message?: { id?: string; content?: Array<Record<string, unknown>>; usage?: Record<string, number> }
  parent_tool_use_id?: string | null
  total_cost_usd?: number
  usage?: Record<string, number>
  /** On task_started and task_notification, which is how subagents report. */
  description?: string
  summary?: string
  status?: string
  rate_limit_info?: { status?: string; rateLimitType?: string; utilization?: number }
  [k: string]: unknown
}

export type Session = Review & { events: StreamEvent[]; thinking?: number }

const json = async (res: Response) => {
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

// Neither list changes while the server is up, so one fetch covers every card.
let models: Promise<Option[]> | undefined
let efforts: Promise<Option[]> | undefined

const text = async (res: Response) => {
  const body = await res.text()
  if (!res.ok) throw new Error(body.slice(0, 300))
  return body
}

export const api = {
  models: (): Promise<Option[]> => (models ??= fetch('/api/models').then(json)),
  efforts: (): Promise<Option[]> => (efforts ??= fetch('/api/efforts').then(json)),
  version: (): Promise<Version> => fetch('/api/version').then(json),
  analytics: (days: number): Promise<Analytics> => fetch(`/api/analytics?days=${days}`).then(json),
  settings: (): Promise<Settings> => fetch('/api/settings').then(json),
  saveSettings: (s: Settings): Promise<Settings> =>
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(s),
    }).then(json),
  skillPrompt: (): Promise<{ body: string }> => fetch('/api/skill-prompt').then(json),
  // Not cached the way the models are: these change while the app is open.
  prompts: (): Promise<Prompt[]> => fetch('/api/prompts').then(json),
  /** Only the ones you can edit, so the built-ins stay out of the editor. */
  saved: (): Promise<Prompt[]> => api.prompts().then((ps) => ps.filter((p) => !p.builtin)),
  savePrompt: (name: string, body: string, rename?: string): Promise<Prompt[]> =>
    fetch('/api/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, body, rename }),
    }).then(json),
  deletePrompt: (name: string): Promise<Prompt[]> =>
    fetch(`/api/prompts/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(json),
  repos: (): Promise<Repo[]> => fetch('/api/repos').then(json),
  setRepoPrompt: (repo: string, prompt: string): Promise<Repo> =>
    fetch(`/api/repos/${encodeURIComponent(repo)}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }).then(json),
  addRepo: (path: string): Promise<Repo> =>
    fetch('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then(json),
  removeRepo: (name: string) =>
    fetch(`/api/repos/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(json),
  openPrs: (repo: string): Promise<OpenPr[]> =>
    fetch(`/api/repos/${encodeURIComponent(repo)}/prs`).then(json),
  prDiff: (repo: string, pr: number): Promise<string> =>
    fetch(`/api/repos/${encodeURIComponent(repo)}/prs/${pr}/diff`).then(text),
  sessions: (): Promise<Session[]> => fetch('/api/sessions').then(json),
  archive: (): Promise<Review[]> => fetch('/api/archive').then(json),
  stage: (repo: string, pr: string): Promise<Review> =>
    fetch('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, pr }),
    }).then(json),
  start: (id: string, model: string, effort: string, prompt: string): Promise<Review> =>
    fetch(`/api/reviews/${id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, effort, prompt }),
    }).then(json),
  diff: (id: string): Promise<string> => fetch(`/api/reviews/${id}/diff`).then(text),
  commits: (id: string): Promise<PrCommit[]> => fetch(`/api/reviews/${id}/commits`).then(json),
  /** An empty sha puts the review back to the whole PR. */
  setCommit: (id: string, commit: string): Promise<Review> =>
    fetch(`/api/reviews/${id}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commit }),
    }).then(json),
  comment: (id: string, path: string, line: number, body: string): Promise<Review> =>
    fetch(`/api/reviews/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, line, body }),
    }).then(json),
  uncomment: (id: string, index: number): Promise<Review> =>
    fetch(`/api/reviews/${id}/comments/${index}`, { method: 'DELETE' }).then(json),
  post: (id: string, findings: Finding[]): Promise<Review> =>
    fetch(`/api/reviews/${id}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findings }),
    }).then(json),
  discard: (id: string): Promise<Review> => fetch(`/api/reviews/${id}/discard`, { method: 'POST' }).then(json),
  remove: (id: string) => fetch(`/api/reviews/${id}`, { method: 'DELETE' }).then(json),
}

const parseList = <T,>(json: string | null | undefined): T[] => {
  try {
    return json ? JSON.parse(json) : []
  } catch {
    return []
  }
}

export const formatTokens = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`

export const formatUsd = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`)

export const formatMs = (ms: number | null) => {
  if (ms === null) return '–'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export const parseFindings = (r: Review) => parseList<Finding>(r.findings)
export const parseComments = (r: Review) => parseList<Comment>(r.comments)

/** One display line, or null for events with nothing worth showing. */
export type Line = { text: string; tone: 'text' | 'tool' | 'meta'; depth: number }

const toolLine = (name: string, input: Record<string, unknown>): string => {
  const first =
    (input.skill as string) ??
    (input.command as string) ??
    (input.file_path as string) ??
    (input.description as string) ??
    (input.pattern as string) ??
    (input.qualified_name as string) ??
    (input.prompt as string) ??
    ''
  const arg = String(first).split('\n')[0].slice(0, 120)
  return arg ? `${name}  ${arg}` : name
}

/**
 * Hooks fire before the session even starts and a hook_response carries the
 * whole hook output, which would bury the review in someone's shell profile.
 */
const NOISE = ['hook_started', 'hook_response']

export function toLines(e: StreamEvent): Line[] {
  const depth = e.parent_tool_use_id ? 1 : 0

  if (e.type === 'system' && e.subtype === 'init') return [{ text: 'session started', tone: 'meta', depth }]

  // A review that works through subagents, /code-review among them, reports
  // only through these. Without them the log sits on its placeholder for
  // minutes while the agent is busy.
  if (e.type === 'system' && e.subtype === 'task_started') {
    return [{ text: `task  ${e.description ?? ''}`.trim(), tone: 'tool', depth: 1 }]
  }

  if (e.type === 'system' && e.subtype === 'task_notification') {
    return [{ text: `task ${e.status ?? 'update'}  ${e.summary ?? ''}`.trim(), tone: 'meta', depth: 1 }]
  }

  if (e.type === 'rate_limit_event' && e.rate_limit_info?.status !== 'allowed') {
    const pct = Math.round((e.rate_limit_info?.utilization ?? 0) * 100)
    return [{ text: `rate limit ${e.rate_limit_info?.rateLimitType ?? ''} at ${pct}%`, tone: 'meta', depth: 0 }]
  }

  if (e.type === 'assistant') {
    const out: Line[] = []
    for (const block of e.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ text: block.text.trim(), tone: 'text', depth })
      }
      if (block.type === 'tool_use') {
        out.push({
          text: toolLine(String(block.name), (block.input ?? {}) as Record<string, unknown>),
          tone: 'tool',
          depth,
        })
      }
    }
    return out
  }

  // The card carries the running total, so the closing line only marks the end.
  if (e.type === 'result') return [{ text: 'review finished', tone: 'meta', depth: 0 }]

  // Better a dim line naming a subtype nobody has taught this about than a log
  // that looks stuck while the agent works.
  if (e.type === 'system' && e.subtype && !NOISE.includes(e.subtype)) {
    return [{ text: e.subtype.replace(/_/g, ' '), tone: 'meta', depth }]
  }

  return []
}
