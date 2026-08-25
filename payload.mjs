/** Builds the GitHub review payload. Pure, so the money path can be tested. */
export function reviewPayload(row, findings) {
  const [, owner, repo] = row.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//) ?? []
  if (!owner) throw new Error(`cannot read owner/repo from ${row.url}`)

  const comments = findings.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: f.body }))
  const event = comments.length ? 'REQUEST_CHANGES' : 'APPROVE'
  // The agent's summary is only the right body when the agent agrees with the
  // verdict. Dropping every finding turns this into an approval, and a review
  // posted without running the agent has no summary at all.
  const agrees = row.verdict === event
  const body = agrees && row.summary ? row.summary : event === 'APPROVE' ? 'Approved.' : 'Requesting changes.'

  return {
    endpoint: `repos/${owner}/${repo}/pulls/${row.pr}/reviews`,
    body,
    payload: JSON.stringify({ commit_id: row.head_sha, body, event, comments }),
  }
}
