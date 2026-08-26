import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { ndjson } from './ndjson.mjs'
import { reviewPayload } from './payload.mjs'

const run = promisify(execFile)
const PORT = Number(process.env.PR_SIR_PORT) || 8787
// A review can wedge on a command that never returns. Seen in practice: the agent
// started supervisord in the foreground inside a container to check a base image.
// Idle, not total, so a slow review is left alone and only a silent one is killed.
// Number('') is 0 and Number('ten') is NaN, and both make setTimeout fire
// immediately, killing every review a millisecond after it starts.
const idleMin = Number(process.env.PR_SIR_IDLE_MIN)
const IDLE_MS = (idleMin > 0 ? idleMin : 10) * 60_000
const root = import.meta.dirname
const MCP_CONFIG = path.join(root, 'pr-sir.mcp.json')
const SKILL_MD = path.join(root, '.claude', 'skills', 'pr-sir', 'SKILL.md')

// --- config ---------------------------------------------------------------

// Only the servers the review actually uses. Spawning with the machine's full
// MCP config costs 470k cache-creation tokens per session before the agent does
// any work; this brings it to 27k.
if (!existsSync(MCP_CONFIG)) throw new Error('missing pr-sir.mcp.json')

// Every server named in that file has to actually be on PATH, or claude spends
// the first part of each review failing to start it. Drop the ones that are not
// installed and carry on: the skill falls back to Read and Grep.
const mcpConfigPath = (() => {
  const cfg = JSON.parse(readFileSync(MCP_CONFIG, 'utf8'))
  const missing = Object.entries(cfg.mcpServers ?? {})
    .filter(([, v]) => v.command && !onPath(v.command))
    .map(([k]) => k)
  if (missing.length === 0) return MCP_CONFIG
  console.log(`not installed, skipping: ${missing.join(', ')}`)
  for (const name of missing) delete cfg.mcpServers[name]
  const trimmed = path.join(root, 'data', 'mcp.resolved.json')
  mkdirSync(path.dirname(trimmed), { recursive: true })
  writeFileSync(trimmed, JSON.stringify(cfg))
  return trimmed
})()

function onPath(cmd) {
  if (cmd.includes('/')) return existsSync(cmd)
  return (process.env.PATH ?? '').split(':').some((d) => d && existsSync(path.join(d, cmd)))
}

// The review runs with the target repo as its cwd, so a skill living in this
// project is not on its path and /pr-sir does not resolve. Send the skill body
// as the prompt instead. Read per spawn, so editing SKILL.md takes effect
// without a restart.
const skillPrompt = () => readFileSync(SKILL_MD, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')

// SKILL.md is the starting point, not the last word: a prompt saved in settings
// wins, and clearing it falls back to the file again.
const prompt = (pr) => {
  const md = setting('prompt') ?? skillPrompt()
  return `${md}\n\nReview PR ${pr} now. Return the JSON from section 6 and nothing else.`
}

// The picked model becomes a spawn argument. Anything not on this list is
// refused, so a crafted value cannot smuggle in another flag.
const MODELS = [
  { id: '', name: 'Default', note: 'whatever your claude config uses' },
  { id: 'fable', name: 'Fable', note: 'most capable, most expensive' },
  { id: 'opus', name: 'Opus', note: 'very capable, expensive' },
  { id: 'sonnet', name: 'Sonnet', note: 'faster and cheaper' },
  { id: 'haiku', name: 'Haiku', note: 'cheapest, for small diffs' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['REQUEST_CHANGES', 'APPROVE'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'line', 'severity', 'body'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['bug', 'blocker'] },
          body: { type: 'string' },
        },
      },
    },
  },
}

// --- storage --------------------------------------------------------------

mkdirSync(path.join(root, 'data'), { recursive: true })
const db = new DatabaseSync(path.join(root, 'data', 'pr-sir.db'))
db.exec(`create table if not exists reviews (
  id text primary key, repo text, pr integer, title text, author text, url text,
  head_sha text, status text, verdict text, summary text, findings text,
  cost_usd real, error text, created_at integer, posted_at integer
)`)

db.exec('create table if not exists repos (name text primary key, path text not null, nwo text)')

db.exec('create table if not exists settings (key text primary key, value text not null)')

const setting = (key) => db.prepare('select value from settings where key = ?').get(key)?.value
const setSetting = (key, value) =>
  value
    ? db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value)
    : db.prepare('delete from settings where key = ?').run(key)

for (const col of ['pr_created_at integer', "comments text not null default '[]'", 'model text']) {
  try {
    db.exec(`alter table reviews add column ${col}`)
  } catch {
    // already there
  }
}

