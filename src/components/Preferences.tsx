import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Option } from '@/lib/api'
import { DEFAULT, OptionPicker } from '@/components/OptionPicker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

export function Preferences({ onSaved }: { onSaved: () => void }) {
  const [models, setModels] = useState<Option[]>([])
  const [efforts, setEfforts] = useState<Option[]>([])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(DEFAULT)
  const [effort, setEffort] = useState('medium')
  const [openPrs, setOpenPrs] = useState(false)
  const [busy, setBusy] = useState(false)
  // Saving before the fetch lands would write the empty box over the prompt.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]))
    api.efforts().then(setEfforts).catch(() => setEfforts([]))
    api
      .settings()
      .then((s) => {
        setPrompt(s.prompt)
        setModel(s.model || DEFAULT)
        setEffort(s.effort)
        setOpenPrs(s.open_prs)
        setLoaded(true)
      })
      .catch((e) => toast.error(String(e.message)))
  }, [])

  const save = async (next?: string) => {
    setBusy(true)
    try {
      const saved = await api.saveSettings({
        prompt: next ?? prompt,
        model: model === DEFAULT ? '' : model,
        effort,
        open_prs: openPrs,
      })
      setPrompt(saved.prompt)
      onSaved()
      toast.success('Saved')
    } catch (err) {
      toast.error(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="prompt" className="text-sm font-medium">
          System prompt
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          className="h-96 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="text-sm text-muted-foreground">
          Every review runs on this. It starts as a copy of the pr-sir skill file, and resetting
          brings that copy back.
        </p>
      </div>

      <label className="flex items-start gap-3">
        <Checkbox checked={openPrs} onCheckedChange={(v) => setOpenPrs(v === true)} disabled={busy || !loaded} />
        <span className="space-y-1">
          <span className="block text-sm font-medium">Show the repo's open PRs</span>
          <span className="block text-sm text-muted-foreground">
            Adds a tab listing everything open on the selected repo, so you can queue a review
            without typing the number.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <OptionPicker label="Model" options={models} value={model} onChange={setModel} disabled={busy} />
        <OptionPicker label="Effort" options={efforts} value={effort} onChange={setEffort} disabled={busy} />
        <span className="text-sm text-muted-foreground">
          {models.find((m) => (m.id || DEFAULT) === model)?.note}
        </span>
        <Button className="ml-auto" onClick={() => save()} disabled={busy || !loaded}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => save('')} disabled={busy || !loaded}>
          Reset the prompt
        </Button>
      </div>
    </div>
  )
}
