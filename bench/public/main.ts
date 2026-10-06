/**
 * Public benchmark entry point: build the seeded dev set, and load the frozen
 * held-out set when one is given; run every system on each set, score them,
 * and write `bench/results/public-bench-<set>.md` and `.json`.
 *
 * Usage: `pnpm run bench:public [--seed N] [--per-cell N] [--heldout path/to/set.jsonl] [--name-model dir]`;
 * the held-out path may also come from `PUBLIC_BENCH_HELDOUT`, the name-model
 * directory from `PUBLIC_BENCH_NAME_MODEL`. Without a model directory the
 * name-model row is reported as skipped.
 *
 * @module bench/public/main
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DETECTOR_VERSION, RulesDetector } from '../../src/core/index.ts'
import { resolveNameModelConfig } from '../../src/core/model/config.ts'
import { NameModelDetector } from '../../src/core/model/detector.ts'
import { loadNameModel } from '../../src/core/model/name-model.ts'
import type { NameModel } from '../../src/core/model/name-model.ts'
import { proseLayout } from '../../src/core/model/prose.ts'
import { PROXY_DEFAULT_RULES } from '../../src/proxy/config.ts'
import { GOLD_CATEGORIES, buildDataset } from './dataset.ts'
import type { Sample } from './dataset.ts'
import { loadHeldOutSet } from './heldout.ts'
import { scoreSystem } from './metrics.ts'
import { runPresidio } from './presidio.ts'
import { renderMarkdown, summarize } from './report.ts'
import type { SetLabel, SetResult } from './report.ts'
import { runCoreDetector } from './systems.ts'
import type { CoreSystem, SystemRun } from './systems.ts'

/** Samples to evaluate and how the report describes them. */
interface EvaluationSet {
  label: SetLabel
  source: string
  reproduce: string
  samples: Sample[]
  /** Gold categories in report order. */
  categories: readonly string[]
  editsAfterResults: string[]
}

const DEFAULT_SEED = 20261005
const DEFAULT_SAMPLES_PER_CELL = 50
const RESULTS_DIRECTORY = join(import.meta.dirname, '..', 'results')
const HELD_OUT_VARIABLE = 'PUBLIC_BENCH_HELDOUT'
const NAME_MODEL_VARIABLE = 'PUBLIC_BENCH_NAME_MODEL'
const NAME_MODEL_SYSTEM = 'rules + name model (experimental)'
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
    'name-model': { type: 'string' },
  },
})
const heldOutPath = args.heldout ?? process.env[HELD_OUT_VARIABLE]
const nameModelDir = args['name-model'] ?? process.env[NAME_MODEL_VARIABLE]
// The proxy's shipped configuration: only the directory is set.
const nameModelArgument = nameModelDir === undefined || nameModelDir === '' ? '' : ' --name-model <model directory>'
const nameModel = nameModelDir === undefined || nameModelDir === '' ? undefined : await loadNameModel(resolveNameModelConfig({ dir: nameModelDir }))
const sets = [devSet(positiveInteger(args.seed, '--seed'), positiveInteger(args['per-cell'], '--per-cell'))]
if (heldOutPath !== undefined && heldOutPath !== '') sets.push(heldOutSet(heldOutPath))

mkdirSync(RESULTS_DIRECTORY, { recursive: true })
for (const set of sets) {
  const result = await evaluate(set)
  const markdown = renderMarkdown(result)
  const baseName = join(RESULTS_DIRECTORY, `public-bench-${set.label}`)
  writeFileSync(`${baseName}.md`, markdown)
  writeFileSync(`${baseName}.json`, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(RESULTS_DIRECTORY, `summary-${set.label}.json`), `${JSON.stringify(summarize(result), null, 2)}\n`)
  console.log(markdown)
}
await nameModel?.release()

