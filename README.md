# PR Sir

Queue PR reviews, watch each agent work, decide what gets posted.

Each review is a real `claude -p` process running the `pr-sir` skill against a local clone. The
app streams what the agent and its subagents are doing, then holds the findings behind a Post
button. Nothing reaches GitHub until you click it.

## Setup

See [INSTALL.md](INSTALL.md) for prerequisites and first run. The short version:

```
nvm use && npm install && npm run dev
```

Then open http://localhost:5173 and add a repo in the Repos tab.

## How it works

Pick a repo, type a PR number, hit enter. The PR is pulled in and parked. Nothing runs yet.

The card shows who opened it and when. Open the changes and you get the diff, where any line that
exists in the new file takes an inline comment of your own. Write as many as you like, or none.

A card reads the whole PR unless you narrow it. Scope opens the PR's commits, where you can search
by hash, message or author and pin the review to one of them. The diff, your comments and the agent
all follow that choice, and it can only move while the card is still staged.

Then hit Start AI review. It runs as a `claude` process and streams what it and its subagents are
doing. Queue as many as you like, they run at the same time. Reviews read the PR through `gh`, so
nothing is checked out and two reviews of the same repo do not collide.

Searching the same PR again lands on the card that is already open rather than adding another one.
Remove takes a card away for good, stopping the review first if it is still running.

When it finishes you get its findings alongside your own comments. Uncheck any of the agent's you
disagree with, then Post. Your own comments always go up. Posting with nothing at all approves the
PR instead, and you can post your comments without ever running the agent.

Posted and discarded reviews land in the Archive tab, grouped by whoever opened the PR.

## The gate

Posting is the server's job, in one `gh api` call, after you click. The agent runs with `Edit`,
`Write` and the GitHub write commands disallowed, so the ordinary ways to publish or edit are shut.

That is a gate, not a sandbox. `Bash` stays open because a review needs it to read the code, so a
review that decides to check something for itself can still write to the checkout or reach the
network. Point this at repos you trust.

Reviews are pinned to one MCP server, which cuts the fixed cost per review by about 48 times. See
[INSTALL.md](INSTALL.md) for the numbers and for what a review can still do on your machine.

## Editing the review

`.claude/skills/pr-sir/SKILL.md` is the review itself. The server reads it fresh on every spawn,
so changes take effect on the next review with no restart.

## Icons

Hand-drawn icons from [koboyo.com/icons](https://koboyo.com/icons), free for commercial use with no
attribution required. They are inlined in `src/components/icons.tsx`, so the app makes no external
requests. Re-fetch or change the set with `node scripts/gen-icons.mjs`.
