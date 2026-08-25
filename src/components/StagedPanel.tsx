import { useState } from 'react'
import { toast } from 'sonner'
import { api, parseComments, type Review, type Session } from '@/lib/api'
import { Button } from '@/components/ui/button'

export function StagedPanel({
  session,
  onUpdate,
  onSettled,
}: {
  session: Session
  onUpdate: (r: Review) => void
  onSettled: (r: Review) => void
}) {
  const [busy, setBusy] = useState(false)
  const comments = parseComments(session)

  const start = async () => {
    setBusy(true)
    try {
      onUpdate(await api.start(session.id))
    } catch (err) {
      toast.error(String((err as Error).message))
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={start} disabled={busy}>
        Start AI review
      </Button>
      {comments.length > 0 && (
        <Button
          variant="ghost"
          onClick={() =>
            api
              .post(session.id, [])
              .then(onSettled)
              .catch((e) => toast.error(String(e.message)))
          }
        >
          Post {comments.length} comment{comments.length > 1 ? 's' : ''} without a review
        </Button>
      )}
    </div>
  )
}
