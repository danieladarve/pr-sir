import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { addTokens, summarise } from './metrics.mjs'
import { ndjson } from './ndjson.mjs'
import { isOutdated } from './version.mjs'
import { ownerRepo, reviewPayload } from './payload.mjs'
import { pickCommit, pickPrompt } from './prompt.mjs'
import { reviewResult } from './result.mjs'

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

// Claude Code's own review, with none of our instructions in front of it. Not a
// saved prompt, so it cannot be edited, renamed or deleted.
const CODE_REVIEW = 'Claude /code-review'
const CODE_REVIEW_NOTE = `Runs Claude Code's own /code-review on the PR, with no prompt of ours in front of it.

Nothing here to edit. The findings come back in the same shape either way, because the schema is what holds them to it, not the prompt.

Needs a claude that has /code-review. An older one will read the line as plain text and review something else.

/code-review takes a PR, not a commit. A review pinned to one commit still asks for it in words, so this prompt holds to it less tightly than the others.`

// SKILL.md is the starting point, not the last word: a saved prompt wins, and a
// review left with none falls back to the file again.
const prompt = (pr, name, scope = '') => {
  if (name === CODE_REVIEW) {
    return `/code-review ${pr}\n\nReport the findings as the JSON in the schema rather than as text.${scope}`
  }
  const md = (name && promptBody(name)) ?? skillPrompt()
  return `${md}\n\nReview PR ${pr} now. Return the JSON from section 6 and nothing else.${scope}`
}

// What pins a review to one commit. Read from GitHub rather than the clone,
// because nothing is checked out for a review and the branch may never have
// been fetched.
const commitDiffCmd = (row) => {
  const { owner, repo } = ownerRepo(row.url)
  return `gh api repos/${owner}/${repo}/commits/${row.commit_sha} -H 'Accept: application/vnd.github.v3.diff'`
}

const scopeNote = (row) =>
  row.commit_sha
    ? `\n\nReview only commit ${row.commit_sha} of PR ${row.pr}. Read it with \`${commitDiffCmd(row)}\` rather than gh pr diff. What the rest of the PR changed is context, not your scope, so do not report on it.`
    : ''

// The picked model becomes a spawn argument. Anything not on this list is
// refused, so a crafted value cannot smuggle in another flag.
const MODELS = [
  { id: '', name: 'Default', note: 'whatever your claude config uses' },
  { id: 'fable', name: 'Fable', note: 'most capable, most expensive' },
  { id: 'opus', name: 'Opus', note: 'very capable, expensive' },
  { id: 'sonnet', name: 'Sonnet', note: 'faster and cheaper' },
  { id: 'haiku', name: 'Haiku', note: 'cheapest, for small diffs' },
]

// Same deal as the models: a fixed list, so nothing else reaches the spawn.
// No empty entry here: claude's own default is medium, so this list says so
// rather than leaving it to config.
const EFFORT_DEFAULT = 'medium'
const EFFORTS = [
  { id: 'low', name: 'Low', note: 'quickest, least thinking' },
  { id: 'medium', name: 'Medium', note: '' },
  { id: 'high', name: 'High', note: '' },
  { id: 'xhigh', name: 'Extra high', note: '' },
  { id: 'max', name: 'Max', note: 'slowest, most thinking' },
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

// Overridable so a throwaway copy can be pointed at for testing, rather than
// the database holding your real settings and reviews.
const DATA = process.env.PR_SIR_DATA || path.join(root, 'data')
mkdirSync(DATA, { recursive: true })
const db = new DatabaseSync(path.join(DATA, 'pr-sir.db'))
db.exec(`create table if not exists reviews (
  id text primary key, repo text, pr integer, title text, author text, url text,
  head_sha text, status text, verdict text, summary text, findings text,
  cost_usd real, error text, created_at integer, posted_at integer
)`)

db.exec('create table if not exists repos (name text primary key, path text not null, nwo text)')

db.exec('create table if not exists settings (key text primary key, value text not null)')

// The only place a review prompt lives. Named, so a repo can ask for one by name.
db.exec('create table if not exists prompts (name text primary key, body text not null)')

const setting = (key) => db.prepare('select value from settings where key = ?').get(key)?.value
const setSetting = (key, value) =>
  value
    ? db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value)
    : db.prepare('delete from settings where key = ?').run(key)

