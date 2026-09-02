import assert from 'node:assert'
import { ndjson } from './ndjson.mjs'

const events = [
  { type: 'system', subtype: 'init', session_id: 'a' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'hi\\nthere' }] } },
  { type: 'result', result: '{"verdict":"APPROVE"}', total_cost_usd: 0.04 },
]
const wire = events.map((e) => JSON.stringify(e)).join('\n') + '\n'

// Every possible split point, one byte at a time, must yield the same events.
for (const size of [1, 2, 7, 13, 64, 999, wire.length]) {
  const got = []
  const feed = ndjson((e) => got.push(e))
  for (let i = 0; i < wire.length; i += size) feed(wire.slice(i, i + size))
  assert.deepStrictEqual(got, events, `chunk size ${size}`)
}

// Garbage on its own line must not stop the events after it.
{
  const got = []
  const feed = ndjson((e) => got.push(e))
  feed('not json\n' + JSON.stringify(events[0]) + '\n')
  assert.deepStrictEqual(got, [events[0]])
}

// An unterminated tail stays buffered rather than being parsed early.
{
  const got = []
  const feed = ndjson((e) => got.push(e))
  feed('{"type":"result","total_cost')
  assert.deepStrictEqual(got, [])
  feed('_usd":1}\n')
  assert.deepStrictEqual(got, [{ type: 'result', total_cost_usd: 1 }])
}

console.log('ndjson ok')

// --- the payload that reaches GitHub under a real name --------------------

import { reviewPayload } from './payload.mjs'

const row = {
  url: 'https://github.com/octocat/hello-world/pull/8',
  pr: 8,
  head_sha: 'abc123',
  verdict: 'REQUEST_CHANGES',
  summary: 'The cart total drops the discount when the voucher has expired.',
}

{
  const { endpoint, payload } = reviewPayload(row, [
    { path: 'src/Cart.php', line: 42, severity: 'bug', body: 'Guard it.' },
  ])
  assert.strictEqual(endpoint, 'repos/octocat/hello-world/pulls/8/reviews')
  assert.deepStrictEqual(JSON.parse(payload), {
    commit_id: 'abc123',
    body: row.summary,
    event: 'REQUEST_CHANGES',
    comments: [{ path: 'src/Cart.php', line: 42, side: 'RIGHT', body: 'Guard it.' }],
  })
}

// Unchecking every finding approves, and must not post the "here is what broke"
// summary as the approval body.
{
  const { payload } = reviewPayload(row, [])
  const sent = JSON.parse(payload)
  assert.strictEqual(sent.event, 'APPROVE')
  assert.strictEqual(sent.body, 'Approved.')
  assert.deepStrictEqual(sent.comments, [])
}

// A review posted without running the agent has no summary, and must not post
// null as the body.
{
  const { payload } = reviewPayload({ ...row, verdict: null, summary: null }, [
    { path: 'a.php', line: 1, body: 'mine' },
  ])
  const sent = JSON.parse(payload)
  assert.strictEqual(sent.event, 'REQUEST_CHANGES')
  assert.strictEqual(sent.body, 'Requesting changes.')
}

// An agent that found nothing keeps its own summary on the approval.
{
  const { payload } = reviewPayload({ ...row, verdict: 'APPROVE', summary: 'Totals look right.' }, [])
  assert.strictEqual(JSON.parse(payload).body, 'Totals look right.')
}

// A url the regex cannot read must throw rather than post somewhere unintended.
assert.throws(() => reviewPayload({ ...row, url: 'https://example.com/nope' }, []))

console.log('payload ok')

// --- diff parsing, which decides where a comment lands -------------------

import { parseDiff } from './src/lib/diff.ts'

const sample = [
  'diff --git a/src/Cart.php b/src/Cart.php',
  'index 1111111..2222222 100644',
  '--- a/src/Cart.php',
  '+++ b/src/Cart.php',
  '@@ -10,6 +10,7 @@ class Cart',
  '     public function total()',
  '     {',
  '-        return $this->sum;',
  '+        $discount = $this->voucher?->amount ?? 0;',
  '+        return $this->sum - $discount;',
  '     }',
  '@@ -40,2 +41,2 @@ class Cart',
  '-    private $old;',
  '+    private $new;',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1,2 @@',
  '+# Title',
  '+body',
  '',
].join('\n')

const files = parseDiff(sample)
assert.deepStrictEqual(files.map((f) => f.path), ['src/Cart.php', 'README.md'])

