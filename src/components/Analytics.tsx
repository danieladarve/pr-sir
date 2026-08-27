import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'
import { toast } from 'sonner'
import {
  api,
  formatMs,
  formatTokens,
  formatUsd,
  type Analytics as Data,
  type Breakdown,
} from '@/lib/api'
import { OptionPicker } from '@/components/OptionPicker'
import { Card, CardContent } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const RANGES = [
  { id: '30', name: 'Last 30 days', note: '' },
  { id: '90', name: 'Last 90 days', note: '' },
  { id: '0', name: 'All time', note: '' },
]

// Five chart colors, so five bands. Everything past that stacks as one.
const BANDS = 5
const OTHER = 'other'

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** The daily counts as recharts wants them, one key per band. */
function toChart(series: Data['series'], key: 'repos' | 'authors', names: string[]) {
  const top = names.slice(0, BANDS)
  const rows = series.map((d) => {
    const row: Record<string, string | number> = { date: d.date }
    for (const name of top) row[name] = d[key][name] ?? 0
    const rest = Object.entries(d[key])
      .filter(([n]) => !top.includes(n))
      .reduce((n, [, count]) => n + count, 0)
    if (rest) row[OTHER] = rest
    return row
  })
  const bands = [...top, ...(rows.some((r) => r[OTHER]) ? [OTHER] : [])]
  const config: ChartConfig = Object.fromEntries(
    bands.map((name, i) => [name, { label: name, color: `var(--chart-${(i % BANDS) + 1})` }]),
  )
  return { rows, bands, config }
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  )
}

function Section({
  title,
  series,
  which,
  rows,
}: {
  title: string
  series: Data['series']
  which: 'repos' | 'authors'
  rows: Breakdown[]
}) {
  const { rows: chart, bands, config } = toChart(series, which, rows.map((r) => r.name))

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{title}</h2>

      <ChartContainer config={config} className="h-64 w-full">
        <AreaChart data={chart} margin={{ left: 4, right: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={day} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => day(String(v))} />} />
          {bands.map((name) => (
            <Area
              key={name}
              dataKey={name}
              type="natural"
              stackId="a"
              stroke={`var(--color-${name})`}
              fill={`var(--color-${name})`}
              fillOpacity={0.4}
            />
          ))}
          <ChartLegend content={<ChartLegendContent />} />
        </AreaChart>
      </ChartContainer>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="p-2 text-left font-medium">{which === 'repos' ? 'Repo' : 'Author'}</th>
              <th className="p-2 text-right font-medium">Reviews</th>
              <th className="p-2 text-right font-medium">Posted</th>
              <th className="p-2 text-right font-medium">Comments</th>
              <th className="p-2 text-right font-medium">Cost</th>
              <th className="p-2 text-right font-medium">Tokens</th>
              <th className="p-2 text-right font-medium">Run</th>
              <th className="p-2 text-right font-medium">Waited</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.name} className="border-b last:border-0">
                <td className="p-2">{r.name}</td>
                <td className="p-2 text-right">{r.reviews}</td>
                <td className="p-2 text-right">{r.posted}</td>
                <td className="p-2 text-right">{r.findings}</td>
                <td className="p-2 text-right">{formatUsd(r.cost_usd)}</td>
                <td className="p-2 text-right">{formatTokens(r.tokens)}</td>
                <td className="p-2 text-right">{formatMs(r.median_run_ms)}</td>
                <td className="p-2 text-right">{formatMs(r.median_to_post_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function Analytics() {
  const [days, setDays] = useState('90')
  const [data, setData] = useState<Data | null>(null)

  useEffect(() => {
    api
      .analytics(Number(days))
      .then(setData)
      .catch((e) => toast.error(String((e as Error).message)))
  }, [days])

  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>

  const t = data.totals

  return (
    <div className="space-y-6">
      <OptionPicker label="Range" options={RANGES} value={days} onChange={setDays} />

      {t.reviews === 0 ? (
        <p className="text-sm text-muted-foreground">
          No finished reviews in this range. Post or discard one and it shows up here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Tile label="Reviews" value={String(t.reviews)} />
            <Tile label="Posted" value={`${t.posted} of ${t.reviews}`} />
            <Tile label="Comments posted" value={String(t.findings)} />
            <Tile label="Cost" value={formatUsd(t.cost_usd)} />
            <Tile label="Tokens" value={formatTokens(t.tokens)} />
            <Tile label="Median run" value={formatMs(t.median_run_ms)} />
            <Tile label="Median wait to post" value={formatMs(t.median_to_post_ms)} />
          </div>

          <Section title="By repository" series={data.series} which="repos" rows={data.repos} />
          <Section title="By author" series={data.series} which="authors" rows={data.authors} />
        </>
      )}
    </div>
  )
}
