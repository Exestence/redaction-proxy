/**
 * Microsoft Presidio as a comparison system. It runs in the project-local
 * Python environment `bench/presidio/.venv`; without that environment or a
 * spaCy model the benchmark reports Presidio as skipped instead of failing.
 *
 * @module bench/public/presidio
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sample } from './dataset.ts'
import type { SampleOutcome, SystemRun } from './systems.ts'

const PRESIDIO_DIRECTORY = join(import.meta.dirname, '..', 'presidio')
const PYTHON = join(PRESIDIO_DIRECTORY, '.venv', 'bin', 'python')
const RUNNER = join(PRESIDIO_DIRECTORY, 'run_presidio.py')
const SETUP_HINT = 'see bench/presidio/README.md'

/** Presidio could not run; `reason` says what the user can do about it. */
export interface Skipped {
  skipped: true
  reason: string
}

/** First line of the runner's output. */
interface RunHeader {
  model: string
  defaultConfig: boolean
}

/** One line of the runner's output after the header. */
interface RunLine extends SampleOutcome {
  id: string
}

/**
 * Run Presidio over the dataset.
 * @param samples - the dataset.
 * @param workDirectory - directory for the exchanged JSONL files.
 * @returns Presidio's outcomes, or why it was skipped.
 */
export function runPresidio(samples: readonly Sample[], workDirectory: string): SystemRun | Skipped {
  if (!existsSync(PYTHON)) return { skipped: true, reason: `no Python environment at bench/presidio/.venv; ${SETUP_HINT}` }
  const input = join(workDirectory, 'presidio-input.jsonl')
  const output = join(workDirectory, 'presidio-output.jsonl')
  writeFileSync(input, samples.map(sample => JSON.stringify({ id: sample.id, text: sample.text })).join('\n'))
  const run = spawnSync(PYTHON, [RUNNER, input, output], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] })
  if (run.status !== 0) return { skipped: true, reason: `${lastLine(run.stderr)}; ${SETUP_HINT}` }
  return parseRun(readFileSync(output, 'utf8'))
}

function parseRun(jsonl: string): SystemRun {
  const [headerLine = '{}', ...lines] = jsonl.trim().split('\n')
  const header = JSON.parse(headerLine) as RunHeader
  const outcomes = new Map<string, SampleOutcome>()
  for (const line of lines) {
    const { id, ...outcome } = JSON.parse(line) as RunLine
    outcomes.set(id, outcome)
  }
  return {
    name: `Presidio 2.2 (${header.model})`,
    note: header.defaultConfig
      ? 'default analyzer and anonymizer, language "en" for every sample'
      : 'default recognizers on the small spaCy model, not the default en_core_web_lg; language "en" for every sample',
    outcomes,
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) || 'Presidio failed'
}
