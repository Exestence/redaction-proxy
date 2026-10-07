// Draws the README results chart from a public-bench results JSON: the share
// of sensitive values fully masked per category, one bar per plotted system.
// Colors are mid-tones so the SVG reads on light and dark pages.
//
//   node bench/results-chart.mjs [--input results.json] [--out out.svg]
//     [--split english|allLanguages] [--systems "name;name;name"] [--label text]
//
// Defaults: the held-out v2 JSON, docs/media/results.svg, English prompts, and the
// three systems the README compares. --systems takes exact names from the JSON,
// separated by ";" because the names contain commas; at most three.

import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const DEFAULT_SYSTEMS = [
  'rules, proxy default',
  'rules + name model (experimental)',
  'Presidio 2.2.364 (en_core_web_lg, cutoff 0.4)',
]
const SET_LABELS = {
  dev: 'dev set (preliminary)',
  'held-out': 'held-out set v1 (written blind, run once)',
  'held-out-v2': 'held-out set v2 (written blind, run once)',
}
const SPLIT_LABELS = { english: 'English prompts', allLanguages: 'all languages' }
const SYSTEM_NOTES = {
  'rules, core default': "rules, core default: the core library's default rules (no international rules, no terms, no name model).",
  'rules, proxy default': 'rules, proxy default: every built-in rule except e164-phone, as the proxy enables them (no terms, no name model).',
  'rules + name model (experimental)': 'rules + name model: the proxy-default rules plus the experimental name model, which reads prose lines only.',
}
const COLORS = ['#2f81f7', '#bf8700', '#a475f9']

const { values: args } = parseArgs({
  options: {
    input: { type: 'string', default: 'bench/results/public-bench-held-out-v2.json' },
    out: { type: 'string', default: 'docs/media/results.svg' },
    split: { type: 'string', default: 'english' },
    systems: { type: 'string', default: DEFAULT_SYSTEMS.join(';') },
    label: { type: 'string' },
  },
})
if (!(args.split in SPLIT_LABELS)) throw new Error(`--split must be one of: ${Object.keys(SPLIT_LABELS).join(', ')}`)
const results = JSON.parse(readFileSync(args.input, 'utf8'))
const names = args.systems.split(';').map(name => name.trim())
if (names.length > COLORS.length) throw new Error(`at most ${COLORS.length} systems, one color each`)
const systems = names.map(name => {
  const system = results[args.split].find(s => s.name === name)
  if (!system) throw new Error(`no system named "${name}" in ${args.input}; have: ${results[args.split].map(s => s.name).join('; ')}`)
  return system
})
const label = args.label ?? SET_LABELS[results.set] ?? `${results.set} set`
const languages = Object.keys(results.allLanguages[0].byLanguage)
const english = args.split === 'english'

const categories = Object.keys(systems[0].byCategory)
const share = ({ hits, total }) => (total ? hits / total : 0)
const rows = [
  ...categories.map(name => ({ name, values: systems.map(s => share(s.byCategory[name].outcomes.fullyMasked)) })),
  { name: 'Macro average', values: systems.map(s => s.macroAverage.outcomes.fullyMasked), bold: true },
]
const presidioNote = english
  ? 'Presidio: default recognizers; the cutoff is its score_threshold. English prompts only: it is an English analyzer.'
  : 'Presidio analyzes every prompt as English, so its non-English results are for reference only.'
const notes = [
  ...names.filter(name => name in SYSTEM_NOTES).map(name => SYSTEM_NOTES[name]),
  ...(names.some(name => name.startsWith('Presidio')) ? [presidioNote] : []),
  ['Regenerate: node bench/results-chart.mjs', ...process.argv.slice(2).map(arg => (/[\s;,]/.test(arg) ? `"${arg}"` : arg))].join(' '),
]
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const left = 170, barW = 560, barH = 11, gap = 3, rowH = systems.length * (barH + gap) + 14
const top = 74 + systems.length * 18, width = left + barW + 70, height = top + rows.length * rowH + 4 + notes.length * 18
const out = []
out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t">`)
out.push(`<title id="t">Share of sensitive values fully masked, by category, ${esc(SPLIT_LABELS[args.split])}, ${esc(label)}</title>`)
out.push('<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;fill:#8b949e;font-size:13px}.h{font-size:16px;font-weight:600}.b{font-weight:600}</style>')
out.push(`<text x="0" y="20" class="h">Fully masked, by category, ${esc(SPLIT_LABELS[args.split])}: ${esc(label)}</text>`)
const valueCount = systems[0].overall.outcomes.fullyMasked.total
const scope = english ? 'the English prompts of ' : ''
out.push(`<text x="0" y="40">${valueCount} sensitive values in ${scope}${results.sampleCount} synthetic prompts (${languages.join(', ')}), detector ${esc(results.detectorVersion)}</text>`)
systems.forEach((s, i) => {
  const y = 66 + i * 18
  out.push(`<rect x="0" y="${y - 10}" width="12" height="12" rx="2" fill="${COLORS[i]}"/><text x="18" y="${y}">${esc(s.name)}</text>`)
})
rows.forEach((row, r) => {
  const y = top + r * rowH
  if (row.bold) out.push(`<line x1="0" x2="${width}" y1="${y - 6}" y2="${y - 6}" stroke="#8b949e" stroke-opacity=".4"/>`)
  out.push(`<text x="${left - 10}" y="${y + rowH / 2 - 4}" text-anchor="end"${row.bold ? ' class="b"' : ''}>${esc(row.name)}</text>`)
  row.values.forEach((v, i) => {
    const by = y + i * (barH + gap)
    out.push(`<rect x="${left}" y="${by}" width="${Math.max(1, v * barW).toFixed(1)}" height="${barH}" rx="2" fill="${COLORS[i]}"/>`)
    out.push(`<text x="${left + v * barW + 6}" y="${by + barH - 1}" font-size="11">${(v * 100).toFixed(0)}%</text>`)
  })
})
notes.forEach((note, i) => out.push(`<text x="0" y="${height - 4 - (notes.length - 1 - i) * 18}">${esc(note)}</text>`))
out.push('</svg>')
writeFileSync(args.out, `${out.join('\n')}\n`)
console.log(`wrote ${args.out} (${label}, ${SPLIT_LABELS[args.split]})`)
