/**
 * Scoring for the public benchmark. Matching is category-agnostic, because
 * systems name categories differently and what matters for privacy is how
 * much of each value left the machine:
 *
 * - each sensitive value is fully masked (detections cover all of it), partly
 *   masked (a detection overlaps it but leaves part of it), or untouched (no
 *   detection overlaps it);
 * - core: a value with a `core` span counts when detections cover its identifying part;
 * - macro average: the mean of the per-category rates, each category weighted equally;
 * - region precision: a masked region (overlapping detections merged) counts when it overlaps any sensitive value;
 * - negative hits: a hard negative counts when any detection overlaps it;
 * - restore: a sample counts when restoring the masked text gives the original back byte for byte.
 *
 * @module bench/public/metrics
 */

import type { GoldSpan, Sample, Span } from './dataset.ts'
import type { SampleOutcome, SystemRun } from './systems.ts'

/** A count of hits among a total. */
export interface Rate {
  hits: number
  total: number
}

/** How much of one sensitive value a system masked. */
export type MaskOutcome = 'fullyMasked' | 'partlyMasked' | 'untouched'

/** Every mask outcome, in report order. */
export const MASK_OUTCOMES: readonly MaskOutcome[] = ['fullyMasked', 'partlyMasked', 'untouched']

/** Mask outcomes over a group of sensitive values. */
export interface ValueScore {
  outcomes: Record<MaskOutcome, Rate>
  /** Values with a core span whose core is fully masked; `total` is 0 when no value has one. */
  coreFullyMasked: Rate
}

/** Scores over a group of samples. */
export interface Scorecard extends ValueScore {
  regionPrecision: Rate
  /** Absent for a system that cannot restore. */
  restoreExact?: Rate
}

/** Latency percentiles in milliseconds. */
export interface Latency {
  median: number
  p95: number
}

/** Every score of one system over one group of samples. */
export interface SystemReport {
  name: string
  note?: string
  /** The system analyzes every prompt as English; its results on other languages are reference only. */
  englishAnalyzerOnly?: true
  /** One entry per category of the scored set, in its report order. */
  byCategory: Record<string, ValueScore>
  /** Mean of the per-category rates over the categories present, each weighted equally. */
  macroAverage: { categories: number; outcomes: Record<MaskOutcome, number> }
  overall: Scorecard
  byLanguage: Record<string, Scorecard>
  byFormat: Record<string, Scorecard>
  negativeHits: Record<string, Rate>
  latency: Latency
}

/** One sensitive value and what a system did to it. */
interface JudgedValue {
  gold: GoldSpan
  outcome: MaskOutcome
  coreFullyMasked?: boolean
}

/** One sample's outcome judged against its ground truth. */
interface Judgement {
  sample: Sample
  outcome: SampleOutcome
  values: JudgedValue[]
  regionRelevant: boolean[]
  negativeHit: boolean[]
}

const MEDIAN_PERCENT = 50
const TAIL_PERCENT = 95

/**
 * Score one system on a group of samples.
 * @param run - the system's outcomes; may cover more samples than `samples`.
 * @param samples - the samples to score.
 * @param categories - the set's gold categories, in report order.
 * @returns per-category, macro-average, overall, per-language, and per-format scores, hard-negative hits, and latency.
 * @throws {Error} when the run has no outcome for a sample.
 */
export function scoreSystem(run: SystemRun, samples: readonly Sample[], categories: readonly string[]): SystemReport {
  const judgements = samples.map(sample => judge(sample, outcomeOf(run, sample)))
  const allValues = judgements.flatMap(j => j.values)
  const byCategory = tabulate(categories, category => scoreValues(allValues.filter(value => value.gold.category === category)))
  const milliseconds = judgements.map(j => j.outcome.milliseconds)
  return {
    name: run.name,
    ...(run.note === undefined ? {} : { note: run.note }),
    ...(run.englishAnalyzerOnly === undefined ? {} : { englishAnalyzerOnly: run.englishAnalyzerOnly }),
    byCategory,
    macroAverage: macroAverage(Object.values(byCategory)),
    overall: scoreJudgements(judgements),
    byLanguage: scoreGroups(judgements, sample => sample.language),
    byFormat: scoreGroups(judgements, sample => sample.format),
    negativeHits: countNegativeHits(judgements),
    latency: { median: percentile(milliseconds, MEDIAN_PERCENT), p95: percentile(milliseconds, TAIL_PERCENT) },
  }
}

/**
 * @param target - a sensitive value's range.
 * @param detected - every range a system masked in the sample.
 * @returns how much of the value the detections masked.
 */
export function classify(target: Span, detected: readonly Span[]): MaskOutcome {
  if (isCovered(target, detected)) return 'fullyMasked'
  return detected.some(range => overlaps(range, target)) ? 'partlyMasked' : 'untouched'
}

