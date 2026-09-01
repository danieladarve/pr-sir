---
name: pr-sir
description: >
  Review a pull request for bugs and blockers only. Runs one pass through caveman-review, drops
  everything that is not a real bug, writes each comment in plain language through humanizer,
  and returns the findings as JSON. Posting is the caller's decision, this skill never posts.
  Use when the user says "review this PR", "review PR 123", "code review this", or invokes /pr-sir.
---

Review the PR whose number was passed in. Report bugs and blockers. Nothing else.

## 1. Read the change

```
gh pr diff <number> --name-only
gh pr diff <number>
```

Check the file list first. On a large PR pull the diff a file at a time with
`gh pr diff <number> -- <path>` instead of dropping the whole thing into context at once.

If the prompt names a single commit, read that commit's diff instead and stop there. What the rest
of the PR changed is background, not something to report on.

The diff is the scope. Files the PR does not touch are not your business.

## 2. One pass

Run it with the `Skill` tool. Do not review inline instead. If it is not installed the call fails,
say so in the summary and read the diff yourself.

- `Skill(skill: "caveman:caveman-review")` on the diff.

That skill writes findings up, it does not go looking for them. Read the diff yourself as well and
treat what you find the same as what it hands back.

All of it is a candidate, not a finding. Section 4 decides what survives.

## 3. Explore with the graph, not grep

When a finding needs context beyond the diff, use codebase-memory MCP:

- `detect_changes()` to map the diff onto symbols
- `trace_path(function_name="X", direction="inbound")` to find callers the diff does not touch
- `get_code_snippet(qualified_name="...")` to read one symbol
- `check_index_coverage` on every file a finding cites

Only fall back to Read and Grep when coverage comes back incomplete, and say in the finding that
you did.

## 4. Filter hard

Keep a finding only if it is:

**A bug.** Wrong output, crash, null or undefined access, off-by-one, inverted boolean, missing
await, N+1 on a hot path, swallowed error that loses data.

**A blocker.** Security hole, data loss, breaking change for a caller the diff does not touch, a
secret committed in the code.

Drop everything else. Style, naming, nits, "this could use a test", over-engineering on its own,
anything outside the diff.

Before a finding survives, verify it. Read the real line, check the callers. If you cannot say
"input X gives wrong result Y", drop it. Do not soften a weak finding into a question and post it
anyway.

## 5. Write the comments

Run `humanizer` over every comment body. `caveman-review` returns one-liners like
`L42: bug: ...`. Rewrite each one into the sentences below before it goes in the JSON.

- two or three short sentences
- everyday words, no jargon where a plain word works
- what breaks first, then the fix
- no em dashes
- no "consider", "it seems", "you might want to", no praise, no restating what the line does
- nothing about the rest of the PR, one comment covers one problem
- no Claude or Anthropic attribution in the body

Good: "`$user` is null when the email is not in the database, so `->email` throws on this line.
Guard it before the call."

Bad: "I noticed you might want to consider adding a null check here, as this could potentially
cause issues."

## 6. Return, do not post

Return JSON and nothing else:

```json
{ "verdict": "REQUEST_CHANGES",
  "summary": "one or two sentences, run through humanizer",
  "findings": [{ "path": "src/Cart.php", "line": 42, "severity": "bug", "body": "..." }] }
```

`line` anchors to a line the diff touches. If the bug sits on an untouched line, anchor to the
nearest changed one and name the real location in the first sentence of the body.

Nothing found: `verdict` `APPROVE`, empty `findings`, and a one line summary of what you read and
that it looks right.

The summary is what lands as the review body. Say what is broken in one line and stop. No list, no
repeat of the inline comments, no praise.

Whoever called this decides whether it gets posted. Do not post it yourself.

## 7. Posting by hand

Only when a human runs this in a terminal and says go:

```
gh api repos/{owner}/{repo}/pulls/<number>/reviews --method POST --input - <<< '<the JSON above,
with commit_id set to the head SHA and each finding as {path, line, side: "RIGHT", body}>'
```

GitHub rejects an approval on your own PR. If that is the failure, leave a plain comment with
`gh pr comment` instead.
