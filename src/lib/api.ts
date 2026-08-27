export type Repo = {
  name: string
  path: string
  nwo?: string | null
}

/** One entry in a fixed list the server offers, like the models or the efforts. */
export type Option = {
  id: string
  name: string
  note: string
}

export type Settings = {
  prompt: string
  model: string
  effort: string
  open_prs: boolean
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
  analytics: (days: number): Promise<Analytics> => fetch(`/api/analytics?days=${days}`).then(json),
  settings: (): Promise<Settings> => fetch('/api/settings').then(json),
  saveSettings: (s: Settings): Promise<Settings> =>
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(s),
    }).then(json),
  repos: (): Promise<Repo[]> => fetch('/api/repos').then(json),
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
  start: (id: string, model: string, effort: string): Promise<Review> =>
    fetch(`/api/reviews/${id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, effort }),
    }).then(json),
  diff: (id: string): Promise<string> => fetch(`/api/reviews/${id}/diff`).then(text),
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

export function toLines(e: StreamEvent): Line[] {
  const depth = e.parent_tool_use_id ? 1 : 0

  if (e.type === 'system' && e.subtype === 'init') return [{ text: 'session started', tone: 'meta', depth }]

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

  return []
}
