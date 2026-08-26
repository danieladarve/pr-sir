import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Model } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// The default model is an empty id on the server, which Select cannot hold.
const DEFAULT = 'default'

export function Preferences({ onSaved }: { onSaved: () => void }) {
  const [models, setModels] = useState<Model[]>([])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(DEFAULT)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]))
    api
      .settings()
      .then((s) => {
        setPrompt(s.prompt)
        setModel(s.model || DEFAULT)
      })
      .catch((e) => toast.error(String(e.message)))
  }, [])

  const save = async (next?: string) => {
    setBusy(true)
    try {
      const saved = await api.saveSettings({ prompt: next ?? prompt, model: model === DEFAULT ? '' : model })
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

      <div className="flex flex-wrap items-center gap-2">
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
        <span className="text-sm text-muted-foreground">
          {models.find((m) => (m.id || DEFAULT) === model)?.note}
        </span>
        <Button className="ml-auto" onClick={() => save()} disabled={busy}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => save('')} disabled={busy}>
          Reset the prompt
        </Button>
      </div>
    </div>
  )
}