// New-file numbering must survive a deletion and restart at the next hunk.
const cart = files[0].lines
assert.deepStrictEqual(
  cart.filter((l) => l.kind === 'add').map((l) => [l.text.trim(), l.newLine]),
  [
    ['$discount = $this->voucher?->amount ?? 0;', 12],
    ['return $this->sum - $discount;', 13],
    ['private $new;', 41],
  ],
)
// A deleted line has no new-file number, so it can never be commented on.
assert.ok(cart.filter((l) => l.kind === 'del').every((l) => l.newLine === undefined))
// Context lines keep counting.
assert.deepStrictEqual(
  cart.filter((l) => l.kind === 'ctx').map((l) => l.newLine),
  [10, 11, 14],
)
// A new file starts at 1.
assert.deepStrictEqual(files[1].lines.filter((l) => l.kind === 'add').map((l) => l.newLine), [1, 2])
// The trailing newline must not invent a blank context line.
assert.strictEqual(files[1].lines.at(-1).text, 'body')

// Content that looks like a diff header must not be skipped inside a hunk.
// Skipping it shifts every anchor below by one and puts comments on the wrong line.
{
  const tricky = parseDiff(
    [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1,1 +1,4 @@',
      ' first',
      '+++ starts with plus plus',
      '-- starts with minus minus',
      '+after',
      '',
    ].join('\n'),
  )[0].lines
  assert.deepStrictEqual(
    tricky.filter((l) => l.kind === 'add').map((l) => [l.text, l.newLine]),
    [
      ['++ starts with plus plus', 2],
      ['after', 3],
    ],
  )
  assert.deepStrictEqual(
    tricky.filter((l) => l.kind === 'del').map((l) => l.text),
    ['- starts with minus minus'],
  )
}

// git quotes a path that has a space, and the whole review fails if the path
// posted to GitHub is wrong.
assert.strictEqual(
  parseDiff('diff --git "a/my file.php" "b/my file.php"\n@@ -1,1 +1,1 @@\n+x\n')[0].path,
  'my file.php',
)

// Binary files are kept as a note rather than dropped.
const bin = parseDiff('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n')
assert.strictEqual(bin[0].lines[0].kind, 'meta')

console.log('diff ok')

// --- what a run costs and what the finished reviews add up to --------------

import { addTokens, median, summarise } from './metrics.mjs'

// One message arrives as several events repeating the same usage. Counting each
// event would roughly double every number on the card.
{
  const state = { tokens: 0, counted: new Set() }
  const usage = { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }
  const thinking = { type: 'assistant', message: { id: 'msg_1', usage, content: [{ type: 'thinking' }] } }
  const text = { type: 'assistant', message: { id: 'msg_1', usage, content: [{ type: 'text' }] } }
  assert.strictEqual(addTokens(state, thinking), 1114)
  assert.strictEqual(addTokens(state, text), 1114, 'the same message id must not count twice')
  assert.strictEqual(addTokens(state, { type: 'assistant', message: { id: 'msg_2', usage } }), 2228)
  // Events with no usage at all, which is most of them.
  assert.strictEqual(addTokens(state, { type: 'system', subtype: 'init' }), 2228)
  assert.strictEqual(addTokens(state, { type: 'result' }), 2228)
}

assert.strictEqual(median([]), null)
assert.strictEqual(median([5]), 5)
assert.strictEqual(median([3, 1, 2]), 2)
assert.strictEqual(median([1, 2, 3, 4]), 3, 'an even count averages the middle pair')

{
  const at = (iso) => Date.parse(iso)
  const finding = { path: 'a.php', line: 1, severity: 'bug', body: 'x' }
  const rows = [
    { repo: 'api', author: 'ana', status: 'posted', findings: JSON.stringify([finding, finding]),
      cost_usd: 0.5, tokens: 1000, created_at: at('2026-08-27T01:00:00Z'),
      started_at: 1000, finished_at: 1000 + 120_000, posted_at: 1000 + 120_000 + 60_000 },
    { repo: 'api', author: 'bob', status: 'discarded', findings: JSON.stringify([finding, finding, finding]),
      cost_usd: 0.25, tokens: 500, created_at: at('2026-08-27T02:00:00Z'),
      started_at: 1000, finished_at: 1000 + 300_000, posted_at: null },
    // No run timestamps, which is every review from before they were recorded.
    { repo: 'web', author: 'ana', status: 'posted', findings: '[]',
      cost_usd: 0.25, tokens: 500, created_at: at('2026-08-26T01:00:00Z'),
      started_at: null, finished_at: null, posted_at: at('2026-08-26T02:00:00Z') },
  ]
  const out = summarise(rows)

  assert.deepStrictEqual(out.totals, {
    reviews: 3,
    posted: 2,
    discarded: 1,
    // A discarded review's findings never went anywhere, so they do not count.
    findings: 2,
    cost_usd: 1,
    tokens: 2000,
    median_run_ms: 210_000,
    // Only the one posted review that has both timestamps.
    median_to_post_ms: 60_000,
  })

  // Sorted by review count, and a repo with one review still reports.
  assert.deepStrictEqual(out.repos.map((r) => [r.name, r.reviews, r.findings]), [
    ['api', 2, 2],
    ['web', 1, 0],
  ])
  assert.strictEqual(out.repos[1].median_run_ms, null, 'no timestamps means no median, not zero')
  assert.deepStrictEqual(out.authors.map((a) => [a.name, a.reviews]), [['ana', 2], ['bob', 1]])

  // One entry per day with activity, oldest first, counted both ways.
  assert.deepStrictEqual(out.series, [
    { date: '2026-08-26', repos: { web: 1 }, authors: { ana: 1 } },
    { date: '2026-08-27', repos: { api: 2 }, authors: { ana: 1, bob: 1 } },
  ])

  assert.deepStrictEqual(summarise([]).totals.reviews, 0)
  assert.deepStrictEqual(summarise([]).repos, [])
}

