/**
 * Public benchmark entry point: build the seeded dataset, run every system,
 * score them, and write `bench/results/public-bench.md` and `.json`.
 *
 * Usage: `pnpm run bench:public [--seed N] [--per-cell N]`.
 *
 * @module bench/public/main
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DETECTOR_VERSION, RulesDetector } from '../../src/core/index.ts'
import { buildDataset } from './dataset.ts'
import type { Sample } from './dataset.ts'
import { scoreSystem } from './metrics.ts'
import { runPresidio } from './presidio.ts'
import { renderMarkdown } from './report.ts'
import type { BenchmarkResult } from './report.ts'
import { runCoreDetector } from './systems.ts'
import type { CoreSystem, SystemRun } from './systems.ts'

const DEFAULT_SEED = 20261005
const DEFAULT_SAMPLES_PER_CELL = 50
const RESULTS_DIRECTORY = join(import.meta.dirname, '..', 'results')

const { values: args } = parseArgs({
  options: {
    'seed': { type: 'string', default: String(DEFAULT_SEED) },
    'per-cell': { type: 'string', default: String(DEFAULT_SAMPLES_PER_CELL) },
  },
})
const seed = positiveInteger(args.seed, '--seed')
const samplesPerCell = positiveInteger(args['per-cell'], '--per-cell')

const samples = buildDataset({ seed, samplesPerCell })

// Add a name-detection model or international rules here as one more core system.
const coreSystems: CoreSystem[] = [{ name: 'redaction-proxy rules', detector: new RulesDetector() }]
const runs: SystemRun[] = []
for (const system of coreSystems) runs.push(await runCoreDetector(system, samples))
const skipped: BenchmarkResult['skipped'] = []
const presidio = runPresidio(samples)
if ('skipped' in presidio) skipped.push({ name: 'Presidio', reason: presidio.reason })
else runs.push(presidio)

const result: BenchmarkResult = {
  seed,
  samplesPerCell,
  sampleCount: samples.length,
  goldCount: countSpans(samples, sample => sample.gold.length),
  negativeCount: countSpans(samples, sample => sample.negatives.length),
  detectorVersion: DETECTOR_VERSION,
  systems: runs.map(run => scoreSystem(run, samples)),
  skipped,
}
const markdown = renderMarkdown(result)
mkdirSync(RESULTS_DIRECTORY, { recursive: true })
writeFileSync(join(RESULTS_DIRECTORY, 'public-bench.md'), markdown)
writeFileSync(join(RESULTS_DIRECTORY, 'public-bench.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(markdown)

function positiveInteger(text: string, option: string): number {
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${option} must be a positive integer`)
  return value
}

function countSpans(all: readonly Sample[], count: (sample: Sample) => number): number {
  return all.reduce((total, sample) => total + count(sample), 0)
}
