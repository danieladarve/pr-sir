import { parseFindings, type Review } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

export function Archive({ reviews, filter }: { reviews: Review[]; filter: string }) {
  const byAuthor = new Map<string, Review[]>()
  for (const r of reviews) byAuthor.set(r.author, [...(byAuthor.get(r.author) ?? []), r])

  if (reviews.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {filter.trim() ? `Nothing matching "${filter}".` : 'No reviews posted yet.'}
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {[...byAuthor].map(([author, list]) => (
        <section key={author} className="space-y-2">
          <h2 className="text-sm font-medium">
            {author} <span className="text-muted-foreground">({list.length})</span>
          </h2>
          {list.map((r) => {
            const findings = parseFindings(r)
            return (
              <Collapsible key={r.id} className="rounded-md border">
                <CollapsibleTrigger className="flex w-full items-center gap-3 p-3 text-left">
                  <Badge variant={r.status === 'discarded' ? 'outline' : 'secondary'}>
                    {r.status === 'discarded' ? 'discarded' : (r.verdict ?? 'posted')}
                  </Badge>
                  <span className="min-w-0 truncate text-sm">
                    #{r.pr} {r.title}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {findings.length} {findings.length === 1 ? 'comment' : 'comments'}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 border-t p-3">
                  <p className="text-sm">{r.summary}</p>
                  {findings.map((f, i) => (
                    <div key={i} className="space-y-1 border-l pl-3">
                      <code className="text-xs">
                        {f.path}:{f.line}
                      </code>
                      <p className="text-sm whitespace-pre-wrap">{f.body}</p>
                    </div>
                  ))}
                  <a href={r.url} target="_blank" rel="noreferrer" className="text-xs underline">
                    Open on GitHub
                  </a>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </section>
      ))}
    </div>
  )
}
