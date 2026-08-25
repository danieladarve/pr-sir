// Splits a stream of newline-delimited JSON into whole events.
// Claude's stream-json events run well over a single chunk, so the tail is kept
// until its newline arrives.
export function ndjson(onEvent) {
  let buf = ''
  return (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        // A line that is not JSON is claude writing to stdout for some other
        // reason. Dropping it is better than killing the stream.
      }
    }
  }
}
