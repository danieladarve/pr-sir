import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type OpenPr } from '@/lib/api'
import { DiffView } from '@/components/DiffView'
import { Satellite } from '@/components/icons'
import { Button } from '@/components/ui/button'

export function OpenPrs({ repo, filter, onStaged }: { repo: string; filter: string; onStaged: () => void }) {
  const [prs, setPrs] = useState<OpenPr[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(0)
  // The diff of whichever row is open, keyed by PR number.
  const [diffs, setDiffs] = useState<Record<number, string>>({})
  const [open, setOpen] = useState(0)

  useEffect(() => {
    if (!repo) return
    api
      .openPrs(repo)
      .then((list) => {
        setPrs(list)
        setError('')
      })
      .catch((e) => setError(String((e as Error).message)))
  }, [repo])

  const queue = async (pr: OpenPr) => {
    setBusy(pr.number)
    try {
      const staged = await api.stage(repo, String(pr.number))
      setPrs((list) => list.map((p) => (p.number === pr.number ? { ...p, queued: true } : p)))
      onStaged()
      toast(staged.existing ? `#${pr.number} is already here, ${staged.status}` : `Queued #${pr.number}`)
    } catch (err) {
      toast.error(String((err as Error).message))
    } finally {
      setBusy(0)
    }
  }

  const toggle = async (pr: OpenPr) => {
    if (open === pr.number) return setOpen(0)
    setOpen(pr.number)
    if (diffs[pr.number] !== undefined) return
    try {
      const diff = await api.prDiff(repo, pr.number)
      setDiffs((d) => ({ ...d, [pr.number]: diff }))
    } catch (err) {
      setOpen(0)
      toast.error(String((err as Error).message))
    }
  }

  if (!repo) return <p className="text-sm text-muted-foreground">Pick a repo above.</p>
  if (error) return <p className="text-sm text-destructive">{error}</p>

  const q = filter.trim().toLowerCase()
  const shown = q
    ? prs.filter((p) => `#${p.number} ${p.title} ${p.author}`.toLowerCase().includes(q))
    : prs

  return (
    <div className="divide-y rounded-md border">
      {shown.length === 0 && (
        <div className="flex flex-col items-center gap-3 p-8 text-muted-foreground">
          <Satellite className="size-10 opacity-40" />
          <p className="text-sm">{q ? `Nothing matching "${filter}".` : `Nothing open on ${repo}.`}</p>
        </div>
      )}
      {shown.map((pr) => (
        <div key={pr.number} className="space-y-3 p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <a href={pr.url} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline">
                #{pr.number} {pr.title}
              </a>
              <div className="text-xs text-muted-foreground">
                {pr.author}
                {pr.draft ? ' · draft' : ''}
              </div>
            </div>
            <div className="ml-auto flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => toggle(pr)}>
                {open === pr.number ? 'Hide changes' : 'View changes'}
              </Button>
              <Button
                variant={pr.queued ? 'ghost' : 'default'}
                size="sm"
                disabled={pr.queued || busy === pr.number}
                onClick={() => queue(pr)}
              >
                {pr.queued ? 'Queued' : 'Queue'}
              </Button>
            </div>
          </div>
          {open === pr.number && diffs[pr.number] !== undefined && (
            <>
              <p className="text-sm text-muted-foreground">
                Read only. Queue the PR to comment on a line.
              </p>
              <DiffView diff={diffs[pr.number]} />
            </>
          )}
        </div>
      ))}
    </div>
  )
}
