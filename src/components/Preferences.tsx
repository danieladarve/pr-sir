import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Option, type Prompt, type Repo } from '@/lib/api'
import { DEFAULT, OptionPicker } from '@/components/OptionPicker'
import { Repos } from '@/components/Repos'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'

const asOptions = (prompts: Prompt[]): Option[] => prompts.map((p) => ({ id: p.name, name: p.name, note: '' }))

export function Preferences({
  repos,
  onChange,
  onSaved,
}: {
  repos: Repo[]
  onChange: () => void
  onSaved: () => void
}) {
  const [models, setModels] = useState<Option[]>([])
  const [efforts, setEfforts] = useState<Option[]>([])
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [picked, setPicked] = useState('Default')
  const [body, setBody] = useState('')
  const [model, setModel] = useState(DEFAULT)
  const [effort, setEffort] = useState('medium')
  const [openPrs, setOpenPrs] = useState(false)
  const [busy, setBusy] = useState(false)
  // Saving before the fetch lands would write the empty box over the prompt.
  const [loaded, setLoaded] = useState(false)

  // The built-in is offered to repos but never opened in the editor.
  const editable = prompts.filter((p) => !p.builtin)
  const saved = prompts.find((p) => p.name === picked)?.body ?? ''
  const dirty = loaded && body !== saved

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]))
    api.efforts().then(setEfforts).catch(() => setEfforts([]))
    Promise.all([api.settings(), api.prompts()])
      .then(([s, ps]) => {
        setModel(s.model || DEFAULT)
        setEffort(s.effort)
        setOpenPrs(s.open_prs)
        setPrompts(ps)
        setBody(ps.find((p) => p.name === 'Default')?.body ?? '')
        setLoaded(true)
      })
      .catch((e) => toast.error(String(e.message)))
  }, [])

  const fail = (err: unknown) => toast.error(String((err as Error).message))

  // Swapping away from unsaved text would lose it without a word.
  const switchTo = (name: string) => {
    if (dirty && !confirm(`Drop the unsaved changes to ${picked}?`)) return
    setPicked(name)
    setBody(prompts.find((p) => p.name === name)?.body ?? '')
  }

  const load = async (name: string) => {
    const ps = await api.prompts()
    setPrompts(ps)
    setPicked(name)
    setBody(ps.find((p) => p.name === name)?.body ?? '')
    onSaved()
  }

  const savePrompt = async (name = picked, rename?: string) => {
    setBusy(true)
    try {
      await api.savePrompt(name, body, rename)
      await load(name)
      toast.success(`Saved ${name}`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const create = () => {
    const name = window.prompt('Name for the new prompt')?.trim()
    if (!name) return
    // Without this, New on a name already in the list quietly overwrites it.
    if (prompts.some((p) => p.name === name)) return toast.error(`${name} is taken`)
    savePrompt(name)
  }

  const rename = () => {
    const name = window.prompt('New name', picked)?.trim()
    if (name && name !== picked) savePrompt(name, picked)
  }

  const remove = async () => {
    if (!confirm(`Delete ${picked}? Repos using it fall back to Default.`)) return
    setBusy(true)
    try {
      const left = await api.deletePrompt(picked)
      setPrompts(left)
      onChange()
      // Set straight, not through switchTo: the deleted body always looks unsaved.
      setPicked('Default')
      setBody(left.find((p) => p.name === 'Default')?.body ?? '')
      onSaved()
      toast(`Deleted ${picked}`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    try {
      setBody((await api.skillPrompt()).body)
    } catch (err) {
      fail(err)
    }
  }

  const saveSettings = async () => {
    setBusy(true)
    try {
      await api.saveSettings({ model: model === DEFAULT ? '' : model, effort, open_prs: openPrs })
      onSaved()
      toast.success('Saved')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-transparent">
        <CardHeader>
          <CardTitle>System prompts</CardTitle>
          <CardDescription>
            A review runs on the prompt its repo asks for, and Default covers the rest. New starts
            from whatever is in the box, so it is the way to copy one and tweak it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <OptionPicker
              label="Prompt"
              options={asOptions(editable)}
              value={picked}
              onChange={switchTo}
              disabled={busy || !loaded}
            />
            <Button variant="ghost" size="sm" onClick={create} disabled={busy || !loaded}>
              New
            </Button>
            <Button variant="ghost" size="sm" onClick={rename} disabled={busy || !loaded || picked === 'Default'}>
              Rename
            </Button>
            <Button variant="ghost" size="sm" onClick={remove} disabled={busy || !loaded || picked === 'Default'}>
              Delete
            </Button>
          </div>
          <textarea
            aria-label={`The ${picked} prompt`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            className="h-96 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </CardContent>
        <CardFooter className="gap-2">
          <Button variant="outline" onClick={reset} disabled={busy || !loaded}>
            Load the skill copy
          </Button>
          <Button className="ml-auto" onClick={() => savePrompt()} disabled={busy || !loaded || !dirty}>
            Save the prompt
          </Button>
        </CardFooter>
      </Card>

      <Card className="bg-transparent">
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
          <CardDescription>What a review runs on unless its repo says otherwise.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
          </div>
        </CardContent>
        <CardFooter>
          <Button className="ml-auto" onClick={saveSettings} disabled={busy || !loaded}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card className="bg-transparent">
        <CardHeader>
          <CardTitle>Repos</CardTitle>
          <CardDescription>
            Paste the path to a local clone. It needs a GitHub remote you can reach, and it is
            checked before it is saved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Repos repos={repos} prompts={asOptions(prompts)} onChange={onChange} />
        </CardContent>
      </Card>
    </div>
  )
}