function outcomeOf(run: SystemRun, sample: Sample): SampleOutcome {
  const outcome = run.outcomes.get(sample.id)
  if (outcome === undefined) throw new Error(`${run.name} has no outcome for sample ${sample.id}`)
  return outcome
}

function judge(sample: Sample, outcome: SampleOutcome): Judgement {
  const { detected } = outcome
  return {
    sample,
    outcome,
    values: sample.gold.map(gold => ({
      gold,
      outcome: classify(gold, detected),
      ...(gold.core === undefined ? {} : { coreFullyMasked: isCovered(gold.core, detected) }),
    })),
    regionRelevant: mergeOverlapping(detected).map(region => sample.gold.some(gold => overlaps(region, gold))),
    negativeHit: sample.negatives.map(negative => detected.some(range => overlaps(range, negative))),
  }
}

function scoreValues(values: readonly JudgedValue[]): ValueScore {
  return {
    outcomes: tabulate(MASK_OUTCOMES, outcome => countTrue(values.map(value => value.outcome === outcome))),
    coreFullyMasked: countTrue(values.flatMap(value => value.coreFullyMasked ?? [])),
  }
}

function macroAverage(categories: readonly ValueScore[]): SystemReport['macroAverage'] {
  const present = categories.filter(category => category.outcomes.fullyMasked.total > 0)
  const mean = (outcome: MaskOutcome): number =>
    present.reduce((sum, category) => sum + fraction(category.outcomes[outcome]), 0) / present.length
  return { categories: present.length, outcomes: tabulate(MASK_OUTCOMES, mean) }
}

function scoreJudgements(judgements: readonly Judgement[]): Scorecard {
  const restoreFlags = judgements.map(j => j.outcome.restoredExactly)
  const restorable = restoreFlags.every(flag => flag !== undefined)
  return {
    ...scoreValues(judgements.flatMap(j => j.values)),
    regionPrecision: countTrue(judgements.flatMap(j => j.regionRelevant)),
    ...(restorable ? { restoreExact: countTrue(restoreFlags.map(flag => flag === true)) } : {}),
  }
}

function scoreGroups(judgements: readonly Judgement[], groupOf: (sample: Sample) => string): Record<string, Scorecard> {
  const groups = distinct(judgements.map(j => groupOf(j.sample)))
  return tabulate(groups, group => scoreJudgements(judgements.filter(j => groupOf(j.sample) === group)))
}

function countNegativeHits(judgements: readonly Judgement[]): Record<string, Rate> {
  const negatives = judgements.flatMap(j => j.sample.negatives.map((negative, i) => ({ kind: negative.kind, hit: j.negativeHit[i] === true })))
  const kinds = distinct(negatives.map(negative => negative.kind))
  return tabulate(kinds, kind => countTrue(negatives.filter(negative => negative.kind === kind).map(negative => negative.hit)))
}

function tabulate<K extends string, V>(keys: readonly K[], score: (key: K) => V): Record<K, V> {
  return Object.fromEntries(keys.map(key => [key, score(key)])) as Record<K, V>
}

function distinct(keys: readonly string[]): string[] {
  return [...new Set(keys)]
}

function countTrue(flags: readonly boolean[]): Rate {
  return { hits: flags.filter(Boolean).length, total: flags.length }
}

/**
 * @param rate - a count of hits.
 * @returns hits as a fraction of the total, or 0 for an empty total.
 */
export function fraction(rate: Rate): number {
  return rate.total === 0 ? 0 : rate.hits / rate.total
}

/**
 * @param a - one range.
 * @param b - another range.
 * @returns whether the ranges share at least one code unit.
 */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * @param target - range that must be covered.
 * @param ranges - detected ranges, in any order, possibly adjacent.
 * @returns whether every code unit of `target` lies in some range.
 */
export function isCovered(target: Span, ranges: readonly Span[]): boolean {
  let coveredUntil = target.start
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start <= coveredUntil && range.end > coveredUntil) coveredUntil = range.end
  }
  return coveredUntil >= target.end
}

/**
 * Merge ranges that share a code unit, so a value a system reports twice
 * under two entity types is counted once.
 * @param ranges - ranges in any order.
 * @returns disjoint ranges in start order.
 */
export function mergeOverlapping(ranges: readonly Span[]): Span[] {
  const merged: Span[] = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last !== undefined && range.start < last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ start: range.start, end: range.end })
  }
  return merged
}

/**
 * Nearest-rank percentile.
 * @param samples - measurements.
 * @param percent - 0..100.
 * @returns the measurement at that rank, or 0 for no measurements.
 */
export function percentile(samples: readonly number[], percent: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((percent / 100) * sorted.length)
  return sorted[Math.max(rank - 1, 0)] ?? 0
}
