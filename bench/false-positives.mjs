// Measure what the default rules mask in a public source corpus that holds no
// working credential. Run `pnpm bench` (it builds first). The corpus is the
// public DeepSeek Harness repository (github.com/deepseek-ai/deepseek-harness)
// at a pinned commit, exported read-only with `git archive`: CORPUS_REPO names
// a local checkout (required), CORPUS_REF the commit (default 687f282e86, the
// commit the published numbers use).
//
// Headline metric: KEY (credential) spans
// per 1,000 lines of code files (.ts .json .sh .py). Every such span is a false
// positive because source files carry no working credential. Other categories
// are reported per 1,000 lines of all files; they are an upper bound on false
// positives, since documentation does contain example paths and addresses.
//
// BENCH_RULES=all measures every built-in rule, the international and
// extended ones included; BENCH_RULES=proxy measures the proxy's default rule
// set; by default the bench measures the core default rule set.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RULE_NAMES, RedactionError, RulesDetector, emptyRedactionIndex, mask, restore } from '../lib/core/index.js'
import { PROXY_DEFAULT_RULES } from '../lib/proxy/config.js'

const REPO = process.env.CORPUS_REPO
if (REPO === undefined || REPO === '') {
  console.log('set CORPUS_REPO to a local checkout of github.com/deepseek-ai/deepseek-harness (the published numbers use commit 687f282e86)')
  process.exit(1)
}
const REF = process.env.CORPUS_REF ?? '687f282e86'
const SKIP = /(?:^|\/)(?:snapshots?|sessions?|fixtures?|__fixtures__|node_modules|lib|dist|coverage)(?:\/|$)/
const TEXT = /\.(?:ts|md|ya?ml|json|sh|py)$/
const DOC = /\.(?:md|ya?ml)$/

const sha = spawnSync('git', ['-C', REPO, 'rev-parse', `${REF}^{commit}`], { encoding: 'utf8' }).stdout.trim()
if (sha === '') {
  console.log(`no readable ${REF} in ${REPO}`)
  process.exit(1)
}
const work = join(import.meta.dirname, '..', '.corpus-work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const archive = spawnSync('sh', ['-c', `git -C "${REPO}" archive ${sha} packages docs scripts | tar -x -C "${work}"`], { stdio: 'inherit' })
if (archive.status !== 0) process.exit(1)

const files = []
const walk = directory => {
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name)
    if (SKIP.test(relative(work, full))) continue
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full)
    else if (TEXT.test(name) && stat.size < 512 * 1024) files.push(full)
  }
}
for (const root of ['packages', 'docs', 'scripts']) walk(join(work, root))

const RULE_SETS = { all: { rules: [...RULE_NAMES] }, proxy: { rules: [...PROXY_DEFAULT_RULES] } }
const detector = new RulesDetector(RULE_SETS[process.env.BENCH_RULES] ?? {})
const byCategory = new Map()
const codeByCategory = new Map()
const refused = new Map()
let lines = 0
let codeLines = 0
let codeKeys = 0
let restoreFailures = 0
const started = performance.now()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const fileLines = text.split('\n').length
  const isDoc = DOC.test(file)
  lines += fileLines
  if (!isDoc) codeLines += fileLines
  let result
  try {
    result = await mask(detector, [{ seq: 1, path: '', text }], emptyRedactionIndex())
  } catch (error) {
    if (!(error instanceof RedactionError)) throw error
    refused.set(error.code, (refused.get(error.code) ?? 0) + 1)
    continue
  }
  const back = restore(result.masked[0], result.registry)
  if (!back.ok || back.text !== text) restoreFailures += 1
  for (const span of result.applied) {
    const category = span.id.slice(0, span.id.lastIndexOf('_'))
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1)
    if (!isDoc) codeByCategory.set(category, (codeByCategory.get(category) ?? 0) + 1)
    if (!isDoc && category === 'KEY') codeKeys += 1
  }
}
const ms = performance.now() - started
rmSync(work, { recursive: true, force: true })

const per1k = (count, over) => ((count / over) * 1000).toFixed(2)
console.log(`corpus: ${REPO} @ ${sha} (packages, docs, scripts; ${TEXT.source})`)
console.log(`detector ${detector.detectorVersion}, rules ${process.env.BENCH_RULES in RULE_SETS ? process.env.BENCH_RULES : 'default'}`)
console.log(`files ${files.length}, lines ${lines}, code lines ${codeLines}, ${ms.toFixed(0)} ms`)
console.log(`KEY spans in code files: ${codeKeys} = ${per1k(codeKeys, codeLines)} per 1k code lines (all false positives)`)
for (const [category, count] of [...byCategory].sort((a, b) => b[1] - a[1])) {
  const code = codeByCategory.get(category) ?? 0
  console.log(`  ${category.padEnd(8)} ${String(count).padStart(6)}  ${per1k(count, lines)} per 1k lines; code ${String(code).padStart(6)}  ${per1k(code, codeLines)} per 1k code lines`)
}
console.log(`refused files: ${[...refused].map(([code, n]) => `${code} ${n}`).join(', ') || 'none'}; restore failures: ${restoreFailures}`)
