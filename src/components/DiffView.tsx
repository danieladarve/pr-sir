import { useRef, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { parseDiff, type DiffLine } from '@/lib/diff'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const bg: Record<DiffLine['kind'], string> = {
  add: 'bg-downy-900/60 text-downy-100',
  del: 'bg-destructive/15 text-downy-200/70',
  ctx: 'text-downy-200/80',
  meta: 'text-downy-500',
}

export function DiffView({
  diff,
  onComment,
}: {
  diff: string
  /** Returns false when the comment did not save, so the box keeps the text.
   *  Left out for a PR with no review behind it, which reads but takes nothing. */
  onComment?: (path: string, line: number, body: string) => Promise<boolean>
}) {
  const files = parseDiff(diff)
  // Which line the comment box is open on, as "path:line".
  const [open, setOpen] = useState<string | null>(null)
  // Empty means every file is expanded, which is the default.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  // The file the search just landed on, lit up for a moment so the eye finds it.
  const [hit, setHit] = useState<string | null>(null)
  const hitTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const find = (q: string) => {
    setQuery(q)
    const needle = q.trim().toLowerCase()
    const file = needle ? files.find((f) => f.path.toLowerCase().includes(needle)) : undefined
    if (!file) return
    setCollapsed((c) => {
      if (!c.has(file.path)) return c
      const next = new Set(c)
      next.delete(file.path)
      return next
    })
    // Scroll the diff box itself. scrollIntoView walks every ancestor and moves
    // the page too.
    const el = box.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(file.path)}"]`)
    if (el) box.current!.scrollTo({ top: el.offsetTop, behavior: 'smooth' })
    setHit(file.path)
    clearTimeout(hitTimer.current)
    hitTimer.current = setTimeout(() => setHit(null), 1500)
  }

  const toggleFile = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const openOn = (path: string, line: number) => {
    // A click that ends a drag is someone selecting code to copy, not asking to
    // comment on it.
    if (!window.getSelection()?.isCollapsed) return
    const key = `${path}:${line}`
    setOpen(open === key ? null : key)
    setText('')
  }

  const submit = async (path: string, line: number) => {
    if (!text.trim()) return
    setBusy(true)
    try {
      if (!onComment || !(await onComment(path, line, text))) return // keep what they typed
      setOpen(null)
      setText('')
    } finally {
      setBusy(false)
    }
  }

  if (files.length === 0) return <p className="text-sm text-muted-foreground">No changes to show.</p>

  return (
    <div className="space-y-2">
    {/* Same ground as the page so the input's translucent dark fill matches the filter box. */}
    <div className="rounded-lg bg-background">
      <Input
        value={query}
        onChange={(e) => find(e.target.value)}
        placeholder="Find a file"
        aria-label="Find a file in the changes"
      />
    </div>
    <div ref={box} className="relative max-h-[32rem] overflow-auto rounded-md border border-downy-800 bg-downy-950 font-mono text-xs">
      {files.map((file) => {
        const shut = collapsed.has(file.path)
        const adds = file.lines.filter((l) => l.kind === 'add').length
        const dels = file.lines.filter((l) => l.kind === 'del').length
        return (
        <div key={file.path} data-path={file.path} className="border-b border-downy-800 last:border-0">
          <button
            type="button"
            onClick={() => toggleFile(file.path)}
            aria-expanded={!shut}
            className={cn(
              'sticky top-0 z-10 flex w-full items-center gap-2 bg-downy-900 px-3 py-2 text-left text-downy-100 transition-colors hover:bg-downy-800',
              hit === file.path && 'animate-pulse bg-downy-600 ring-2 ring-downy-300 ring-inset',
            )}
          >
            <ChevronDownIcon className={cn('size-3.5 shrink-0 transition-transform', shut && '-rotate-90')} />
            <span className="truncate">{file.path}</span>
            {/* counts stay visible when the file is shut, so it still says something */}
            <span className="ml-auto shrink-0 tabular-nums">
              <span className="text-downy-300">+{adds}</span> <span className="text-downy-500">-{dels}</span>
            </span>
          </button>
          {!shut &&
          file.lines.map((l, i) => {
            const key = `${file.path}:${l.newLine}`
            // Only lines that exist in the new file can take a comment. GitHub
            // anchors to the RIGHT side, so a deleted line has nowhere to go.
            const canComment = onComment !== undefined && l.newLine !== undefined && l.kind !== 'meta'
            return (
              <div key={i}>
                <div
                  className={cn(
                    'group flex gap-2 px-3 leading-relaxed',
                    bg[l.kind],
                    canComment && 'cursor-pointer hover:bg-downy-800',
                  )}
                  onClick={canComment ? () => openOn(file.path, l.newLine!) : undefined}
                >
                  <span className="w-10 shrink-0 text-right text-downy-600 select-none">{l.newLine ?? ''}</span>
                  <span className="w-3 shrink-0 select-none">
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}
                  </span>
                  <span className="break-all whitespace-pre-wrap">{l.text || ' '}</span>
                  {canComment && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation() // the row handles it, do not toggle twice
                        openOn(file.path, l.newLine!)
                      }}
                      // Hidden until the row is hovered. focus-visible keeps it
                      // reachable by keyboard, where there is no hover.
                      className="ml-auto shrink-0 rounded border border-downy-700 px-1.5 leading-none text-downy-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:border-downy-400 hover:bg-downy-800 hover:text-downy-100"
                      title={`Comment on ${file.path}:${l.newLine}`}
                      aria-label={`Comment on ${file.path} line ${l.newLine}`}
                    >
                      +
                    </button>
                  )}
                </div>
                {open === key && (
                  <div className="space-y-2 bg-downy-900 p-3">
                    <textarea
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={`Comment on ${file.path}:${l.newLine}`}
                      className="h-20 w-full rounded border border-downy-700 bg-downy-950 p-2 text-downy-100"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy || !text.trim()} onClick={() => submit(file.path, l.newLine!)}>
                        Add comment
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        )
      })}
    </div>
    </div>
  )
}
