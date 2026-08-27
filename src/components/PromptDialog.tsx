import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Option, type Prompt } from '@/lib/api'
import { OptionPicker } from '@/components/OptionPicker'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Pick which saved prompt one review runs on. Read only: editing a prompt
 * belongs in Preferences, where the change sticks. Mounted only while open, so
 * the selection starts from the current one every time without resetting it.
 */
export function PromptDialog({
  onClose,
  value,
  onPick,
  pr,
}: {
  onClose: () => void
  value: string
  onPick: (name: string) => void
  pr: number
}) {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [picked, setPicked] = useState(value)

  useEffect(() => {
    api
      .prompts()
      .then(setPrompts)
      .catch((e) => toast.error(String(e.message)))
  }, [])

  const options: Option[] = prompts.map((p) => ({ id: p.name, name: p.name, note: '' }))

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Prompt for PR {pr}</DialogTitle>
          <DialogDescription>
            This review only. The repo keeps whatever it was set to.
          </DialogDescription>
        </DialogHeader>
        <OptionPicker label="Prompt" options={options} value={picked} onChange={setPicked} />
        <textarea
          readOnly
          value={prompts.find((p) => p.name === picked)?.body ?? ''}
          spellCheck={false}
          className="h-72 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs text-muted-foreground outline-none"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onPick(picked)
              onClose()
            }}
            disabled={prompts.length === 0}
          >
            Use it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