db.exec("update reviews set status = 'failed', error = 'server restarted' where status = 'running'")

// One-time import so the repos.json this started life with is not lost.
if (db.prepare('select count(*) as n from repos').get().n === 0 && existsSync(path.join(root, 'repos.json'))) {
  const seed = JSON.parse(readFileSync(path.join(root, 'repos.json'), 'utf8'))
  const ins = db.prepare('insert or ignore into repos (name, path) values (?, ?)')
  for (const r of seed) ins.run(r.name, r.path)
  console.log(`imported ${seed.length} repos from repos.json`)
}

const allRepos = () => db.prepare('select * from repos order by name').all()
const getRepo = (name) => db.prepare('select * from repos where name = ?').get(name)

// The path becomes the cwd of a spawned process, so it is checked before it is
// stored, not when it is used.
async function addRepo(input) {
  const raw = String(input ?? '').trim()
  // Checked before resolve: path.resolve('') returns the cwd, which would make
  // an empty box look like a real path and fail with a confusing message.
  if (!raw) throw Object.assign(new Error('give a path to a repo'), { status: 400 })
  const dir = path.resolve(raw.replace(/^~(?=\/|$)/, homedir()))

  let isDir = false
  try {
    isDir = statSync(dir).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw Object.assign(new Error(`${dir} is not a directory`), { status: 400 })
  if (!existsSync(path.join(dir, '.git'))) {
    throw Object.assign(new Error(`${dir} is not a git repository`), { status: 400 })
  }

  let nwo
  try {
    const { stdout } = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: dir })
    nwo = stdout.trim()
  } catch {
    throw Object.assign(new Error(`no GitHub remote you can reach at ${dir}`), { status: 400 })
  }

  const name = path.basename(dir)
  const clash = getRepo(name)
  if (clash && clash.path !== dir) {
    throw Object.assign(new Error(`a repo called ${name} already points at ${clash.path}`), { status: 409 })
  }
  db.prepare('insert or replace into repos (name, path, nwo) values (?, ?, ?)').run(name, dir, nwo)
  return getRepo(name)
}

const save = (row) =>
  db
    .prepare(
      `insert into reviews (id, repo, pr, title, author, url, head_sha, status, created_at, pr_created_at)
       values ($id, $repo, $pr, $title, $author, $url, $head_sha, $status, $created_at, $pr_created_at)`,
    )
    .run({ ...row, pr_created_at: row.pr_created_at ?? null })

const update = (id, fields) => {
  const keys = Object.keys(fields)
  db.prepare(`update reviews set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`).run(
    ...keys.map((k) => fields[k]),
    id,
  )
}

const get = (id) => db.prepare('select * from reviews where id = ?').get(id)

// --- live sessions --------------------------------------------------------

// ponytail: stream events live in memory only, so a finished session's log is
// gone on restart. Persist to an events table if replaying old runs matters.
const sessions = new Map()
const clients = new Set()

