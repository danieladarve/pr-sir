import { useEffect, useState } from 'react'
import { api, parseComments, parseFindings, type Review, type Session } from '@/lib/api'
import { FindingsPanel } from '@/components/FindingsPanel'
import { Changes } from '@/components/Changes'
import { StagedPanel } from '@/components/StagedPanel'
import { StreamLog } from '@/components/StreamLog'
import { MagnifyingGlass, Radar, Skull, Satellite } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

const badge = {
  staged: 'outline',
  running: 'secondary',
  done: 'default',
  posted: 'default',
  discarded: 'outline',
  failed: 'destructive',
} as const

const StatusIcon = ({ status }: { status: Session['status'] }) => {
  if (status === 'staged') return <Satellite className="size-3.5" />
  if (status === 'running') return <Radar className="size-3.5 animate-pulse" />
  if (status === 'failed') return <Skull className="size-3.5" />
  return <MagnifyingGlass className="size-3.5" />
}

const ago = (ms?: number | null) => {
  if (!ms) return 'unknown date'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days === 0) return 'opened today'
  if (days === 1) return 'opened yesterday'
  if (days < 30) return `opened ${days} days ago`
  return `opened on ${new Date(ms).toLocaleDateString()}`
}

const elapsed = (from: number) => {
  const s = Math.floor((Date.now() - from) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function SessionCard({
  session,
  onUpdate,
  onSettled,
}: {
  session: Session
  onUpdate: (r: Review) => void
  onSettled: (r: Review) => void
}) {
  const [, tick] = useState(0)

  const remove = () => {
    // Killing a run in flight, or dropping comments and findings, is worth a
    // question. Removing an untouched staged card is not.
    const loses =
      session.status === 'running'
        ? 'It is running now and will be stopped.'
        : parseComments(session).length || parseFindings(session).length
          ? 'Its comments and findings go with it.'
          : ''
    if (loses && !confirm(`Remove the review of #${session.pr}? ${loses}`)) return
    api.remove(session.id)
  }

  useEffect(() => {
    if (session.status !== 'running') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [session.status])

  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <a href={session.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              #{session.pr} {session.title}
            </a>
            <p className="text-sm text-muted-foreground">
              {session.repo} · {session.author} ·{' '}
              {session.status === 'staged' ? ago(session.pr_created_at) : elapsed(session.created_at)}
              {session.model ? ` · ${session.model}` : ''}
              {session.cost_usd ? ` · $${session.cost_usd.toFixed(2)}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={badge[session.status]} className="gap-1.5">
              <StatusIcon status={session.status} />
              {session.status}
            </Badge>
            <Button size="sm" variant="ghost" onClick={remove} aria-label={`Remove #${session.pr}`}>
              Remove
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {session.status === 'staged' ? (
          <StagedPanel session={session} onUpdate={onUpdate} onSettled={onSettled} />
        ) : session.status === 'done' ? (
          <FindingsPanel review={session} onSettled={onSettled} />
        ) : session.status === 'failed' ? (
          <p className="font-mono text-xs whitespace-pre-wrap text-destructive">{session.error}</p>
        ) : (
          <StreamLog events={session.events} thinking={session.thinking} />
        )}
        <Changes session={session} onUpdate={onUpdate} />
      </CardContent>
    </Card>
  )
}
