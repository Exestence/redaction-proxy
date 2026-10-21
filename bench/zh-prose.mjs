// Measure what the rules mask in ordinary Chinese prose that holds no
// sensitive value: Chinese Wikipedia articles (CC BY-SA 4.0) as plain text, in
// Traditional (zh-tw) and Simplified (zh-cn) script. The article text is not
// committed; bench/zh-prose-manifest.json lists the pages and revisions.
//
//   node bench/zh-prose.mjs fetch [count]   pick `count` random articles of at
//                                           least 1,000 characters (default 300)
//                                           and write the manifest and the text
//   node bench/zh-prose.mjs fetch --manifest  download the manifest's pages again
//   pnpm run bench:zh-prose                 build, then measure
//
// The text lives in .zh-prose-corpus/ (git-ignored). Wikipedia serves the
// current revision; a page whose revision differs from the manifest is
// reported. Measuring prints spans per 1,000 characters and per 1,000 non-empty
// lines for the core and proxy default rules, writes every masked span with 20
// characters of context to .zh-prose-corpus/spans-<rules>.tsv for reading by
// hand, and writes the counts to bench/results/zh-prose.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CORPUS = join(ROOT, '.zh-prose-corpus')
const MANIFEST = join(ROOT, 'bench', 'zh-prose-manifest.json')
const API = 'https://zh.wikipedia.org/w/api.php'
const USER_AGENT = 'redaction-proxy-bench/0.3 (https://github.com/Exestence/redaction-proxy)'
const VARIANTS = ['zh-tw', 'zh-cn']
const MIN_CHARS = 1000

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`${res.status} from ${url}`)
      return await res.json()
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
}

async function extract(pageid, variant) {
  const page = (await api({ action: 'query', prop: 'extracts|revisions', rvprop: 'ids', explaintext: '1', pageids: String(pageid), variant })).query.pages[0]
  return { title: page.title, revid: page.revisions?.[0]?.revid, text: page.extract ?? '' }
}

async function fetchCorpus(args) {
  mkdirSync(CORPUS, { recursive: true })
  let pages
  if (args[0] === '--manifest') {
    pages = JSON.parse(readFileSync(MANIFEST, 'utf8')).pages
  } else {
    const count = Number(args[0] ?? 300)
    pages = []
    const seen = new Set()
    while (pages.length < count) {
      // Wikitext length screens out stubs before the extract is fetched.
      const batch = (await api({ action: 'query', generator: 'random', grnnamespace: '0', grnlimit: '50', prop: 'info' })).query.pages
      for (const { pageid: id, length } of batch) {
        if (pages.length >= count || seen.has(id) || length < 3 * MIN_CHARS) continue
        seen.add(id)
        const { title, revid, text } = await extract(id, 'zh-tw')
        if (text.length < MIN_CHARS) continue
        pages.push({ pageid: id, revid, title })
        if (pages.length % 50 === 0) console.log(`${pages.length} pages picked`)
      }
    }
    writeFileSync(MANIFEST, `${JSON.stringify({ source: 'zh.wikipedia.org, CC BY-SA 4.0', fetched: new Date().toISOString().slice(0, 10), minChars: MIN_CHARS, pages }, null, 1)}\n`)
  }
  let moved = 0
  for (const variant of VARIANTS) {
    const texts = []
    for (const page of pages) {
      const { revid, text } = await extract(page.pageid, variant)
      if (revid !== page.revid) moved += 1
      texts.push(text)
    }
    writeFileSync(join(CORPUS, `${variant}.json`), JSON.stringify(texts))
  }
  console.log(`${pages.length} pages in ${VARIANTS.join(', ')}; ${moved} page fetches had a revision other than the manifest's`)
}

async function measure() {
  const { RulesDetector, emptyRedactionIndex, mask, restore } = await import('../lib/core/index.js')
  const { PROXY_DEFAULT_RULES } = await import('../lib/proxy/config.js')
  const ruleSets = { core: new RulesDetector({}), proxy: new RulesDetector({ rules: [...PROXY_DEFAULT_RULES] }) }
  const results = { manifest: 'bench/zh-prose-manifest.json', variants: {} }
  for (const variant of VARIANTS) {
    const file = join(CORPUS, `${variant}.json`)
    if (!existsSync(file)) throw new Error(`no ${file}: run \`node bench/zh-prose.mjs fetch --manifest\` first`)
    const texts = JSON.parse(readFileSync(file, 'utf8'))
    const chars = texts.reduce((sum, text) => sum + [...text].length, 0)
    const lines = texts.reduce((sum, text) => sum + text.split('\n').filter(line => line.trim() !== '').length, 0)
    const entry = { articles: texts.length, chars, lines, rules: {} }
    for (const [name, detector] of Object.entries(ruleSets)) {
      const counts = {}
      const rows = []
      let restoreFailures = 0
      for (const [index, text] of texts.entries()) {
        const result = await mask(detector, [{ seq: 1, path: '', text }], emptyRedactionIndex())
        const back = restore(result.masked[0], result.registry)
        if (!back.ok || back.text !== text) restoreFailures += 1
        for (const span of result.applied) {
          const category = span.id.slice(0, span.id.lastIndexOf('_'))
          counts[category] = (counts[category] ?? 0) + 1
          const around = s => s.replaceAll(/\s/g, ' ')
          rows.push([variant, index, category, around(text.slice(span.start, span.end)), around(text.slice(Math.max(0, span.start - 20), span.start)), around(text.slice(span.end, span.end + 20))].join('\t'))
        }
      }
      writeFileSync(join(CORPUS, `spans-${variant}-${name}.tsv`), `variant\tarticle\tcategory\tspan\tbefore\tafter\n${rows.join('\n')}\n`)
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      entry.rules[name] = { detector: detector.detectorVersion, spans: total, per1kChars: +(total / chars * 1000).toFixed(3), per1kLines: +(total / lines * 1000).toFixed(2), byCategory: counts, restoreFailures }
      console.log(`${variant} ${name} (${detector.detectorVersion}): ${texts.length} articles, ${chars} chars, ${lines} lines; ${total} spans = ${entry.rules[name].per1kChars} per 1k chars, ${entry.rules[name].per1kLines} per 1k lines; ${JSON.stringify(counts)}; restore failures ${restoreFailures}`)
    }
    results.variants[variant] = entry
  }
  writeFileSync(join(ROOT, 'bench', 'results', 'zh-prose.json'), `${JSON.stringify(results, null, 2)}\n`)
}

const [command, ...args] = process.argv.slice(2)
if (command === 'fetch') await fetchCorpus(args)
else await measure()
