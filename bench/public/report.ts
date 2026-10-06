/**
 * Markdown rendering of one evaluation set's results.
 *
 * @module bench/public/report
 */

import { MASK_OUTCOMES, fraction } from './metrics.ts'
import type { MaskOutcome, Rate, Scorecard, SystemReport, ValueScore } from './metrics.ts'

/** Which evaluation set a result belongs to. */
export type SetLabel = 'dev' | 'held-out'

/** Everything one run produced on one evaluation set; written as JSON beside the Markdown. */
export interface SetResult {
  set: SetLabel
  /** Where the samples came from: generator seed and size, or held-out file and hash. */
  source: string
  /** Command that reproduces this result. */
  reproduce: string
  sampleCount: number
  goldCount: number
  negativeCount: number
  /** Version of the built-in rules that were measured. */
  detectorVersion: string
  /** Edits to the set made after its results were seen. */
  editsAfterResults: string[]
  /** Every system on English prompts only: the comparison with English-only analyzers. */
  english: SystemReport[]
  /** Every system on every prompt. */
  allLanguages: SystemReport[]
  skipped: { name: string; reason: string }[]
}

/** One comparison table: a row per key, a column per system. */
interface TableSpec {
  label: string
  keys: readonly string[]
  cell: (system: SystemReport, key: string) => string
}

const NO_VALUES: Rate = { hits: 0, total: 0 }
const NOT_MEASURED = '—'
const PERCENT_DIGITS = 1
const MILLISECOND_DIGITS = 2
const ENGLISH = 'en'
const REFERENCE_ONLY = 'reference only: English analyzer'
const OUTCOME_LEGEND = 'Each cell: fully masked / partly masked / untouched, as a share of the sensitive values in that row.'

/**
 * @param result - one evaluation set's results.
 * @returns the report as Markdown.
 */
export function renderMarkdown(result: SetResult): string {
  const allLanguages = result.allLanguages.map(markReferenceOnly)
  return [
    `# Public redaction benchmark: ${result.set} set`,
    renderSummary(result),
    `## English prompts by category (${result.set})`,
    OUTCOME_LEGEND,
    renderCategoryTable(result.english),
    renderCoreTable(result.english),
    `## English prompts: precision, restore, latency (${result.set})`,
    renderOperationTable(result.english),
    renderNegativeTable(result.english),
    `## All languages by category (${result.set})`,
    `Systems marked "${REFERENCE_ONLY}" analyze every prompt as English, so their results outside English are for reference only. ${OUTCOME_LEGEND}`,
    renderCategoryTable(allLanguages),
    renderCoreTable(allLanguages),
    renderTable(allLanguages, { label: 'Language', keys: groupKeys(allLanguages, system => system.byLanguage), cell: languageCell }),
    details('All languages: hard negatives masked, and results by format',
      `${renderNegativeTable(allLanguages)}\n\n${renderTable(allLanguages, { label: 'Format', keys: groupKeys(allLanguages, system => system.byFormat), cell: (system, format) => scorecardCell(system.byFormat[format]) })}`),
    renderNotes(result),
  ].filter(section => section !== '').join('\n\n') + '\n'
}

/** Headline numbers of one system for charts: shares in 0..1, latency in milliseconds. */
export interface SystemSummary {
  name: string
  byCategory: Record<string, Record<MaskOutcome, number>>
  macroAverage: Record<MaskOutcome, number>
  regionPrecision: number
  hardNegativesMasked: Record<string, number>
  latencyMs: { p50: number; p95: number }
}

/**
 * @param result - one evaluation set's results, as written to `public-bench-<set>.json`.
 * @returns the set's headline numbers per system, English prompts and all languages.
 */
export function summarize(result: SetResult): { set: SetLabel; source: string; english: SystemSummary[]; allLanguages: SystemSummary[] } {
  return { set: result.set, source: result.source, english: result.english.map(summarizeSystem), allLanguages: result.allLanguages.map(summarizeSystem) }
}

function summarizeSystem(system: SystemReport): SystemSummary {
  const shares = <K extends string>(rates: Record<K, Rate>): Record<K, number> =>
    Object.fromEntries(Object.entries<Rate>(rates).map(([key, rate]) => [key, fraction(rate)])) as Record<K, number>
  return {
    name: system.name,
    byCategory: Object.fromEntries(Object.entries(system.byCategory).map(([category, score]) => [category, shares(score.outcomes)])),
    macroAverage: system.macroAverage.outcomes,
    regionPrecision: fraction(system.overall.regionPrecision),
    hardNegativesMasked: shares(system.negativeHits),
    latencyMs: { p50: system.latency.median, p95: system.latency.p95 },
  }
}

function markReferenceOnly(system: SystemReport): SystemReport {
  return system.englishAnalyzerOnly === true ? { ...system, name: `${system.name} (${REFERENCE_ONLY})` } : system
}

