/**
 * Systems under test. A system turns each sample into the ranges it masked;
 * `metrics.ts` scores every system the same way.
 *
 * Plug-in point: any {@link RedactionDetector} runs through
 * {@link runCoreDetector}, so a name-detection model or international rules
 * join the benchmark as one more entry of `coreSystems` in `main.ts`, alone
 * or composed with the built-in rules.
 *
 * @module bench/public/systems
 */

import { emptyRedactionIndex, mask, restore } from '../../src/core/index.ts'
import type { RedactionDetector } from '../../src/core/index.ts'
import type { Sample, Span } from './dataset.ts'

/** What one system did to one sample. */
export interface SampleOutcome {
  /** Ranges of the original text the system replaced. */
  detected: Span[]
  /** Whether restoring the masked text gives the original back byte for byte; absent when the system cannot restore. */
  restoredExactly?: boolean
  /** Time the system spent on the sample, in milliseconds; for a core detector this includes restoring. */
  milliseconds: number
}

/** A detector under test and the name the report gives it. */
export interface CoreSystem {
  name: string
  detector: RedactionDetector
  /** Caveat printed beside the system's results. */
  note?: string
}

/** One system's outcomes, keyed by sample id. */
export interface SystemRun {
  name: string
  /** Caveat printed beside the system's results. */
  note?: string
  /** The system analyzes every prompt as English; its results on other languages are reference only. */
  englishAnalyzerOnly?: true
  outcomes: Map<string, SampleOutcome>
}

/**
 * Mask and restore every sample with a core detector, one sample per mask call as the proxy does per request.
 * @param system - detector under test and its name.
 * @param samples - the dataset.
 * @returns the outcome of every sample.
 */
export async function runCoreDetector(system: CoreSystem, samples: readonly Sample[]): Promise<SystemRun> {
  const outcomes = new Map<string, SampleOutcome>()
  for (const sample of samples) {
    const started = performance.now()
    const result = await mask(system.detector, [{ seq: 0, path: '', text: sample.text }], emptyRedactionIndex())
    const masked = result.masked[0] ?? ''
    const restored = restore(masked, result.registry)
    outcomes.set(sample.id, {
      detected: result.applied.map(span => ({ start: span.start, end: span.end })),
      restoredExactly: restored.ok && restored.text === sample.text,
      milliseconds: performance.now() - started,
    })
  }
  return { name: system.name, ...(system.note === undefined ? {} : { note: system.note }), outcomes }
}
