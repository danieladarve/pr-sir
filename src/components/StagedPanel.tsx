import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, parseComments, type Option, type Review, type Session } from '@/lib/api'
import { DEFAULT, OptionPicker } from '@/components/OptionPicker'
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
  const [models, setModels] = useState<Option[]>([])
  const [efforts, setEfforts] = useState<Option[]>([])
  const [model, setModel] = useState(DEFAULT)
  const [effort, setEffort] = useState('medium')
  const comments = parseComments(session)

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]))
    api.efforts().then(setEfforts).catch(() => setEfforts([]))
    // Starts on the defaults from Preferences, still changeable per review.
    api
      .settings()
      .then((s) => {
        setModel(s.model || DEFAULT)
        setEffort(s.effort)
      })
      .catch(() => {})
  }, [])

  const start = async () => {
    setBusy(true)
    try {
      onUpdate(await api.start(session.id, model === DEFAULT ? '' : model, effort))
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
      <OptionPicker label="Model" options={models} value={model} onChange={setModel} disabled={busy} />
      <OptionPicker label="Effort" options={efforts} value={effort} onChange={setEffort} disabled={busy} />
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
