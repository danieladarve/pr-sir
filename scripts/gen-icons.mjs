// Run once to regenerate src/components/icons.tsx from koboyo.com.
// Icons are free for commercial use, no attribution required.
import { writeFileSync } from 'node:fs'

const wanted = {
  Alien: 'alien',
  Radar: 'radar',
  MagnifyingGlass: 'magnifying-glass',
  Skull: 'skull',
  FlyingSaucer: 'flying-saucer',
  Bug: 'bug',
  Bomb: 'bomb',
  Satellite: 'satellite',
  AlienChart: 'cartoon-alien-mascot-pointing-chart',
  SettingsScreen: 'cartoon-settings-screen',
}

const parts = []
for (const [component, slug] of Object.entries(wanted)) {
  const svg = await fetch(`https://koboyo.com/icons/svg/${slug}.svg`).then((r) => r.text())
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1]
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim()
  parts.push(
    `export const ${component} = (p: Props) => (\n` +
      `  <svg viewBox="${viewBox}" fill="currentColor" aria-hidden {...p}>\n` +
      `    ${inner}\n` +
      `  </svg>\n)`,
  )
  console.log(`${slug}: ${svg.length} bytes`)
}

writeFileSync(
  'src/components/icons.tsx',
  `// Hand-drawn icons from https://koboyo.com/icons\n` +
    `// Free for personal and commercial use, no attribution required.\n` +
    `// Inlined rather than fetched, so the app makes no external requests.\n` +
    `// Regenerate with scripts/gen-icons.mjs.\n\n` +
    `type Props = React.SVGProps<SVGSVGElement>\n\n` +
    parts.join('\n\n') +
    '\n',
)