for (const col of [
  'pr_created_at integer',
  "comments text not null default '[]'",
  'model text',
  'effort text',
  'started_at integer',
  'finished_at integer',
  'tokens integer',
  'prompt text',
  'commit_sha text',
]) {
  try {
    db.exec(`alter table reviews add column ${col}`)
  } catch {
    // already there
  }
}

try {
  db.exec('alter table repos add column prompt text')
} catch {
  // already there
}

db.exec("update reviews set status = 'failed', error = 'server restarted' where status = 'running'")

// One-time import so the repos.json this started life with is not lost.
if (db.prepare('select count(*) as n from repos').get().n === 0 && existsSync(path.join(root, 'repos.json'))) {
  const seed = JSON.parse(readFileSync(path.join(root, 'repos.json'), 'utf8'))
  const ins = db.prepare('insert or ignore into repos (name, path) values (?, ?)')
  for (const r of seed) ins.run(r.name, r.path)
  console.log(`imported ${seed.length} repos from repos.json`)
}

// The built-in leads the list so it is offered everywhere a saved one is, and
// carries a flag so the editor can leave it alone.
const allPrompts = () => [
  { name: CODE_REVIEW, body: CODE_REVIEW_NOTE, builtin: true },
  ...db.prepare('select name, body from prompts order by name').all(),
]
const promptNames = () => allPrompts().map((p) => p.name)
const promptBody = (name) => db.prepare('select body from prompts where name = ?').get(name)?.body

// The prompt used to be a single settings row. Move it under a name rather than
// leaving a second copy behind to drift.
if (db.prepare('select count(*) as n from prompts').get().n === 0) {
  db.prepare('insert into prompts (name, body) values (?, ?)').run('Default', setting('prompt') ?? skillPrompt())
  setSetting('prompt', '')
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
  broadcast('event', { id, event, tokens: s.tokens })
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

/** What the finished reviews add up to, by day, by repo and by author. Posted
 *  and discarded only, so it counts decisions rather than attempts. */
function analytics(days) {
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0
  const rows = db
    .prepare("select * from reviews where status in ('posted', 'discarded') and created_at >= ?")
    .all(since)
  return { days, ...summarise(rows) }
}

// GitHub is asked once every six hours, not once per page load.
let versionCache = null

/** What is running here against the newest release of it on GitHub. The repo
 *  comes from this checkout's own remote, so a fork checks its own releases. */
async function version() {
  if (versionCache && Date.now() - versionCache.at < 6 * 3_600_000) return versionCache.data
  const current = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  let latest = null
  try {
    // Fails when there are no releases yet, when gh is not logged in, and when
    // the machine is offline. None of those are worth an error on screen.
    const { stdout } = await run('gh', ['release', 'view', '--json', 'tagName', '-q', '.tagName'], { cwd: root })
    latest = stdout.trim() || null
  } catch {
    latest = null
  }
  const data = { current, latest, outdated: isOutdated(current, latest) }
  versionCache = { at: Date.now(), data }
  return data
}

/** Everything open on the repo right now, whether or not it has a card here. */
async function openPrs(repoName) {
  const repo = getRepo(repoName)
  if (!repo) throw Object.assign(new Error(`unknown repo ${repoName}`), { status: 400 })
  const { stdout } = await run(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url,author,createdAt,isDraft'],
    { cwd: repo.path },
  )
  // A PR already on a card is marked rather than hidden, so the list still
  // matches what GitHub shows.
  const staged = new Set(
    db
      .prepare("select pr from reviews where repo = ? and status in ('staged', 'running', 'done')")
      .all(repoName)
      .map((r) => r.pr),
  )
  return JSON.parse(stdout).map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author?.login ?? 'unknown',
    created_at: Date.parse(p.createdAt) || null,
    draft: p.isDraft,
    queued: staged.has(p.number),
  }))
}

