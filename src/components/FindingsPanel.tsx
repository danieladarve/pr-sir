import { useState } from 'react'
import { toast } from 'sonner'
import { api, parseComments, parseFindings, type Review } from '@/lib/api'
import { Bomb, Bug } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

export function FindingsPanel({ review, onSettled }: { review: Review; onSettled: (r: Review) => void }) {
  const findings = parseFindings(review)
  // Comments the user wrote before the review ran always go up. They are not
  // the agent's suggestions to accept or reject.
  const mine = parseComments(review)
  const [keep, setKeep] = useState(() => findings.map(() => true))
  const [busy, setBusy] = useState(false)
  const chosen = findings.filter((_, i) => keep[i])
  // Dropping every finding turns the review into an approval. Say so before the
  // click, not after it.
  const approving = chosen.length + mine.length === 0

  const post = async () => {
    setBusy(true)
    try {
      onSettled(await api.post(review.id, chosen))
      toast.success(chosen.length ? `Requested changes on #${review.pr}` : `Approved #${review.pr}`)
    } catch (err) {
      toast.error(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    // A review costs real money and minutes to produce, and this is one click
    // away from the Post button.
    if (!confirm(`Discard the review of #${review.pr}? It stays in the archive but cannot be posted.`)) return
    onSettled(await api.discard(review.id))
    toast(`Discarded the review of #${review.pr}`)
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">{review.summary}</p>

      {findings.length === 0 && <p className="text-sm text-muted-foreground">The agent found nothing.</p>}



      {findings.map((f, i) => (
        <div key={i} className="flex gap-3 rounded-md border p-3">
          <Checkbox
            checked={keep[i]}
            onCheckedChange={(v) => setKeep(keep.map((k, j) => (j === i ? v === true : k)))}
            className="mt-1"
          />
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <code className="text-xs">
                {f.path}:{f.line}
              </code>
              <Badge variant={f.severity === 'blocker' ? 'destructive' : 'secondary'} className="gap-1.5">
                {f.severity === 'blocker' ? <Bomb className="size-3" /> : <Bug className="size-3" />}
                {f.severity}
              </Badge>
            </div>
            <p className="text-sm whitespace-pre-wrap">{f.body}</p>
          </div>
        </div>
      ))}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button onClick={post} disabled={busy}>
            {approving ? `Approve #${review.pr}` : `Request changes on #${review.pr}`}
          </Button>
          <Button variant="ghost" onClick={discard} disabled={busy}>
            Discard
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {approving
            ? 'Posts an approval with no comments.'
            : `Posts ${chosen.length + mine.length} inline comment${chosen.length + mine.length > 1 ? 's' : ''} and asks for changes.` +
              (mine.length ? ` ${mine.length} of them yours.` : '')}
          {approving && findings.length > 0 && ' You unchecked everything.'}
        </p>
      </div>
    </div>
  )
}
