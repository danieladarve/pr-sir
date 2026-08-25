import { useEffect, useRef } from 'react'
import { toLines, type StreamEvent } from '@/lib/api'
import { cn } from '@/lib/utils'

const tone = {
  text: 'text-downy-50',
  tool: 'text-downy-300',
  meta: 'text-downy-500 italic',
}

export function StreamLog({ events, thinking }: { events: StreamEvent[]; thinking?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const lines = events.flatMap(toLines)

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
  )
}
