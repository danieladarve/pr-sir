/**
 * What to store from a finished run. The schema flag is meant to hold the
 * output to shape, but a prompt with instructions of its own can still write
 * prose, and /code-review does. Keeping that as the summary beats throwing a
 * nine minute review away: it is the review, just without the anchors that
 * inline comments need.
 */
export const reviewResult = (result) => {
  let parsed
  try {
    parsed = JSON.parse(result)
  } catch {
    parsed = null
  }

  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.findings)) {
    return {
      status: 'done',
      // Nothing gets approved on the strength of output nobody could read.
      verdict: 'REQUEST_CHANGES',
      summary: String(result ?? '').trim().slice(0, 8000),
      findings: '[]',
    }
  }

  return {
    status: 'done',
    verdict: parsed.verdict,
    summary: parsed.summary,
    findings: JSON.stringify(parsed.findings),
  }
}
