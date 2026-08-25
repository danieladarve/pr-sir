import { useState } from 'react'
import { toast } from 'sonner'
import { api, parseComments, type Review, type Session } from '@/lib/api'
import { DiffView } from '@/components/DiffView'
import { Button } from '@/components/ui/button'

/** The diff and the user's own comments. Stays available while the agent runs,
 *  so a review in flight does not take the changes away. */
export function Changes({ session, onUpdate }: { session: Session; onUpdate: (r: Review) => void }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const comments = parseComments(session)

  const toggle = async () => {
    if (diff !== null) return setDiff(null) // an empty diff is still loaded
    setLoading(true)
    try {
      setDiff(await api.diff(session.id))
    } catch (err) {
      toast.error(String((err as Error).message))
    } finally {
      setLoading(false)
    }
  }

  const addComment = async (path: string, line: number, body: string) => {
    try {
      onUpdate(await api.comment(session.id, path, line, body))
      toast.success(`Comment on ${path}:${line}`)
      return true
    } catch (err) {
      toast.error(String((err as Error).message))
      return false
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={toggle} disabled={loading}>
          {loading ? 'Loading changes…' : diff !== null ? 'Hide changes' : 'View changes'}
        </Button>
        {comments.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {comments.length} comment{comments.length > 1 ? 's' : ''} of yours
          </span>
        )}
      </div>

      {comments.map((c, i) => (
        <div key={i} className="flex gap-3 rounded-md border border-primary/40 p-3">
          <div className="min-w-0 space-y-1">
            <code className="text-xs">
              {c.path}:{c.line}
            </code>
            <p className="text-sm whitespace-pre-wrap">{c.body}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            onClick={async () => onUpdate(await api.uncomment(session.id, i))}
          >
            Remove
          </Button>
        </div>
      ))}

      {diff !== null && (
        <>
          <p className="text-sm text-muted-foreground">
            Click any changed line to leave a comment. Deleted lines cannot take one, GitHub anchors
            comments to the new side of the diff.
          </p>
          <DiffView diff={diff} onComment={addComment} />
        </>
      )}
    </div>
  )
}