const broadcast = (type, data) => {
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`
  for (const res of clients) {
    try {
      res.write(frame)
    } catch {
      // A socket that died without firing 'close' must not stop the others.
      clients.delete(res)
    }
  }
}

const push = (id, event) => {
  const s = sessions.get(id)
  if (!s) return
  s.events.push(event)
  if (s.events.length > 2000) s.events.shift()
  broadcast('event', { id, event })
}

/** SIGTERM the whole group, then SIGKILL what is left. A review that wedged on
 *  a foreground grandchild (a container, a build) outlives a plain kill of
 *  claude alone, because the grandchild is reparented and keeps going. */
function stop(proc) {
  if (!proc?.pid) return
  const signal = (sig) => {
    try {
      process.kill(-proc.pid, sig) // negative pid is the process group
    } catch {
      try {
        proc.kill(sig)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  setTimeout(() => proc.exitCode === null && signal('SIGKILL'), 5000).unref()
}

function armIdle(id) {
  const s = sessions.get(id)
  if (!s) return
  clearTimeout(s.timer)
  s.timer = setTimeout(() => {
    s.timedOut = true
    stop(s.proc)
  }, IDLE_MS)
}

/** Pulls the PR in and parks it. Nothing is spawned until the user says go. */
async function stageReview(repoName, pr) {
  const repo = getRepo(repoName)
  if (!repo) throw Object.assign(new Error(`unknown repo ${repoName}`), { status: 400 })

  // Searching the same PR again should land on the card that is already there,
  // not add another one. Posted, discarded and failed reviews are done with, so
  // those do not block a fresh look at the same PR.
  const already = db
    .prepare("select * from reviews where repo = ? and pr = ? and status in ('staged', 'running', 'done') limit 1")
    .get(repoName, Number(pr))
  if (already) return { ...already, existing: true }

  const { stdout } = await run(
    'gh',
    ['pr', 'view', String(pr), '--json', 'number,title,url,author,headRefOid,createdAt,additions,deletions,changedFiles'],
    { cwd: repo.path },
  )
  const meta = JSON.parse(stdout)

  const id = randomUUID()
  const row = {
    id,
    repo: repo.name,
    pr: meta.number,
    title: meta.title,
    author: meta.author?.login ?? 'unknown',
    url: meta.url,
    head_sha: meta.headRefOid,
    status: 'staged',
    created_at: Date.now(),
    pr_created_at: Date.parse(meta.createdAt) || null,
  }
  save(row)
  sessions.set(id, { events: [], proc: null, cost: 0 })
  broadcast('session', { session: { ...get(id), events: [] } })
  return get(id)
}

async function startReview(id, model = '') {
  const row = get(id)
  if (!row) throw Object.assign(new Error('unknown review'), { status: 404 })
  if (row.status !== 'staged') throw Object.assign(new Error(`already ${row.status}`), { status: 409 })
  const repo = getRepo(row.repo)
  if (!repo) throw Object.assign(new Error(`unknown repo ${row.repo}`), { status: 400 })
  if (!MODELS.some((m) => m.id === model)) {
    throw Object.assign(new Error(`${model} is not a model you can pick`), { status: 400 })
  }

  update(id, { status: 'running', model: model || null })

  const proc = spawn(
    'claude',
    [
      '-p',
      prompt(row.pr),
      '--output-format', 'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--session-id', id,
      '--json-schema', JSON.stringify(FINDINGS_SCHEMA),
      '--strict-mcp-config',
      '--mcp-config', mcpConfigPath,
      // The review's cwd is the target repo, so skills shipped in this project
      // are not on its path. This puts them there.
      '--add-dir', root,
      '--permission-mode', 'bypassPermissions',
      // bypassPermissions is what lets it run unattended. This list stops the
      // obvious ways to publish or edit, and posting stays the server's job.
      // It is not a sandbox: Bash is open, so a review that decides to verify
      // something can still write to the checkout or reach the network.
      '--disallowedTools',
      'Edit Write NotebookEdit Bash(gh pr review:*) Bash(gh api:*) Bash(gh pr comment:*) Bash(gh pr merge:*)',
      // empty means no flag at all, which leaves the choice to claude's own config
      ...(model ? ['--model', model] : []),
    ],
    // detached puts it in its own process group, so stop() can take the whole
    // tree down rather than just claude, leaving a wedged grandchild running.
    { cwd: repo.path, detached: true },
  )

  sessions.set(id, { events: sessions.get(id)?.events ?? [], proc, cost: 0 })
  broadcast('review', { id, review: get(id) })

  // Without this a missing or unrunnable claude emits an unhandled 'error' and
  // kills the server, taking every other running review with it.
  proc.on('error', (err) =>
    finish(id, { status: 'failed', error: err.code === 'ENOENT' ? 'claude is not on PATH' : String(err.message) }),
  )

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', ndjson((event) => onEvent(id, event)))

  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => {
    stderr += d
  })

  proc.on('close', (code) => {
    const live = sessions.get(id)
    if (!live) return
    clearTimeout(live.timer)
    live.proc = null
    if (get(id)?.status !== 'running') return
    const error = live.timedOut
      ? `no output for ${IDLE_MS / 60_000} minutes, killed`
      : stderr.slice(-2000) || `claude exited ${code}`
    finish(id, { status: 'failed', error })
  })

  armIdle(id)
  return get(id)
}

function onEvent(id, event) {
  const s = sessions.get(id)
  if (!s) return
  armIdle(id)

  // A long review emits hundreds of these. They are a progress signal, not a
  // log line, so they are reported but never buffered.
  if (event.type === 'system' && event.subtype === 'thinking_tokens') {
    s.thinking = event.estimated_tokens
    broadcast('thinking', { id, tokens: event.estimated_tokens })
    return
  }
  s.thinking = 0

  push(id, event)

  if (typeof event.total_cost_usd === 'number') s.cost = event.total_cost_usd

  if (event.type !== 'result') return

  if (event.is_error || event.subtype !== 'success') {
    finish(id, { status: 'failed', error: String(event.result ?? event.subtype ?? 'review failed').slice(0, 2000) })
    return
  }
  let parsed
  try {
    parsed = JSON.parse(event.result)
  } catch {
    finish(id, { status: 'failed', error: 'agent did not return JSON matching the schema' })
    return
  }
  finish(id, {
    status: 'done',
    verdict: parsed.verdict,
    summary: parsed.summary,
    findings: JSON.stringify(parsed.findings ?? []),
  })
}

function finish(id, fields) {
  const s = sessions.get(id)
  const cost_usd = s?.cost ?? 0
  update(id, { ...fields, cost_usd })
  broadcast('review', { id, review: get(id) })
}

// --- posting --------------------------------------------------------------

async function postReview(id, findings) {
  const row = get(id)
  if (!row) throw Object.assign(new Error('unknown review'), { status: 404 })
  // Two tabs on the same card would otherwise post two reviews, and the user's
  // own comments are still on the row, so they would go up twice.
  if (row.status === 'posted') throw Object.assign(new Error(`#${row.pr} is already posted`), { status: 409 })

  // The user's own comments go up alongside whatever they kept from the agent.
  const mine = JSON.parse(row.comments || '[]')
  const all = [...mine, ...findings]
  if (all.length === 0 && row.status === 'staged') {
    throw Object.assign(new Error('nothing to post yet'), { status: 400 })
  }

  const { endpoint, body, payload } = reviewPayload(row, all)

  // The PR can move while a review runs, and it does: one review here was
  // correct at the commit it read and already fixed 15 minutes later. Posting
  // that asks for a change that has been made, against a stale commit_id.
  // Derived from the PR url, so it still runs after the repo is removed.
  const { stdout } = await run('gh', ['api', endpoint.replace(/\/reviews$/, ''), '--jq', '.head.sha'])
  const head = stdout.trim()
  if (head && head !== row.head_sha) {
    throw Object.assign(
      new Error(
        `#${row.pr} has moved on since this review (${row.head_sha.slice(0, 7)} to ${head.slice(0, 7)}). Review it again before posting.`,
      ),
      { status: 409 },
    )
  }

  const event = all.length ? 'REQUEST_CHANGES' : 'APPROVE'

  try {
    await ghApi(endpoint, payload)
  } catch (err) {
    // GitHub refuses an approval on your own PR. Leave a plain comment instead.
    if (event === 'APPROVE' && /own pull request/i.test(err.message)) {
      const repo = getRepo(row.repo)
      if (!repo) throw err // the repo was removed; the original error is clearer
      await run('gh', ['pr', 'comment', String(row.pr), '--body', body], { cwd: repo.path })
    } else {
      throw err
    }
  }
  update(id, { status: 'posted', posted_at: Date.now(), findings: JSON.stringify(all), verdict: event })
  sessions.delete(id)
  broadcast('review', { id, review: get(id) })
  return get(id)
}

