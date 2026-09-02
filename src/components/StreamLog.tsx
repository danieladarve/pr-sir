import { useEffect, useRef, useState } from 'react'
import { narrate, toLines, type StreamEvent } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const tone = {
  text: 'text-downy-50',
  tool: 'text-downy-300',
  meta: 'text-downy-500 italic',
}

export function StreamLog({ events, thinking }: { events: StreamEvent[]; thinking?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Per card and not saved: the raw calls are something you go and look at once
  // when a review does something odd, not a setting.
  const [raw, setRaw] = useState(false)
  const lines = events.flatMap(raw ? toLines : narrate)

  useEffect(() => {
    const el = box.current
    // Scroll the log itself. scrollIntoView walks every ancestor scroll
    // container, so a new line in a card further up yanks the whole page.
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines.length, thinking])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setRaw(!raw)}>
          {raw ? 'Plain' : 'Raw'}
        </Button>
      </div>
      <div
        ref={box}
        onScroll={onScroll}
        className="h-64 overflow-y-auto overscroll-contain rounded-md bg-downy-950 p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 && <div className="text-downy-500 italic">waiting for the agent…</div>}
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              'break-words whitespace-pre-wrap',
              tone[l.tone],
              l.depth > 0 && 'ml-2 border-l border-downy-700 pl-3',
            )}
          >
            {l.text}
          </div>
        ))}
        {thinking ? <div className="text-downy-500 italic">thinking… {thinking} tokens</div> : null}
      </div>
    </div>
  )
}
