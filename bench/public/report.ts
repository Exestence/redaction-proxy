/**
 * Markdown rendering of the public benchmark results.
 *
 * @module bench/public/report
 */

import { GOLD_CATEGORIES, NEGATIVE_KINDS } from './dataset.ts'
import type { Rate, Scorecard, SystemReport } from './metrics.ts'
import { FORMATS } from './templates.ts'
import { LANGUAGES } from './values.ts'

/** Everything one benchmark run produced; written as JSON beside the Markdown. */
export interface BenchmarkResult {
  seed: number
  samplesPerCell: number
  sampleCount: number
  goldCount: number
  negativeCount: number
  /** Version of the built-in rules that were measured. */
  detectorVersion: string
  systems: SystemReport[]
  skipped: { name: string; reason: string }[]
}

/** One comparison table: a row per key, a column per system. */
interface TableSpec<K extends string> {
  label: string
  keys: readonly K[]
  cell: (system: SystemReport, key: K) => string
}

const PERCENT_DIGITS = 1
const MILLISECOND_DIGITS = 2

/**
 * @param result - one benchmark run.
 * @returns the report as Markdown.
 */
export function renderMarkdown(result: BenchmarkResult): string {
  return [
    '# Public redaction benchmark',
    renderSummary(result),
    '## Overall',
    renderOverall(result.systems),
    '## Recall by category (leak rate in parentheses)',
    renderTable(result.systems, {
      label: 'Category',
      keys: GOLD_CATEGORIES,
      cell: (system, category) => `${percent(system.byCategory[category].recall)} (${percent(system.byCategory[category].leak)})`,
    }),
    '## Recall / precision by language',
    renderTable(result.systems, { label: 'Language', keys: LANGUAGES, cell: (system, language) => recallAndPrecision(system.byLanguage[language]) }),
    '## Hard negatives masked (lower is better)',
    renderTable(result.systems, { label: 'Kind', keys: NEGATIVE_KINDS, cell: (system, kind) => percent(system.negativeHits[kind]) }),
    details('Recall / precision by format',
      renderTable(result.systems, { label: 'Format', keys: FORMATS, cell: (system, format) => recallAndPrecision(system.byFormat[format]) })),
    renderNotes(result),
  ].join('\n\n') + '\n'
}

function renderSummary(result: BenchmarkResult): string {
  return `Seed ${result.seed}: ${result.sampleCount} synthetic prompts (${LANGUAGES.length} languages × ${FORMATS.length} formats × ${result.samplesPerCell}), `
    + `${result.goldCount} sensitive values, ${result.negativeCount} hard negatives. Built-in rules \`${result.detectorVersion}\`, default configuration. `
    + 'Reproduce with `pnpm run bench:public`.'
}

function renderOverall(systems: readonly SystemReport[]): string {
  const rows = systems.map(system => [
    system.name,
    percent(system.overall.recall),
    percent(system.overall.precision),
    percent(system.overall.leak),
    system.overall.restoreExact === undefined ? 'n/a' : percent(system.overall.restoreExact),
    system.latency.p50.toFixed(MILLISECOND_DIGITS),
    system.latency.p95.toFixed(MILLISECOND_DIGITS),
  ])
  return markdownTable(['System', 'Recall', 'Precision', 'Leak rate', 'Restore exact', 'p50 ms', 'p95 ms'], rows)
}

function renderTable<K extends string>(systems: readonly SystemReport[], spec: TableSpec<K>): string {
  return markdownTable(
    [spec.label, ...systems.map(system => system.name)],
    spec.keys.map(key => [key, ...systems.map(system => spec.cell(system, key))]),
  )
}

function renderNotes(result: BenchmarkResult): string {
  const notes = [
    ...result.systems.filter(system => system.note !== undefined).map(system => `- ${system.name}: ${system.note}.`),
    ...result.skipped.map(entry => `- ${entry.name} skipped: ${entry.reason}.`),
  ]
  return [
    '## Notes',
    ...notes,
    '- Matching ignores category names. Recall: a value counts when detections cover all of it. Leak rate: the exact value is still in the masked text. '
      + 'Precision: a masked region counts when it overlaps a sensitive value. Restore exact: the masked text restores to the original byte for byte.',
    '- Latency is per prompt, in process, after start-up (model loading excluded).',
  ].join('\n')
}

function recallAndPrecision(score: Scorecard): string {
  return `${percent(score.recall)} / ${percent(score.precision)}`
}

function percent(rate: Rate): string {
  return rate.total === 0 ? '—' : `${((rate.hits / rate.total) * 100).toFixed(PERCENT_DIGITS)}%`
}

function details(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`
}

function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n')
}
