/**
 * Public benchmark entry point: build the seeded dev set, and load the frozen
 * held-out set when one is given; run every system on each set, score them,
 * and write `bench/results/public-bench-<set>.md` and `.json`.
 *
 * Usage: `pnpm run bench:public [--seed N] [--per-cell N] [--heldout path/to/set.jsonl]`;
 * the held-out path may also come from `PUBLIC_BENCH_HELDOUT`.
 *
 * @module bench/public/main
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DETECTOR_VERSION, RulesDetector } from '../../src/core/index.ts'
import { buildDataset } from './dataset.ts'
import type { Sample } from './dataset.ts'
import { loadHeldOutSet } from './heldout.ts'
import { scoreSystem } from './metrics.ts'
import { runPresidio } from './presidio.ts'
import { renderMarkdown } from './report.ts'
import type { SetLabel, SetResult } from './report.ts'
import { runCoreDetector } from './systems.ts'
import type { CoreSystem, SystemRun } from './systems.ts'

/** Samples to evaluate and how the report describes them. */
interface EvaluationSet {
  label: SetLabel
  source: string
  reproduce: string
  samples: Sample[]
  editsAfterResults: string[]
}

const DEFAULT_SEED = 20261005
const DEFAULT_SAMPLES_PER_CELL = 50
const RESULTS_DIRECTORY = join(import.meta.dirname, '..', 'results')
const HELD_OUT_VARIABLE = 'PUBLIC_BENCH_HELDOUT'
const ENGLISH = 'en'
// Presidio's library default keeps every detection; 0.4 drops its lowest-confidence pattern matches.
const PRESIDIO_SCORE_CUTOFFS = [0, 0.4]
const DEV_EDITS_AFTER_RESULTS = [
  '`session={uuid}` in the log templates was relabelled `request_id={uuid}` after the first run, in which the rules masked every such UUID. '
    + 'A session id is a credential, so the alternative was to keep it and label it SECRET.',
  'a bare commit hash after a version and an `etag={sha256}` context were added after the first run; they added rules false positives.',
]

const { values: args } = parseArgs({
  options: {
    'seed': { type: 'string', default: String(DEFAULT_SEED) },
    'per-cell': { type: 'string', default: String(DEFAULT_SAMPLES_PER_CELL) },
    'heldout': { type: 'string' },
  },
})
const heldOutPath = args.heldout ?? process.env[HELD_OUT_VARIABLE]
const sets = [devSet(positiveInteger(args.seed, '--seed'), positiveInteger(args['per-cell'], '--per-cell'))]
if (heldOutPath !== undefined && heldOutPath !== '') sets.push(heldOutSet(heldOutPath))

mkdirSync(RESULTS_DIRECTORY, { recursive: true })
for (const set of sets) {
  const result = await evaluate(set)
  const markdown = renderMarkdown(result)
  const baseName = join(RESULTS_DIRECTORY, `public-bench-${set.label}`)
  writeFileSync(`${baseName}.md`, markdown)
  writeFileSync(`${baseName}.json`, `${JSON.stringify(result, null, 2)}\n`)
  console.log(markdown)
}

function devSet(seed: number, samplesPerCell: number): EvaluationSet {
  return {
    label: 'dev',
    source: `Generated from \`bench/public/templates.ts\`, seed ${seed}, ${samplesPerCell} prompts per language and format`,
    reproduce: `pnpm run bench:public --seed ${seed} --per-cell ${samplesPerCell}`,
    samples: buildDataset({ seed, samplesPerCell }),
    editsAfterResults: DEV_EDITS_AFTER_RESULTS,
  }
}

function heldOutSet(path: string): EvaluationSet {
  const { fileName, sha256, samples } = loadHeldOutSet(path)
  return {
    label: 'held-out',
    source: `Frozen file \`${fileName}\`, SHA-256 \`${sha256}\``,
    reproduce: `pnpm run bench:public --heldout <path to ${fileName}>`,
    samples,
    editsAfterResults: [],
  }
}

async function evaluate(set: EvaluationSet): Promise<SetResult> {
  // Add a name-detection model or international rules here as one more core system.
  const coreSystems: CoreSystem[] = [{ name: 'redaction-proxy rules', detector: new RulesDetector() }]
  const runs: SystemRun[] = []
  for (const system of coreSystems) runs.push(await runCoreDetector(system, set.samples))
  const skipped: SetResult['skipped'] = []
  for (const cutoff of PRESIDIO_SCORE_CUTOFFS) {
    const presidio = runPresidio(set.samples, cutoff)
    if ('skipped' in presidio) skipped.push({ name: `Presidio, cutoff ${cutoff}`, reason: presidio.reason })
    else runs.push(presidio)
  }
  const englishSamples = set.samples.filter(sample => sample.language === ENGLISH)
  return {
    set: set.label,
    source: set.source,
    reproduce: set.reproduce,
    sampleCount: set.samples.length,
    goldCount: countSpans(set.samples, sample => sample.gold.length),
    negativeCount: countSpans(set.samples, sample => sample.negatives.length),
    detectorVersion: DETECTOR_VERSION,
    editsAfterResults: set.editsAfterResults,
    english: runs.map(run => scoreSystem(run, englishSamples)),
    allLanguages: runs.map(run => scoreSystem(run, set.samples)),
    skipped,
  }
}

function positiveInteger(text: string, option: string): number {
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${option} must be a positive integer`)
  return value
}

function countSpans(all: readonly Sample[], count: (sample: Sample) => number): number {
  return all.reduce((total, sample) => total + count(sample), 0)
}