console.log('metrics ok')

// --- am I behind the latest release ---------------------------------------

import { isOutdated } from './version.mjs'

assert.strictEqual(isOutdated('0.1.0', '0.2.0'), true)
assert.strictEqual(isOutdated('0.1.0', '0.1.0'), false)
assert.strictEqual(isOutdated('0.2.0', '0.1.0'), false, 'ahead of the release is not behind it')
// The reason this is not a string comparison: '0.9.0' > '0.10.0' alphabetically.
assert.strictEqual(isOutdated('0.9.0', '0.10.0'), true)
assert.strictEqual(isOutdated('0.10.0', '0.9.0'), false)
assert.strictEqual(isOutdated('1.0.0', '10.0.0'), true)
// The tag carries a v, package.json does not.
assert.strictEqual(isOutdated('0.1.0', 'v0.2.0'), true)
assert.strictEqual(isOutdated('0.1.0', 'v0.1.0'), false)
// No answer from GitHub, no nagging.
assert.strictEqual(isOutdated('0.1.0', null), false)
assert.strictEqual(isOutdated('0.1.0', ''), false)

console.log('version ok')

// --- which saved prompt a review runs on -----------------------------------

import { pickCommit, pickPrompt } from './prompt.mjs'

const saved = ['Default', 'Frontend', 'Laravel']

// The review's own pick beats the repo's.
assert.strictEqual(pickPrompt('Frontend', 'Laravel', saved), 'Frontend')
// Nothing picked for the review, so the repo decides.
assert.strictEqual(pickPrompt('', 'Laravel', saved), 'Laravel')
// Neither, so Default.
assert.strictEqual(pickPrompt('', '', saved), 'Default')
assert.strictEqual(pickPrompt('', null, saved), 'Default')
// A profile deleted since it was picked is skipped, not followed.
assert.strictEqual(pickPrompt('Gone', 'Laravel', saved), 'Laravel')
assert.strictEqual(pickPrompt('Gone', 'Also gone', saved), 'Default')
// Nothing saved at all, so the caller falls back to SKILL.md.
assert.strictEqual(pickPrompt('Frontend', 'Laravel', []), null)

// --- which commit a review is pinned to -----------------------------------