const ghApi = (endpoint, body) =>
  new Promise((resolve, reject) => {
    const p = execFile('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    )
    p.on('error', reject)
    p.stdin.on('error', reject) // gh can die before the body is written
    p.stdin.end(body)
  })

// --- http -----------------------------------------------------------------

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 1e6) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch (e) {
        reject(e)
      }
    })
  })

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const seg = url.pathname.split('/').filter(Boolean) // ['api', 'reviews', id, action]

  try {
    if (seg[0] !== 'api') return json(res, 404, { error: 'not found' })

    if (req.method === 'GET' && seg[1] === 'models') return json(res, 200, MODELS)

    if (req.method === 'GET' && seg[1] === 'settings') {
      return json(res, 200, { prompt: setting('prompt') ?? skillPrompt(), model: setting('model') ?? '' })
    }

    if (req.method === 'POST' && seg[1] === 'settings') {
      const body = await readBody(req)
      const model = String(body.model ?? '')
      if (!MODELS.some((m) => m.id === model)) return json(res, 400, { error: `${model} is not a model you can pick` })
      // An empty prompt is a reset, not a review with no instructions.
      setSetting('prompt', String(body.prompt ?? '').trim())
      setSetting('model', model)
      return json(res, 200, { prompt: setting('prompt') ?? skillPrompt(), model })
    }

    if (req.method === 'GET' && seg[1] === 'repos') return json(res, 200, allRepos())

    if (req.method === 'POST' && seg[1] === 'repos') {
      const { path: dir } = await readBody(req)
      return json(res, 200, await addRepo(dir))
    }

    if (req.method === 'DELETE' && seg[1] === 'repos' && seg[2]) {
      db.prepare('delete from repos where name = ?').run(decodeURIComponent(seg[2]))
      return json(res, 200, { ok: true })
    }

    if (req.method === 'GET' && seg[1] === 'sessions') {
      // The row is the database's; the session only holds what it cannot store.
      const live = [...sessions.entries()]
        .map(([id, s]) => {
          const row = get(id)
          return row && { ...row, events: s.events, thinking: s.thinking }
        })
        .filter(Boolean)
      // A staged or finished review waiting on a decision lives in memory, so a
      // restart would strand it in the database with nothing showing it. Bring
      // those back, without their logs.
      const pending = db
        .prepare("select * from reviews where status in ('staged', 'done', 'failed') order by created_at desc")
        .all()
        .filter((r) => !sessions.has(r.id))
        .map((r) => ({ ...r, events: [] }))
      return json(res, 200, [...live, ...pending])
    }

    if (req.method === 'GET' && seg[1] === 'stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')
      clients.add(res)
      // A throw in a timer callback is uncaught and takes the server with it,
      // so a socket that died without firing 'close' is dropped here instead.
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(ping)
          clients.delete(res)
        }
      }, 25000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }

    if (req.method === 'GET' && seg[1] === 'archive') {
      const rows = db
        .prepare("select * from reviews where status in ('posted', 'discarded') order by created_at desc")
        .all()
      return json(res, 200, rows)
    }

    if (req.method === 'POST' && seg[1] === 'reviews' && !seg[2]) {
      const { repo, pr } = await readBody(req)
      const n = Number(String(pr).replace('#', '').trim())
      if (!Number.isInteger(n) || n <= 0) return json(res, 400, { error: `"${pr}" is not a PR number` })
      return json(res, 200, await stageReview(repo, n))
    }

    if (req.method === 'POST' && seg[3] === 'start') {
      const { model } = await readBody(req)
      return json(res, 200, await startReview(seg[2], model ?? setting('model') ?? ''))
    }

    if (req.method === 'GET' && seg[3] === 'diff') {
      const row = get(seg[2])
      if (!row) return json(res, 404, { error: 'unknown review' })
      const repo = getRepo(row.repo)
      if (!repo) return json(res, 400, { error: `${row.repo} is no longer in your repos` })
      // A big PR produces a big diff, so give it room.
      const { stdout } = await run('gh', ['pr', 'diff', String(row.pr)], {
        cwd: repo.path,
        maxBuffer: 32 * 1024 * 1024,
      })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(stdout)
    }

    if (req.method === 'POST' && seg[3] === 'comments') {
      const { path: file, line, body } = await readBody(req)
      const row = get(seg[2])
      if (!row) return json(res, 404, { error: 'unknown review' })
      if (!file || !Number.isInteger(line) || !String(body ?? '').trim()) {
        return json(res, 400, { error: 'a comment needs a file, a line and a body' })
      }
      const comments = [...JSON.parse(row.comments || '[]'), { path: file, line, body: String(body).trim(), mine: true }]
      update(seg[2], { comments: JSON.stringify(comments) })
      broadcast('review', { id: seg[2], review: get(seg[2]) })
      return json(res, 200, get(seg[2]))
    }

    if (req.method === 'DELETE' && seg[3] === 'comments' && seg[4] !== undefined) {
      const row = get(seg[2])
      if (!row) return json(res, 404, { error: 'unknown review' })
      const comments = JSON.parse(row.comments || '[]').filter((_, i) => i !== Number(seg[4]))
      update(seg[2], { comments: JSON.stringify(comments) })
      broadcast('review', { id: seg[2], review: get(seg[2]) })
      return json(res, 200, get(seg[2]))
    }

    if (req.method === 'POST' && seg[3] === 'post') {
      const { findings } = await readBody(req)
      return json(res, 200, await postReview(seg[2], findings ?? []))
    }

    if (req.method === 'POST' && seg[3] === 'discard') {
      if (!get(seg[2])) return json(res, 404, { error: 'unknown review' })
      const live = sessions.get(seg[2])
      if (live) {
        clearTimeout(live.timer)
        stop(live.proc) // otherwise it keeps running, and spending, unwatched
        sessions.delete(seg[2])
      }
      update(seg[2], { status: 'discarded' })
      broadcast('review', { id: seg[2], review: get(seg[2]) })
      return json(res, 200, get(seg[2]))
    }

    if (req.method === 'DELETE' && seg[1] === 'reviews' && seg[2]) {
      // Removing takes the card away for good. A review still running is killed
      // first, otherwise the process carries on with nothing listening.
      const live = sessions.get(seg[2])
      if (live) {
        clearTimeout(live.timer)
        stop(live.proc)
        sessions.delete(seg[2])
      }
      db.prepare('delete from reviews where id = ?').run(seg[2])
      broadcast('removed', { id: seg[2] })
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    console.error(err)
    return json(res, err.status ?? 500, { error: err.message })
  }
}).listen(PORT, () => console.log(`pr-sir server on http://localhost:${PORT}`))
