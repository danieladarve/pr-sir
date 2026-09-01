import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type PrCommit } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const short = (sha: string) => sha.slice(0, 7)

/**
 * Narrow one staged review to a single commit of the PR. Mounted only while
 * open, so it starts from what the review is set to every time.
 */
export function CommitDialog({
  id,
  pr,
  value,
  onClose,
  onPick,
}: {
  id: string
  pr: number
  value: string
  onClose: () => void
  onPick: (sha: string) => void
}) {
  const [commits, setCommits] = useState<PrCommit[]>([])
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState(value)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .commits(id)
      .then(setCommits)
      .catch((e) => toast.error(String((e as Error).message)))
      .finally(() => setLoading(false))
  }, [id])

  const q = filter.trim().toLowerCase()
  const shown = q
    ? commits.filter((c) => `${c.sha} ${c.subject} ${c.author}`.toLowerCase().includes(q))
    : commits

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What PR {pr} gets reviewed on</DialogTitle>
          <DialogDescription>
            One commit, or the whole PR. Search by hash, message or author.
          </DialogDescription>
        </DialogHeader>

        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="a1b2c3d" autoFocus />

        <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
          <button
            type="button"
            onClick={() => setPicked('')}
            className={`w-full px-3 py-2 text-left text-sm ${picked ? '' : 'bg-accent'}`}
          >
            Whole PR
          </button>
          {loading && <p className="p-3 text-sm text-muted-foreground">Loading commits…</p>}
          {!loading && shown.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              {q ? `Nothing matching "${filter}".` : 'No commits on this PR.'}
            </p>
          )}
          {shown.map((c) => (
            <button
              key={c.sha}
              type="button"
              onClick={() => setPicked(c.sha)}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left ${picked === c.sha ? 'bg-accent' : ''}`}
            >
              <code className="shrink-0 text-xs">{short(c.sha)}</code>
              <span className="min-w-0 flex-1 truncate text-sm">{c.subject}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{c.author}</span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onPick(picked)
              onClose()
            }}
          >
            Use it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
