export type DiffLine = {
  kind: 'add' | 'del' | 'ctx' | 'meta'
  text: string
  /** Line number in the new file. Only these can carry a comment on side RIGHT. */
  newLine?: number
  oldLine?: number
}

export type DiffFile = { path: string; lines: DiffLine[] }

const headers = [
  'index ',
  '--- ',
  '+++ ',
  'new file',
  'deleted file',
  'old mode',
  'new mode',
  'similarity index',
  'rename ',
  'copy ',
]

/** Parses `gh pr diff` output. Line numbers follow the new file, which is what
 *  GitHub anchors a RIGHT-side comment to. */
/** git quotes the path when it has a space or a non-ASCII character:
 *  `diff --git "a/my file.php" "b/my file.php"`. */
function pathOf(raw: string): string {
  const quoted = raw.match(/ "b\/(.+)"$/)
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1')
  return raw.match(/ b\/(.+)$/)?.[1] ?? raw.slice('diff --git '.length).trim()
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let newLine = 0
  let oldLine = 0
  // Header prefixes only mean anything before the first hunk. Inside one, a
  // line of content starting with "-- " or "++ " arrives as "--- " or "+++ "
  // and skipping it silently shifts every anchor below it by one.
  let inHunk = false

  const rows = text.split('\n')
  if (rows.at(-1) === '') rows.pop()

  for (const raw of rows) {
    if (raw.startsWith('diff --git')) {
      file = { path: pathOf(raw), lines: [] }
      files.push(file)
      inHunk = false
      continue
    }
    if (!file) continue
    if (!inHunk && headers.some((p) => raw.startsWith(p))) continue

    if (raw.startsWith('@@')) {
      inHunk = true
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldLine = Number(m[1])
        newLine = Number(m[2])
      }
      file.lines.push({ kind: 'meta', text: raw })
      continue
    }
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"

    if (raw.startsWith('+')) {
      file.lines.push({ kind: 'add', text: raw.slice(1), newLine: newLine++ })
    } else if (raw.startsWith('-')) {
      file.lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++ })
    } else if (raw.startsWith(' ') || raw === '') {
      file.lines.push({ kind: 'ctx', text: raw.slice(1), newLine: newLine++, oldLine: oldLine++ })
    } else {
      file.lines.push({ kind: 'meta', text: raw }) // "Binary files ... differ"
    }
  }
  return files
}
