import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, parseComments, type Model, type Review, type Session } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// The default model is an empty id on the server, which Select cannot hold.
const DEFAULT = 'default'

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
  const [models, setModels] = useState<Model[]>([])
  const [model, setModel] = useState(DEFAULT)
  const comments = parseComments(session)

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]))
    // Starts on the default from Preferences, still changeable per review.
    api.settings().then((s) => setModel(s.model || DEFAULT)).catch(() => {})
  }, [])

  const start = async () => {
    setBusy(true)
    try {
      onUpdate(await api.start(session.id, model === DEFAULT ? '' : model))
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
      <Select value={model} onValueChange={setModel} disabled={busy}>
        <SelectTrigger className="w-44 shrink-0">
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m.id || DEFAULT} value={m.id || DEFAULT}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
