// Draws the README results chart from a public-bench results JSON: the share
// of sensitive values fully masked per category, all languages, one bar per
// system. Colors are mid-tones so the SVG reads on light and dark pages.
//
//   node bench/results-chart.mjs [results.json] [out.svg] [label]
//
// Defaults: bench/results/public-bench-dev.json, docs/media/results.svg, and
// a label derived from the JSON's `set` ("dev" becomes "dev set (preliminary)").

import { readFileSync, writeFileSync } from 'node:fs'

const [input = 'bench/results/public-bench-dev.json', output = 'docs/media/results.svg', labelArg] = process.argv.slice(2)
const results = JSON.parse(readFileSync(input, 'utf8'))
const label = labelArg ?? (results.set === 'dev' ? 'dev set (preliminary)' : `${results.set} set`)

const systems = results.allLanguages
const categories = Object.keys(systems[0].byCategory)
const share = ({ hits, total }) => (total ? hits / total : 0)
const rows = [
  ...categories.map(name => ({ name, values: systems.map(s => share(s.byCategory[name].outcomes.fullyMasked)) })),
  { name: 'Macro average', values: systems.map(s => s.macroAverage.outcomes.fullyMasked), bold: true },
]
const COLORS = ['#2f81f7', '#bf8700', '#a475f9']
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const left = 170, barW = 560, barH = 11, gap = 3, rowH = systems.length * (barH + gap) + 14
const top = 74 + systems.length * 18, width = left + barW + 70, height = top + rows.length * rowH + 70
const out = []
out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t">`)
out.push(`<title id="t">Share of sensitive values fully masked, by category, ${esc(label)}</title>`)
out.push('<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;fill:#8b949e;font-size:13px}.h{font-size:16px;font-weight:600}.b{font-weight:600}</style>')
out.push(`<text x="0" y="20" class="h">Fully masked, by category: ${esc(label)}</text>`)
out.push(`<text x="0" y="40">${results.sampleCount} synthetic prompts (en, zh-TW, zh-CN, ja), ${results.goldCount} sensitive values, detector ${esc(results.detectorVersion)}</text>`)
systems.forEach((s, i) => {
  const x = 0, y = 66 + i * 18
  out.push(`<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${COLORS[i % COLORS.length]}"/><text x="${x + 18}" y="${y}">${esc(s.name)}</text>`)
})
rows.forEach((row, r) => {
  const y = top + r * rowH
  if (row.bold) out.push(`<line x1="0" x2="${width}" y1="${y - 6}" y2="${y - 6}" stroke="#8b949e" stroke-opacity=".4"/>`)
  out.push(`<text x="${left - 10}" y="${y + rowH / 2 - 4}" text-anchor="end"${row.bold ? ' class="b"' : ''}>${esc(row.name)}</text>`)
  row.values.forEach((v, i) => {
    const by = y + i * (barH + gap)
    out.push(`<rect x="${left}" y="${by}" width="${Math.max(1, v * barW).toFixed(1)}" height="${barH}" rx="2" fill="${COLORS[i % COLORS.length]}"/>`)
    out.push(`<text x="${left + v * barW + 6}" y="${by + barH - 1}" font-size="11">${(v * 100).toFixed(0)}%</text>`)
  })
})
out.push(`<text x="0" y="${height - 40}">redaction-proxy: the core library's default rules (no international rules, no terms, no name model).</text>`)
out.push(`<text x="0" y="${height - 22}">Presidio analyzes every prompt as English, so its non-English results are for reference only.</text>`)
out.push(`<text x="0" y="${height - 4}">Regenerate: node bench/results-chart.mjs ${esc(input)}</text>`)
out.push('</svg>')
writeFileSync(output, `${out.join('\n')}\n`)
console.log(`wrote ${output} (${label})`)
