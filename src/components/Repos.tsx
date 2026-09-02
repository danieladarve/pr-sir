import { useState } from 'react'
import { toast } from 'sonner'
import { api, type Option, type Repo } from '@/lib/api'
import { Satellite } from '@/components/icons'
import { OptionPicker } from '@/components/OptionPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function Repos({
  repos,
  prompts,
  onChange,
}: {
  repos: Repo[]
  prompts: Option[]
  onChange: () => void
}) {
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)

  const setPrompt = async (repo: string, name: string) => {
    try {
      await api.setRepoPrompt(repo, name)
      onChange()
    } catch (err) {
      toast.error(String((err as Error).message))
    }
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dir.trim()) return
    setBusy(true)
    try {
      const added = await api.addRepo(dir)
      setDir('')
      onChange()
      toast.success(`Added ${added.name}`)
    } catch (err) {
      toast.error(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    await api.removeRepo(name)
    onChange()
    toast(`Removed ${name}`)
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="flex gap-2">
        <Input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          placeholder="~/Development/my-repo"
          className="flex-1 font-mono text-sm"
        />
        <Button type="submit" disabled={busy || !dir.trim()}>
          Add
        </Button>
      </form>
      <div className="divide-y rounded-md border">
        {repos.length === 0 && (
          <div className="flex flex-col items-center gap-3 p-8 text-muted-foreground">
            <Satellite className="size-10 opacity-40" />
            <p className="text-sm">No repos yet. Paste a path above.</p>
          </div>
        )}
        {repos.map((r) => (
          <div key={r.name} className="flex items-center gap-3 p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{r.name}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {r.nwo ? `${r.nwo} · ` : ''}
                {r.path}
              </div>
            </div>
            <div className="ml-auto shrink-0">
              <OptionPicker
                label="Prompt"
                options={prompts}
                value={r.prompt || 'Default'}
                onChange={(name) => setPrompt(r.name, name)}
                disabled={busy || prompts.length === 0}
              />
            </div>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => remove(r.name)}>
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