/** The commits on a PR, oldest first, as GitHub lists them. */
async function prCommits(row) {
  const repo = getRepo(row.repo)
  if (!repo) throw Object.assign(new Error(`${row.repo} is no longer in your repos`), { status: 400 })
  const { stdout } = await run('gh', ['pr', 'view', String(row.pr), '--json', 'commits'], { cwd: repo.path })
  return JSON.parse(stdout).commits.map((c) => ({
    sha: c.oid,
    subject: c.messageHeadline,
    author: c.authors?.[0]?.login || c.authors?.[0]?.name || 'unknown',
    date: Date.parse(c.committedDate) || null,
  }))
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
  sessions.set(id, { events: [], proc: null, cost: 0, tokens: 0, counted: new Set() })
  broadcast('session', { session: { ...get(id), events: [] } })
  return get(id)
}

async function startReview(id, model = '', effort = EFFORT_DEFAULT, picked = '') {
  const row = get(id)
  if (!row) throw Object.assign(new Error('unknown review'), { status: 404 })
  if (row.status !== 'staged') throw Object.assign(new Error(`already ${row.status}`), { status: 409 })
  const repo = getRepo(row.repo)
  if (!repo) throw Object.assign(new Error(`unknown repo ${row.repo}`), { status: 400 })
  if (!MODELS.some((m) => m.id === model)) {
    throw Object.assign(new Error(`${model} is not a model you can pick`), { status: 400 })
  }
  if (!EFFORTS.some((e) => e.id === effort)) {
    throw Object.assign(new Error(`${effort} is not an effort you can pick`), { status: 400 })
  }

  // Resolved here rather than at spawn: row was read before the update, so
  // reading row.prompt back would give the stale null.
  const promptName = pickPrompt(picked, repo.prompt, promptNames())

  update(id, {
    status: 'running',
    model: model || null,
    effort: effort || null,
    prompt: promptName,
    started_at: Date.now(),
  })

  const proc = spawn(
    'claude',
    [
      '-p',
      prompt(row.pr, promptName, scopeNote(row)),
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
      ...(effort ? ['--effort', effort] : []),
    ],
    // detached puts it in its own process group, so stop() can take the whole
    // tree down rather than just claude, leaving a wedged grandchild running.
    { cwd: repo.path, detached: true },
  )

  sessions.set(id, {
    events: sessions.get(id)?.events ?? [],
    proc,
    cost: 0,
    tokens: 0,
    counted: new Set(),
  })
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

  addTokens(s, event)
  push(id, event)

  if (typeof event.total_cost_usd === 'number') s.cost = event.total_cost_usd

  if (event.type !== 'result') return

  if (event.is_error || event.subtype !== 'success') {
    finish(id, { status: 'failed', error: String(event.result ?? event.subtype ?? 'review failed').slice(0, 2000) })
    return
  }
  finish(id, reviewResult(event.result))
}