const oids = ['a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'a1b2c3daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ffee0099887766554433221100aabbccddeeff00']

// The full sha, and a prefix long enough to name one commit.
assert.strictEqual(pickCommit(oids[0], oids), oids[0])
assert.strictEqual(pickCommit('a1b2c3d4', oids), oids[0])
assert.strictEqual(pickCommit('  FFEE009  ', oids), oids[2])
// Two commits start the same way, so the prefix names neither.
assert.strictEqual(pickCommit('a1b2c3d', oids), null)
// Short prefixes collide, so they are refused before they are matched.
assert.strictEqual(pickCommit('a1b2c', oids), null)
// A sha from another repo, and anything that is not a sha at all.
assert.strictEqual(pickCommit('0123456789abcdef0123456789abcdef01234567', oids), null)
assert.strictEqual(pickCommit('HEAD~1', oids), null)
assert.strictEqual(pickCommit('', oids), null)
assert.strictEqual(pickCommit(null, oids), null)

console.log('prompt ok')

// --- what the log shows while a subagent does the work --------------------

import { narrate, toLines } from './src/lib/api.ts'

// A review that works through subagents reports only through these, so dropping
// them left the log on "waiting for the agent" for minutes at a time.
assert.deepStrictEqual(
  toLines({ type: 'system', subtype: 'task_started', description: 'Fetch branches and diff stat' }),
  [{ text: 'task  Fetch branches and diff stat', tone: 'tool', depth: 1 }],
)
assert.deepStrictEqual(
  toLines({ type: 'system', subtype: 'task_notification', status: 'completed', summary: 'Fetch branches' }),
  [{ text: 'task completed  Fetch branches', tone: 'meta', depth: 1 }],
)

// A hook_response carries the whole hook output, so it stays out of the log.
assert.deepStrictEqual(toLines({ type: 'system', subtype: 'hook_response', output: 'PONYTAIL MODE' }), [])
assert.deepStrictEqual(toLines({ type: 'system', subtype: 'hook_started' }), [])

// A subtype nobody has taught this about still shows, rather than vanishing.
assert.deepStrictEqual(toLines({ type: 'system', subtype: 'compact_boundary' }), [
  { text: 'compact boundary', tone: 'meta', depth: 0 },
])

// Rate limits only when they are worth saying out loud.
assert.deepStrictEqual(toLines({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), [])
assert.deepStrictEqual(
  toLines({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 },
  }),
  [{ text: 'rate limit seven_day at 80%', tone: 'meta', depth: 0 }],
)

console.log('raw log lines ok')

// --- the same stream, told in words ---------------------------------------

const used = (name, input) => narrate({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

assert.deepStrictEqual(used('Read', { file_path: '/repo/src/Cart.php' }), [
  { text: 'read Cart.php', tone: 'tool', depth: 0 },
])
assert.deepStrictEqual(used('Bash', { command: 'gh pr diff 5990' }), [
  { text: 'ran gh pr diff 5990', tone: 'tool', depth: 0 },
])
assert.deepStrictEqual(used('Skill', { skill: 'caveman:caveman-review' }), [
  { text: 'ran the caveman:caveman-review skill', tone: 'tool', depth: 0 },
])
assert.deepStrictEqual(used('mcp__codebase-memory-mcp__trace_path', { function_name: 'applyDiscount' }), [
  { text: 'traced callers of applyDiscount', tone: 'tool', depth: 0 },
])
// A tool nobody has taught this about still shows, without its underscores.
assert.deepStrictEqual(used('mcp__thing__do_something', { query: 'vouchers' }), [
  { text: 'do something vouchers', tone: 'tool', depth: 0 },
])
// The agent's own bookkeeping says nothing about the review.
assert.deepStrictEqual(used('TodoWrite', { todos: [] }), [])

// What the agent says out loud goes through whole.
assert.deepStrictEqual(narrate({ type: 'assistant', message: { content: [{ type: 'text', text: 'The voucher check runs late.' }] } }), [
  { text: 'The voucher check runs late.', tone: 'text', depth: 0 },
])

// A subagent's work stays indented, the way the raw view does it.
assert.deepStrictEqual(
  narrate({
    type: 'assistant',
    parent_tool_use_id: 'toolu_1',
    message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'applyDiscount' } }] },
  }),
  [{ text: 'searched for applyDiscount', tone: 'tool', depth: 1 }],
)

// The CLI's own chatter goes. The raw view still has it.
assert.deepStrictEqual(narrate({ type: 'system', subtype: 'compact_boundary' }), [])
assert.deepStrictEqual(narrate({ type: 'system', subtype: 'hook_response', output: 'x' }), [])
assert.deepStrictEqual(narrate({ type: 'system', subtype: 'init' }), [
  { text: 'session started', tone: 'meta', depth: 0 },
])
assert.deepStrictEqual(narrate({ type: 'result' }), [{ text: 'review finished', tone: 'meta', depth: 0 }])

console.log('plain log lines ok')

// --- what a finished run leaves on the card --------------------------------

import { reviewResult } from './result.mjs'

// The shape the app is built on.
assert.deepStrictEqual(
  reviewResult('{"verdict":"APPROVE","summary":"reads fine","findings":[]}'),
  { status: 'done', verdict: 'APPROVE', summary: 'reads fine', findings: '[]' },
)
{
  const f = { path: 'a.php', line: 4, severity: 'bug', body: 'off by one' }
  const got = reviewResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', summary: 's', findings: [f] }))
  assert.deepStrictEqual(JSON.parse(got.findings), [f])
}

// Prose instead of the schema, which is what /code-review writes. The review is
// kept as the summary rather than thrown away, and nothing is approved on it.
{
  const got = reviewResult('Reviewed PR #5918. Findings:\n\n- invoice.blade.php:50 subtracts the wrong delta.')
  assert.strictEqual(got.status, 'done')
  assert.strictEqual(got.verdict, 'REQUEST_CHANGES')
  assert.strictEqual(got.findings, '[]')
  assert.match(got.summary, /invoice\.blade\.php:50/)
}

// Valid JSON of the wrong shape goes the same way as prose.
assert.strictEqual(reviewResult('[1,2,3]').verdict, 'REQUEST_CHANGES')
assert.strictEqual(reviewResult('{"summary":"no findings key"}').findings, '[]')
assert.strictEqual(reviewResult('').summary, '')
assert.strictEqual(reviewResult(undefined).summary, '')

// A very long write-up is cut rather than stored whole.
assert.strictEqual(reviewResult('x'.repeat(9000)).summary.length, 8000)

console.log('result ok')
