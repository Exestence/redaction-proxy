/**
 * Scoring for the public benchmark. Matching is category-agnostic, because
 * systems name categories differently and what matters for privacy is
 * whether the value left the machine:
 *
 * - recall: a gold span counts when the union of detected ranges covers all of it;
 * - leak: a gold value counts when its exact string is still in the masked text;
 * - precision: a masked region (overlapping detections merged) counts when it overlaps any gold span;
 * - negative hits: a hard negative counts when any detected range overlaps it;
 * - restore: a sample counts when restoring the masked text gives the original back byte for byte.
 *
 * @module bench/public/metrics
 */

import { GOLD_CATEGORIES, NEGATIVE_KINDS } from './dataset.ts'
import type { GoldCategory, NegativeKind, Sample, Span } from './dataset.ts'
import type { SampleOutcome, SystemRun } from './systems.ts'
import { FORMATS } from './templates.ts'
import type { Format } from './templates.ts'
import { LANGUAGES } from './values.ts'
import type { Language } from './values.ts'

/** A count of hits among a total. */
export interface Rate {
  hits: number
  total: number
}

/** Scores over gold spans only. */
export interface GoldScore {
  recall: Rate
  leak: Rate
}

/** Scores over a group of samples. */
export interface Scorecard extends GoldScore {
  precision: Rate
  /** Absent for a system that cannot restore. */
  restoreExact?: Rate
}

/** Latency percentiles in milliseconds. */
export interface Latency {
  p50: number
  p95: number
}

/** Every score of one system. */
export interface SystemReport {
  name: string
  note?: string
  overall: Scorecard
  byCategory: Record<GoldCategory, GoldScore>
  byLanguage: Record<Language, Scorecard>
  byFormat: Record<Format, Scorecard>
  negativeHits: Record<NegativeKind, Rate>
  latency: Latency
}

/** One sample's outcome judged against its ground truth. */
interface Judgement {
  sample: Sample
  outcome: SampleOutcome
  goldCovered: boolean[]
  goldLeaked: boolean[]
  detectionRelevant: boolean[]
  negativeHit: boolean[]
}

const P50 = 50
const P95 = 95

/**
 * Score one system on the dataset.
 * @param run - the system's outcomes.
 * @param samples - the dataset the outcomes belong to.
 * @returns overall, per-category, per-language, and per-format scores, hard-negative hits, and latency.
 * @throws {Error} when the run has no outcome for a sample.
 */
export function scoreSystem(run: SystemRun, samples: readonly Sample[]): SystemReport {
  const judgements = samples.map(sample => judge(sample, outcomeOf(run, sample)))
  return {
    name: run.name,
    ...(run.note === undefined ? {} : { note: run.note }),
    overall: scoreJudgements(judgements),
    byCategory: tabulate(GOLD_CATEGORIES, category => scoreCategory(judgements, category)),
    byLanguage: tabulate(LANGUAGES, language => scoreJudgements(judgements.filter(j => j.sample.language === language))),
    byFormat: tabulate(FORMATS, format => scoreJudgements(judgements.filter(j => j.sample.format === format))),
    negativeHits: tabulate(NEGATIVE_KINDS, kind => countNegativeHits(judgements, kind)),
    latency: {
      p50: percentile(judgements.map(j => j.outcome.milliseconds), P50),
      p95: percentile(judgements.map(j => j.outcome.milliseconds), P95),
    },
  }
}

function outcomeOf(run: SystemRun, sample: Sample): SampleOutcome {
  const outcome = run.outcomes.get(sample.id)
  if (outcome === undefined) throw new Error(`${run.name} has no outcome for sample ${sample.id}`)
  return outcome
}

function judge(sample: Sample, outcome: SampleOutcome): Judgement {
  return {
    sample,
    outcome,
    goldCovered: sample.gold.map(gold => isCovered(gold, outcome.detected)),
    goldLeaked: sample.gold.map(gold => outcome.masked.includes(sample.text.slice(gold.start, gold.end))),
    detectionRelevant: mergeOverlapping(outcome.detected).map(region => sample.gold.some(gold => overlaps(region, gold))),
    negativeHit: sample.negatives.map(negative => outcome.detected.some(detected => overlaps(detected, negative))),
  }
}

function scoreJudgements(judgements: readonly Judgement[]): Scorecard {
  const restoreFlags = judgements.map(j => j.outcome.restoredExactly)
  const restorable = restoreFlags.every(flag => flag !== undefined)
  return {
    recall: countTrue(judgements.flatMap(j => j.goldCovered)),
    leak: countTrue(judgements.flatMap(j => j.goldLeaked)),
    precision: countTrue(judgements.flatMap(j => j.detectionRelevant)),
    ...(restorable ? { restoreExact: countTrue(restoreFlags.map(flag => flag === true)) } : {}),
  }
}

function scoreCategory(judgements: readonly Judgement[], category: GoldCategory): GoldScore {
  const inCategory = (flags: (j: Judgement) => boolean[]): boolean[] =>
    judgements.flatMap(j => flags(j).filter((_, i) => j.sample.gold[i]?.category === category))
  return { recall: countTrue(inCategory(j => j.goldCovered)), leak: countTrue(inCategory(j => j.goldLeaked)) }
}

function countNegativeHits(judgements: readonly Judgement[], kind: NegativeKind): Rate {
  return countTrue(judgements.flatMap(j => j.negativeHit.filter((_, i) => j.sample.negatives[i]?.kind === kind)))
}

function tabulate<K extends string, V>(keys: readonly K[], score: (key: K) => V): Record<K, V> {
  return Object.fromEntries(keys.map(key => [key, score(key)])) as Record<K, V>
}

function countTrue(flags: readonly boolean[]): Rate {
  return { hits: flags.filter(Boolean).length, total: flags.length }
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
