/** What a review has been billed for, and what a pile of finished reviews adds
 *  up to. Kept out of server.mjs so both can be tested without a server. */

/** Adds one event's usage to a running total. One message arrives as several
 *  events carrying the same id and repeating its usage, so each id counts once.
 *  State is `{ tokens, counted }`, mutated in place. */
export function addTokens(state, event) {
  const usage = event.message?.usage
  const id = event.message?.id
  if (!usage || (id && state.counted.has(id))) return state.tokens
  if (id) state.counted.add(id)
  state.tokens +=
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  return state.tokens
}

export const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const blank = (name) => ({
  name,
  reviews: 0,
  posted: 0,
  discarded: 0,
  findings: 0,
  cost_usd: 0,
  tokens: 0,
  runs: [],
  waits: [],
})

/** Rolls finished review rows into totals, a daily series, and one row per repo
 *  and per author. Rows missing a timestamp still count as reviews, they just
 *  stay out of the medians. */
export function summarise(rows) {
  const groups = { repos: new Map(), authors: new Map() }
  const series = new Map()

  for (const row of rows) {
    const posted = row.status === 'posted'
    // Only a posted review's findings went anywhere. postReview rewrites the
    // column with what was kept, so this is the count that landed on GitHub.
    let findings = 0
    if (posted) {
      try {
        findings = JSON.parse(row.findings || '[]').length
      } catch {
        findings = 0
      }
    }
    const run = row.finished_at && row.started_at ? row.finished_at - row.started_at : null
    const wait = posted && row.posted_at && row.finished_at ? row.posted_at - row.finished_at : null

    for (const [kind, key] of [
      ['repos', row.repo ?? 'unknown'],
      ['authors', row.author ?? 'unknown'],
    ]) {
      const g = groups[kind].get(key) ?? blank(key)
      g.reviews++
      if (posted) g.posted++
      else g.discarded++
      g.findings += findings
      g.cost_usd += row.cost_usd ?? 0
      g.tokens += row.tokens ?? 0
      if (run !== null) g.runs.push(run)
      if (wait !== null) g.waits.push(wait)
      groups[kind].set(key, g)
    }

    const date = new Date(row.created_at).toISOString().slice(0, 10)
    const day = series.get(date) ?? { date, repos: {}, authors: {} }
    const repo = row.repo ?? 'unknown'
    const author = row.author ?? 'unknown'
    day.repos[repo] = (day.repos[repo] ?? 0) + 1
    day.authors[author] = (day.authors[author] ?? 0) + 1
    series.set(date, day)
  }

  const finalise = (map) =>
    [...map.values()]
      .map(({ runs, waits, ...g }) => ({
        ...g,
        cost_usd: Number(g.cost_usd.toFixed(4)),
        median_run_ms: median(runs),
        median_to_post_ms: median(waits),
      }))
      .sort((a, b) => b.reviews - a.reviews)

  const repos = finalise(groups.repos)

  return {
    totals: {
      reviews: rows.length,
      posted: rows.filter((r) => r.status === 'posted').length,
      discarded: rows.filter((r) => r.status === 'discarded').length,
      findings: repos.reduce((n, g) => n + g.findings, 0),
      cost_usd: Number(rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0).toFixed(4)),
      tokens: rows.reduce((n, r) => n + (r.tokens ?? 0), 0),
      median_run_ms: median(rows.filter((r) => r.finished_at && r.started_at).map((r) => r.finished_at - r.started_at)),
      median_to_post_ms: median(
        rows
          .filter((r) => r.status === 'posted' && r.posted_at && r.finished_at)
          .map((r) => r.posted_at - r.finished_at),
      ),
    },
    series: [...series.values()].sort((a, b) => a.date.localeCompare(b.date)),
    repos,
    authors: finalise(groups.authors),
  }
}
