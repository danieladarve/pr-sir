export type Repo = {
  name: string
  path: string
  nwo?: string | null
}

export type Model = {
  id: string
  name: string
  note: string
}

export type Settings = {
  prompt: string
  model: string
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
  /** Set when staging found a card for this PR already open. */
  existing?: boolean
  created_at: number
  posted_at?: number | null
}

// The raw claude stream-json event. Only the fields the UI reads are named.
export type StreamEvent = {
  type: string
  subtype?: string
  message?: { content?: Array<Record<string, unknown>> }
  parent_tool_use_id?: string | null
  total_cost_usd?: number
  [k: string]: unknown
}

export type Session = Review & { events: StreamEvent[]; thinking?: number }

const json = async (res: Response) => {
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

// The list never changes while the server is up, so one fetch covers every card.
let models: Promise<Model[]> | undefined

export const api = {
  models: (): Promise<Model[]> => (models ??= fetch('/api/models').then(json)),
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
  sessions: (): Promise<Session[]> => fetch('/api/sessions').then(json),
  archive: (): Promise<Review[]> => fetch('/api/archive').then(json),
  stage: (repo: string, pr: string): Promise<Review> =>
    fetch('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, pr }),
    }).then(json),
  start: (id: string, model: string): Promise<Review> =>
    fetch(`/api/reviews/${id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    }).then(json),
  diff: (id: string): Promise<string> =>
    fetch(`/api/reviews/${id}/diff`).then(async (r) => {
      const text = await r.text()
      if (!r.ok) throw new Error(text.slice(0, 300))
      return text
    }),
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

  if (e.type === 'result') {
    const cost = typeof e.total_cost_usd === 'number' ? ` ($${e.total_cost_usd.toFixed(2)})` : ''
    return [{ text: `review finished${cost}`, tone: 'meta', depth: 0 }]
  }

  return []
}
