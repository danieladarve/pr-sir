import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ChartAreaIcon, MoonIcon, SettingsIcon, SunIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { api, type Repo, type Review, type Session, type StreamEvent } from '@/lib/api'
import { Archive } from '@/components/Archive'
import { Alien, AlienChart, FlyingSaucer, SettingsScreen } from '@/components/icons'
import { Analytics } from '@/components/Analytics'
import { OpenPrs } from '@/components/OpenPrs'
import { Preferences } from '@/components/Preferences'
import { Repos } from '@/components/Repos'
import { Toaster } from '@/components/ui/sonner'
import { SessionCard } from '@/components/SessionCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export default function App() {
  const [repos, setRepos] = useState<Repo[]>([])
  const [repo, setRepo] = useState('')
  const [pr, setPr] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [archive, setArchive] = useState<Review[]>([])
  const [busy, setBusy] = useState(false)
  // The hash is the whole router: a real URL, a working back button, no library.
  const [hash, setHash] = useState(() => window.location.hash)
  // Bumped on save so the staged cards pick up the new default model.
  const [settingsAt, setSettingsAt] = useState(0)
  const [openPrsTab, setOpenPrsTab] = useState(false)
  const [filter, setFilter] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme !== 'light'

  const refreshArchive = () => api.archive().then(setArchive)
  const refreshRepos = () =>
    api.repos().then((r) => {
      setRepos(r)
      // Keep the picker on something that still exists.
      setRepo((cur) => (r.some((x) => x.name === cur) ? cur : (r[0]?.name ?? '')))
    })

  useEffect(() => {
    api.settings().then((s) => setOpenPrsTab(s.open_prs)).catch(() => {})
  }, [settingsAt])

  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    refreshRepos()
    api.sessions().then(setSessions)
    refreshArchive()

    const es = new EventSource('/api/stream')
    // EventSource reconnects on its own, but the events sent while it was down
    // are lost. Without this a review that finished in the gap sits on
    // "running" with a dead log until the page is reloaded by hand.
    es.onopen = () => {
      api.sessions().then(setSessions)
      refreshArchive()
    }
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data) as {
        type: string
        id: string
        tokens?: number
        event?: StreamEvent
        session?: Session
        review?: Review
      }

      if (msg.type === 'session' && msg.session) {
        const added = msg.session
        setSessions((s) => (s.some((x) => x.id === added.id) ? s : [added, ...s]))
      }
      if (msg.type === 'event' && msg.event) {
        const ev = msg.event
        const tokens = msg.tokens ?? 0
        setSessions((s) =>
          s.map((x) => (x.id === msg.id ? { ...x, events: [...x.events, ev], thinking: 0, tokens } : x)),
        )
      }
      if (msg.type === 'thinking') {
        const tokens = msg.tokens ?? 0
        setSessions((s) => s.map((x) => (x.id === msg.id ? { ...x, thinking: tokens } : x)))
      }
      if (msg.type === 'removed') {
        setSessions((s) => s.filter((x) => x.id !== msg.id))
      }
      if (msg.type === 'review' && msg.review) {
        const next = msg.review
        setSessions((s) => s.map((x) => (x.id === next.id ? { ...x, ...next } : x)))
      }
    }
    return () => es.close()
  }, [])

  const queue = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pr.trim() || !repo) return
    setBusy(true)
    try {
      const staged = await api.stage(repo, pr)
      if (staged.existing) toast(`#${staged.pr} is already here, ${staged.status}`)
      setPr('')
      input.current?.focus()
    } catch (err) {
      toast.error(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  // A review that changes state but is still in play stays where it is.
  const onUpdate = (r: Review) =>
    setSessions((s) => s.map((x) => (x.id === r.id ? { ...x, ...r } : x)))

  // A settled review leaves the active list and joins the archive.
  const onSettled = (r: Review) => {
    setSessions((s) => s.filter((x) => x.id !== r.id))
    refreshArchive()
  }

  const active = sessions.filter((s) => s.status !== 'posted' && s.status !== 'discarded')

  // One box over all three lists: the number, the title, the author, the repo.
  const q = filter.trim().toLowerCase()
  const matches = (r: Review) => `#${r.pr} ${r.title} ${r.author} ${r.repo}`.toLowerCase().includes(q)
  const shownActive = q ? active.filter(matches) : active
  const shownArchive = q ? archive.filter(matches) : archive

  if (hash === '#analytics') {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2 leading-4 text-xl font-semibold">
              <AlienChart className="size-15 text-primary" />
              Analytics
            </h1>
            <p className="text-sm text-muted-foreground">What the finished reviews add up to.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => (window.location.hash = '')}>
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        </header>
        <Analytics />
        <Toaster />
      </div>
    )
  }

  if (hash === '#preferences') {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2 leading-4 text-xl font-semibold">
              <SettingsScreen className="size-15 text-primary" />
              Preferences
            </h1>
            <p className="text-sm text-muted-foreground">What every review runs on.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => (window.location.hash = '')}>
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        </header>
        <Preferences onSaved={() => setSettingsAt(Date.now())} />
        <Toaster />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center leading-4 gap-2 text-xl font-semibold">
            <Alien className="size-15 text-primary" />
            PR Sir
          </h1>
          <p className="text-sm text-muted-foreground">
            Queue reviews, watch them run, decide what gets posted.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Analytics"
            onClick={() => (window.location.hash = 'analytics')}
          >
            <ChartAreaIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Preferences"
            onClick={() => (window.location.hash = 'preferences')}
          >
            <SettingsIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setTheme(dark ? 'light' : 'dark')}
          >
            {dark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
          </Button>
        </div>
      </header>



      <form onSubmit={queue} className="flex gap-2">
        <Select value={repo} onValueChange={setRepo}>
          <SelectTrigger className="w-64 shrink-0">
            <SelectValue placeholder="Repo" />
          </SelectTrigger>
          <SelectContent>
            {repos.map((r) => (
              <SelectItem key={r.name} value={r.name}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          ref={input}
          value={pr}
          onChange={(e) => setPr(e.target.value)}
          placeholder="#123"
          className="flex-1"
          autoFocus
        />
        <Button type="submit" disabled={busy || !pr.trim() || !repo}>
          Review
        </Button>
      </form>

      <Tabs defaultValue="active">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="active">Active {shownActive.length > 0 && `(${shownActive.length})`}</TabsTrigger>
            {openPrsTab && <TabsTrigger value="open">Open PRs</TabsTrigger>}
            <TabsTrigger value="archive">Archive</TabsTrigger>
            <TabsTrigger value="repos">Repos {repos.length > 0 && `(${repos.length})`}</TabsTrigger>
          </TabsList>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by number, title or author"
            className="ml-auto w-full sm:w-72"
          />
        </div>

        <TabsContent value="active" className="space-y-4 pt-4">
          {shownActive.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <FlyingSaucer className="size-12 opacity-40" />
              <p className="text-sm">
                {q ? `Nothing matching "${filter}".` : 'Nothing running. Add a PR number above.'}
              </p>
            </div>
          )}
          {shownActive.map((s) => (
            <SessionCard key={`${s.id}:${settingsAt}`} session={s} onUpdate={onUpdate} onSettled={onSettled} />
          ))}
        </TabsContent>

        {openPrsTab && (
          <TabsContent value="open" className="pt-4">
            <OpenPrs repo={repo} filter={filter} onStaged={() => api.sessions().then(setSessions)} />
          </TabsContent>
        )}

        <TabsContent value="archive" className="pt-4">
          <Archive reviews={shownArchive} filter={filter} />
        </TabsContent>

        <TabsContent value="repos" className="pt-4">
          <Repos repos={repos} onChange={refreshRepos} />
        </TabsContent>
      </Tabs>

      <Toaster />
    </div>
  )
}