function devSet(seed: number, samplesPerCell: number): EvaluationSet {
  return {
    label: 'dev',
    source: `Generated from \`bench/public/templates.ts\`, seed ${seed}, ${samplesPerCell} prompts per language and format`,
    reproduce: `pnpm run bench:public --seed ${seed} --per-cell ${samplesPerCell}${nameModelArgument}`,
    samples: buildDataset({ seed, samplesPerCell }),
    categories: GOLD_CATEGORIES,
    editsAfterResults: DEV_EDITS_AFTER_RESULTS,
  }
}

function heldOutSet(path: string): EvaluationSet {
  const { fileName, sha256, samples, categories } = loadHeldOutSet(path)
  return {
    label: 'held-out',
    source: `Frozen file \`${fileName}\`, SHA-256 \`${sha256}\``,
    reproduce: `pnpm run bench:public --heldout <path to ${fileName}>${nameModelArgument}`,
    samples,
    categories,
    editsAfterResults: [],
  }
}

async function evaluate(set: EvaluationSet): Promise<SetResult> {
  const proxyRules = new RulesDetector({ rules: [...PROXY_DEFAULT_RULES] })
  const coreSystems: CoreSystem[] = [
    { name: 'rules, core default', detector: new RulesDetector() },
    { name: 'rules, proxy default', detector: proxyRules },
  ]
  const skipped: SetResult['skipped'] = []
  if (nameModel === undefined) skipped.push({ name: NAME_MODEL_SYSTEM, reason: `no model directory; pass --name-model or set ${NAME_MODEL_VARIABLE}` })
  else coreSystems.push(nameModelSystem(proxyRules, nameModel, set.samples))
  const runs: SystemRun[] = []
  for (const system of coreSystems) runs.push(await runCoreDetector(system, set.samples))
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
    english: runs.map(run => scoreSystem(run, englishSamples, set.categories)),
    allLanguages: runs.map(run => scoreSystem(run, set.samples, set.categories)),
    skipped,
  }
}

/**
 * The proxy's rules-plus-model detector, with every prompt marked as a user-written message as the proxy marks a
 * single user turn. Inference failures fail the run: the shipped `required: false` would silently score rules only.
 */
function nameModelSystem(rules: RulesDetector, model: NameModel, samples: readonly Sample[]): CoreSystem {
  const userTexts = new Set(samples.map(sample => sample.text))
  const detector = new NameModelDetector(rules, model).forRequest(userTexts, error => { throw error })
  return { name: NAME_MODEL_SYSTEM, detector, note: `${NAME_MODEL_SYSTEM}: the proxy-default rules plus the nym name model (\`${detector.detectorVersion}\`, `
    + 'shipped `nameModel` defaults), through the code path the proxy uses for user-written text. Each prompt is one user message; '
    + 'the model reads only its prose lines and skips code, log, config, and data lines by design, so it cannot find names there '
    + 'except by propagation of a value found in prose. Sensitive values inside prose lines, by format: '
    + `${proseReachByFormat(samples)}. Its latency includes inference` }
}

/** Share of gold values lying inside a prose paragraph the model reads, per format. */
function proseReachByFormat(samples: readonly Sample[]): string {
  const reach = new Map<string, { inside: number; total: number }>()
  for (const sample of samples) {
    const { paragraphs } = proseLayout(sample.text)
    const counts = reach.get(sample.format) ?? { inside: 0, total: 0 }
    for (const gold of sample.gold) {
      counts.total += 1
      if (paragraphs.some(paragraph => paragraph.start <= gold.start && gold.end <= paragraph.end)) counts.inside += 1
    }
    reach.set(sample.format, counts)
  }
  return [...reach].map(([format, { inside, total }]) => `${format} ${total === 0 ? '—' : `${(inside / total * 100).toFixed(0)}%`}`).join(', ')
}

function positiveInteger(text: string, option: string): number {
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${option} must be a positive integer`)
  return value
}

function countSpans(all: readonly Sample[], count: (sample: Sample) => number): number {
  return all.reduce((total, sample) => total + count(sample), 0)
}
