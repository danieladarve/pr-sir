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