function finish(id, fields) {
  const s = sessions.get(id)
  const cost_usd = s?.cost ?? 0
  update(id, { ...fields, cost_usd, tokens: s?.tokens ?? 0, finished_at: Date.now() })
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

    if (req.method === 'GET' && seg[1] === 'efforts') return json(res, 200, EFFORTS)

    if (req.method === 'GET' && seg[1] === 'settings') {
      return json(res, 200, {
        model: setting('model') ?? '',
        effort: setting('effort') ?? EFFORT_DEFAULT,
        open_prs: setting('open_prs') === '1',
      })
    }

    if (req.method === 'POST' && seg[1] === 'settings') {
      const body = await readBody(req)
      const model = String(body.model ?? '')
      const effort = String(body.effort || EFFORT_DEFAULT)
      if (!MODELS.some((m) => m.id === model)) return json(res, 400, { error: `${model} is not a model you can pick` })
      if (!EFFORTS.some((e) => e.id === effort)) {
        return json(res, 400, { error: `${effort} is not an effort you can pick` })
      }
      setSetting('model', model)
      // Stored either way, so the picker shows what a review will actually run.
      setSetting('effort', effort)
      setSetting('open_prs', body.open_prs ? '1' : '')
      return json(res, 200, { model, effort, open_prs: setting('open_prs') === '1' })
    }

    if (req.method === 'GET' && seg[1] === 'repos' && seg[3] === 'prs' && !seg[4]) {
      return json(res, 200, await openPrs(decodeURIComponent(seg[2])))
    }

    // The diff of a PR nobody has staged yet, so there is no review row to hang
    // it off. Read only: comments belong to a review.
    if (req.method === 'GET' && seg[1] === 'repos' && seg[3] === 'prs' && seg[5] === 'diff') {
      const repo = getRepo(decodeURIComponent(seg[2]))
      if (!repo) return json(res, 400, { error: `unknown repo ${seg[2]}` })
      const n = Number(seg[4])
      if (!Number.isInteger(n) || n <= 0) return json(res, 400, { error: `"${seg[4]}" is not a PR number` })
      const { stdout } = await run('gh', ['pr', 'diff', String(n)], {
        cwd: repo.path,
        maxBuffer: 32 * 1024 * 1024,
      })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(stdout)
    }

    if (req.method === 'GET' && seg[1] === 'repos' && !seg[2]) return json(res, 200, allRepos())

    if (req.method === 'POST' && seg[1] === 'repos' && !seg[2]) {
      const { path: dir } = await readBody(req)
      return json(res, 200, await addRepo(dir))
    }

    if (req.method === 'POST' && seg[1] === 'repos' && seg[2] && seg[3] === 'prompt') {
      const name = decodeURIComponent(seg[2])
      if (!getRepo(name)) return json(res, 400, { error: `unknown repo ${name}` })
      const body = await readBody(req)
      const picked = String(body.prompt ?? '').trim()
      if (picked && !promptNames().includes(picked)) {
        return json(res, 400, { error: `there is no prompt called ${picked}` })
      }
      db.prepare('update repos set prompt = ? where name = ?').run(picked || null, name)
      return json(res, 200, getRepo(name))
    }

    if (req.method === 'DELETE' && seg[1] === 'repos' && seg[2]) {
      db.prepare('delete from repos where name = ?').run(decodeURIComponent(seg[2]))
      return json(res, 200, { ok: true })
    }

    if (req.method === 'GET' && seg[1] === 'prompts' && !seg[2]) return json(res, 200, allPrompts())

    // The copy shipped in SKILL.md, so a prompt can be put back to it.
    if (req.method === 'GET' && seg[1] === 'skill-prompt') return json(res, 200, { body: skillPrompt() })

    if (req.method === 'POST' && seg[1] === 'prompts' && !seg[2]) {
      const body = await readBody(req)
      const name = String(body.name ?? '').trim()
      const text = String(body.body ?? '').trim()
      const rename = String(body.rename ?? '').trim()
      if (!name) return json(res, 400, { error: 'a prompt needs a name' })
      if (name === CODE_REVIEW || rename === CODE_REVIEW) {
        return json(res, 400, { error: `${CODE_REVIEW} is built in, so it cannot be edited` })
      }
      if (name.length > 60) return json(res, 400, { error: 'that name is too long' })
      // Not a review with no instructions.
      if (!text) return json(res, 400, { error: 'a prompt needs a body' })
      if (rename && rename !== name) {
        if (rename === 'Default') return json(res, 400, { error: 'Default is the fallback, so it keeps its name' })
        if (!promptBody(rename)) return json(res, 400, { error: `there is no prompt called ${rename}` })
        if (promptBody(name)) return json(res, 409, { error: `${name} is taken` })
        db.prepare('update prompts set name = ?, body = ? where name = ?').run(name, text, rename)
        // The name is the key everything else points at, so carry the pointers.
        db.prepare('update repos set prompt = ? where prompt = ?').run(name, rename)
        db.prepare('update reviews set prompt = ? where prompt = ?').run(name, rename)
      } else {
        db.prepare('insert or replace into prompts (name, body) values (?, ?)').run(name, text)
      }
      return json(res, 200, allPrompts())
    }

    if (req.method === 'DELETE' && seg[1] === 'prompts' && seg[2]) {
      const name = decodeURIComponent(seg[2])
      // Default is the end of the fallback chain, so it cannot go.
      if (name === 'Default') return json(res, 400, { error: 'Default is the fallback, so it stays' })
      if (name === CODE_REVIEW) return json(res, 400, { error: `${CODE_REVIEW} is built in, so it stays` })
      db.prepare('delete from prompts where name = ?').run(name)
      db.prepare('update repos set prompt = null where prompt = ?').run(name)
      return json(res, 200, allPrompts())
    }

    if (req.method === 'GET' && seg[1] === 'sessions') {
      // The row is the database's; the session only holds what it cannot store.
      const live = [...sessions.entries()]
        .map(([id, s]) => {
          const row = get(id)
          return row && { ...row, events: s.events, thinking: s.thinking, tokens: s.tokens ?? row.tokens }
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

    if (req.method === 'GET' && seg[1] === 'version') return json(res, 200, await version())

    if (req.method === 'GET' && seg[1] === 'analytics') {
      // Absent means the default range. Explicit 0 means everything.
      const raw = url.searchParams.get('days')
      const days = Number(raw)
      return json(res, 200, analytics(raw && Number.isInteger(days) && days >= 0 ? days : 90))
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
      const { model, effort, prompt: picked } = await readBody(req)
      return json(
        res,
        200,
        await startReview(
          seg[2],
          model ?? setting('model') ?? '',
          effort || setting('effort') || EFFORT_DEFAULT,
          String(picked ?? ''),
        ),
      )
    }

    if (req.method === 'GET' && seg[3] === 'diff') {
      const row = get(seg[2])
      if (!row) return json(res, 404, { error: 'unknown review' })
      const repo = getRepo(row.repo)
      if (!repo) return json(res, 400, { error: `${row.repo} is no longer in your repos` })
      // A big PR produces a big diff, so give it room.
      const opts = { cwd: repo.path, maxBuffer: 32 * 1024 * 1024 }
      // A review pinned to one commit reads that commit, and reads it from
      // GitHub: nothing is checked out here, so the clone may not have it.
      const { owner, repo: name } = row.commit_sha ? ownerRepo(row.url) : {}
      const { stdout } = row.commit_sha
        ? await run(
            'gh',
            ['api', `repos/${owner}/${name}/commits/${row.commit_sha}`, '-H', 'Accept: application/vnd.github.v3.diff'],
            opts,
          )
        : await run('gh', ['pr', 'diff', String(row.pr)], opts)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(stdout)
    }

    if (req.method === 'GET' && seg[3] === 'commits') {
      const row = get(seg[2])
      if (!row) return json(res, 404, { error: 'unknown review' })
      return json(res, 200, await prCommits(row))
    }

    // Which commit this review reads. An empty value puts it back to the whole
    // PR. Only while it is staged: moving the scope under a running review
    // would leave the log and the findings describing different things.
    if (req.method === 'POST' && seg[3] === 'commit') {
      const row = get(seg[2])
      if (!row) return json(res, 404, { error: 'unknown review' })
      if (row.status !== 'staged') return json(res, 409, { error: `already ${row.status}` })
      const { commit } = await readBody(req)
      const want = String(commit ?? '').trim()
      let sha = null
      if (want) {
        sha = pickCommit(want, (await prCommits(row)).map((c) => c.sha))
        if (!sha) return json(res, 400, { error: `${want} is not a commit on #${row.pr}` })
      }
      update(seg[2], { commit_sha: sha })
      broadcast('review', { id: seg[2], review: get(seg[2]) })
      return json(res, 200, get(seg[2]))
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
