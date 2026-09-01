# Installing PR Sir

PR Sir runs entirely on your own machine. Reviews run as `claude` processes on your laptop, under
your own GitHub account, and the review history stays local.

## Required

**Node 22 or newer.** The database uses `node:sqlite`, which is built in from 22.5. You do not have
to compile a native module or install a database.

```
node --version        # must be 22.5+
```

If you use nvm, `nvm use` picks the right version up from `.nvmrc`.

**Claude Code**, signed in.

```
claude --version
claude auth status
```

Reviews cost real tokens, billed to whoever is signed in. Budget roughly $5 to $10 per review on a
medium PR, more on a large one. Read the Cost section before you point this at a busy repo.

**GitHub CLI**, signed in as the account whose name should appear on the reviews.

```
gh auth status
```

Reading a PR is enough to run a review. Posting one needs push access to the repo.

**Local clones** of the repos you want to review. The app never clones anything for you. Nothing is
checked out during a review, so the clone can sit on any branch, but read Known limits.

## Optional, and worth having

These make reviews better. Without them the app still runs and tells you what it skipped.

**codebase-memory-mcp**, for tracing callers the diff does not touch. It has to be on your `PATH`
under that name. If it is missing, the server prints `not installed, skipping: codebase-memory-mcp`
at boot and reviews fall back to `Read` and `grep`.

**The caveman plugin**, for the review pass:

```
claude plugin marketplace add JuliusBrussee/caveman
claude plugin install caveman
```

**A `humanizer` skill** in `~/.claude/skills/humanizer`, for the writing pass. Without it, comments
follow the style rules in section 5 of the review skill, which is most of the value anyway. Drop a
copy into this project's `.claude/skills` instead if you would rather it travelled with the repo.

## Project skills

`.claude/skills/pr-sir/SKILL.md` is the review itself, read fresh on every spawn.

Reviews run with the target repo as their working directory, so a skill living here would not be on
their path. The spawn passes `--add-dir` to fix that. Anything you drop into `.claude/skills` is
picked up by reviews without further setup.

## Install

```
git clone <this repo>
cd pr-sir
nvm use
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server runs on 5173 and the API on 8787.

There are no config files to edit. Go to the Repos tab and paste the path to a local clone,
`~/Development/my-repo` or the full path. The path is checked before it is saved: it has to be a
directory, a git repository, and have a GitHub remote your `gh` can reach. The name comes from the
folder.

## First run

Pick a repo, type a PR number, press enter. The PR is parked as a card showing who opened it and
when. Nothing runs yet.

Open the changes to read the diff. Any line that exists in the new file takes an inline comment of
your own. Deleted lines cannot take one, because GitHub anchors comments to the new side.

Hit Start AI review when you want the agent to go. Watch the terminal panel while it works. When it
finishes you get its findings next to your own comments. Uncheck any of the agent's you disagree
with, then post. Nothing reaches GitHub until you click.

Start with a small PR of your own. It is the cheapest way to see what the reviews read like before
one lands on a colleague.

## Cost

Reviews spawn with `--strict-mcp-config` pointing at `pr-sir.mcp.json`, and that flag is doing a lot
of work. With a normal Claude Code config, every MCP server you have connected puts its whole tool
list into the system prompt. Measured here: 470,000 cache-creation tokens and $1.88 per review
before the agent read a line of code. Pinned to one server it is about 27,000 tokens and $0.04.

If a review genuinely needs another MCP server, add it to `pr-sir.mcp.json` rather than to your
global config.

Two real reviews measured $5.31 over 31 minutes and $9.31 over 21 minutes. Both of those ran two
passes and both spawned subagents. The skill now runs a single pass, so expect roughly half.

## What it can do to your machine

Reviews run with `--permission-mode bypassPermissions`, so they never stall waiting for approval.
`Edit`, `Write` and every GitHub write command are in `--disallowedTools`, so a review cannot change
your working tree and cannot post. The server posts, in one `gh api` call, after you click.

What a review can still do is run any read command it likes, and read is broad. One review here
started containers to check whether a new base image carried the binaries the code shells out to.
That was useful, and it also left a container running when the command never returned. Worth knowing
before you point this at a repo you do not trust.

A review that goes quiet for 10 minutes is killed. Change that with `PR_SIR_IDLE_MIN`. The timer is
idle, not total, so a slow review is left alone.

## Known limits

A stale clone gives a wrong review. Reviews read the diff through `gh`, but they also read files
straight out of your clone. If that clone is behind, those reads return old code. Keep the clones
you review against reasonably fresh, or expect the agent to reason about code that is no longer
there.

A moved PR cannot be posted. If someone pushes to the branch while a review runs, posting is refused
and names the two commits, because the findings describe code that has changed. Run the review
again.

Reviews live on one machine. The database is `data/pr-sir.db`, which is gitignored. Sharing this
repo shares the app, not your review history.

## Editing the review itself

`.claude/skills/pr-sir/SKILL.md` is the review. Section 4 decides what counts as a finding and
section 5 decides how comments are written. The server reads the file fresh on every spawn, so edits
take effect on the next review without a restart.

## Troubleshooting

`Cannot find module 'node:sqlite'` means you are on Node 20 or older. Run `nvm use`.

`EADDRINUSE :::8787` means a server is already running. Kill it with `lsof -ti :8787 | xargs kill`.

If every review fails immediately, check `gh auth status` and `claude auth status`. The review runs
as a separate process and does not inherit a browser session.

If a review costs far more than $10, check that `pr-sir.mcp.json` still lists only the servers you
need, and that the spawn is still passing `--strict-mcp-config`.