function renderSummary(result: SetResult): string {
  return `**${result.set} set.** ${result.source}: ${result.sampleCount} synthetic prompts, ${result.goldCount} sensitive values, `
    + `${result.negativeCount} hard negatives. Built-in rules \`${result.detectorVersion}\`; each system names its rule set. Reproduce with \`${result.reproduce}\`.`
}

function renderCategoryTable(systems: readonly SystemReport[]): string {
  const categoryRows = categoryKeys(systems).map(category => [category, ...systems.map(system => outcomeCell(system.byCategory[category]))])
  const macroLabel = `**Macro average** (${systems[0]?.macroAverage.categories ?? 0} categories, equal weight)`
  const macroRow = [macroLabel, ...systems.map(system => MASK_OUTCOMES.map(outcome => formatFraction(system.macroAverage.outcomes[outcome])).join(' / '))]
  return markdownTable(['Category', ...systems.map(system => system.name)], [...categoryRows, macroRow])
}

function renderCoreTable(systems: readonly SystemReport[]): string {
  const categories = categoryKeys(systems).filter(category => systems.some(system => (system.byCategory[category]?.coreFullyMasked.total ?? 0) > 0))
  if (categories.length === 0) return ''
  return renderTable(systems, {
    label: 'Identifying core fully masked',
    keys: categories,
    cell: (system, category) => percent(system.byCategory[category]?.coreFullyMasked ?? NO_VALUES),
  })
}

function renderOperationTable(systems: readonly SystemReport[]): string {
  const rows = systems.map(system => [
    system.name,
    percent(system.overall.regionPrecision),
    system.overall.restoreExact === undefined ? 'n/a' : percent(system.overall.restoreExact),
    system.latency.median.toFixed(MILLISECOND_DIGITS),
    system.latency.p95.toFixed(MILLISECOND_DIGITS),
  ])
  return markdownTable(['System', 'Region precision', 'Restore exact', 'Median ms', 'p95 ms'], rows)
}

function renderNegativeTable(systems: readonly SystemReport[]): string {
  return renderTable(systems, {
    label: 'Hard negatives masked (lower is better)',
    keys: groupKeys(systems, system => system.negativeHits),
    cell: (system, kind) => percent(system.negativeHits[kind] ?? NO_VALUES),
  })
}

function renderTable(systems: readonly SystemReport[], spec: TableSpec): string {
  return markdownTable(
    [spec.label, ...systems.map(system => system.name)],
    spec.keys.map(key => [key, ...systems.map(system => spec.cell(system, key))]),
  )
}

function renderNotes(result: SetResult): string {
  return [
    '## Notes',
    ...new Set(result.allLanguages.flatMap(system => system.note === undefined ? [] : [`- ${system.note}.`])),
    ...result.skipped.map(entry => `- ${entry.name} skipped: ${entry.reason}.`),
    '- Matching ignores category names. Fully masked: detections cover every character of the value. Partly masked: a detection overlaps the value but leaves part of it in the text. '
      + 'Untouched: no detection overlaps the value. Identifying core: the part of a value that names someone or something (a phone number without its country code, '
      + 'the user name of a home path, the first label of a host name); a system that masks only that part still hides who it is.',
    '- Region precision: a masked region (overlapping detections merged) counts when it overlaps a sensitive value; one detection spanning a whole prompt would score 100%. '
      + 'Restore exact: in the same process, restoring the masked text with the same placeholder registry gives the original byte for byte; no model is involved.',
    '- Latency is per prompt, in process, after start-up (model loading excluded). It compares in-process regular expressions with Python and spaCy named-entity recognition, '
      + "and the proxy's time includes restoring the masked text while Presidio's is analysis only.",
    ...result.editsAfterResults.map(edit => `- Edited after results were seen: ${edit}`),
  ].join('\n')
}

function outcomeCell(score: ValueScore | undefined): string {
  if (score === undefined) return NOT_MEASURED
  return MASK_OUTCOMES.map(outcome => percent(score.outcomes[outcome])).join(' / ')
}

function scorecardCell(score: Scorecard | undefined): string {
  return score === undefined ? NOT_MEASURED : `${percent(score.outcomes.fullyMasked)} fully masked, ${percent(score.regionPrecision)} precision`
}

function languageCell(system: SystemReport, language: string): string {
  const cell = scorecardCell(system.byLanguage[language])
  return system.englishAnalyzerOnly === true && language !== ENGLISH ? `${cell} (${REFERENCE_ONLY})` : cell
}

function categoryKeys(systems: readonly SystemReport[]): string[] {
  return groupKeys(systems, system => system.byCategory)
}

function groupKeys(systems: readonly SystemReport[], groups: (system: SystemReport) => Record<string, unknown>): string[] {
  return [...new Set(systems.flatMap(system => Object.keys(groups(system))))]
}

function percent(rate: Rate): string {
  return rate.total === 0 ? NOT_MEASURED : formatFraction(fraction(rate))
}

function formatFraction(value: number): string {
  return `${(value * 100).toFixed(PERCENT_DIGITS)}%`
}

function details(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`
}

function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n')
}
