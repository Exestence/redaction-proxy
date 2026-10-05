import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isTaiwanNationalId } from '../src/core/index.ts'
import { buildDataset, fillTemplate } from '../bench/public/dataset.ts'
import type { Sample } from '../bench/public/dataset.ts'
import { categoriesInReportOrder, loadHeldOutSet, parseRecord } from '../bench/public/heldout.ts'
import { classify, isCovered, mergeOverlapping, percentile, scoreSystem } from '../bench/public/metrics.ts'
import { renderMarkdown } from '../bench/public/report.ts'
import { createRandom } from '../bench/public/random.ts'
import type { SystemRun } from '../bench/public/systems.ts'
import { luhnCheckDigit, myNumberCheckDigit, nationalId, prcCheckCharacter } from '../bench/public/values.ts'

describe('dataset', () => {
  const samples = buildDataset({ seed: 7, samplesPerCell: 3 })

  it('is the same for the same seed and differs for another', () => {
    expect(buildDataset({ seed: 7, samplesPerCell: 3 })).toEqual(samples)
    expect(buildDataset({ seed: 8, samplesPerCell: 3 })).not.toEqual(samples)
  })

  it('covers every language and format pair', () => {
    expect(new Set(samples.map(sample => `${sample.language}/${sample.format}`)).size).toBe(24)
  })

  it('fills every slot and labels exactly the generated values', () => {
    for (const sample of samples) {
      expect(sample.text).not.toMatch(/\{\w+\}/)
      for (const span of [...sample.gold, ...sample.negatives]) {
        expect(span.end).toBeGreaterThan(span.start)
        expect(sample.text.slice(span.start, span.end).trim()).toBe(sample.text.slice(span.start, span.end))
      }
    }
  })

  it('records slot offsets in UTF-16 code units', () => {
    const filled = fillTemplate('寄給 {email}，謝謝', createRandom(1), 'zh-TW')
    const [gold] = filled.gold
    expect(filled.text.slice(gold?.start, gold?.end)).toMatch(/^[\w.]+@[\w.]+$/)
  })

  it('rejects a template slot it does not define', () => {
    expect(() => fillTemplate('{nope}', createRandom(1), 'en')).toThrow('{nope}')
  })
})

describe('check digits', () => {
  it('generates Taiwan national IDs the rules accept', () => {
    const random = createRandom(3)
    for (let i = 0; i < 200; i += 1) expect(isTaiwanNationalId(nationalId(random, 'zh-TW'))).toBe(true)
  })

  it('matches published examples', () => {
    expect(luhnCheckDigit('411111111111111')).toBe(1)
    expect(prcCheckCharacter('11010519491231002')).toBe('X')
    expect(myNumberCheckDigit('12345678901')).toBe(8)
  })
})

describe('metrics', () => {
  it('counts a span as covered only when detections leave no gap', () => {
    expect(isCovered({ start: 2, end: 8 }, [{ start: 5, end: 8 }, { start: 0, end: 5 }])).toBe(true)
    expect(isCovered({ start: 2, end: 8 }, [{ start: 0, end: 4 }, { start: 5, end: 8 }])).toBe(false)
  })

  it('merges overlapping detections into one region', () => {
    expect(mergeOverlapping([{ start: 4, end: 9 }, { start: 0, end: 5 }, { start: 9, end: 12 }]))
      .toEqual([{ start: 0, end: 9 }, { start: 9, end: 12 }])
  })

  it('takes the nearest-rank percentile', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3)
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5)
    expect(percentile([], 50)).toBe(0)
  })

  it('classifies a value as fully masked, partly masked, or untouched', () => {
    const value = { start: 10, end: 20 }
    expect(classify(value, [{ start: 8, end: 15 }, { start: 15, end: 22 }])).toBe('fullyMasked')
    expect(classify(value, [{ start: 18, end: 25 }])).toBe('partlyMasked')
    expect(classify(value, [{ start: 0, end: 10 }, { start: 20, end: 30 }])).toBe('untouched')
  })

  it('scores mask outcomes, core coverage, macro average, precision, and hard-negative hits', () => {
    const sample: Sample = {
      id: 'one',
      language: 'en',
      format: 'chat',
      text: 'mail a@b.example.com or +1 555 0101 about v1.2.3',
      gold: [
        { start: 5, end: 20, category: 'EMAIL' },
        { start: 24, end: 35, category: 'PHONE', core: { start: 27, end: 35 } },
      ],
      negatives: [{ start: 42, end: 48, kind: 'version' }],
    }
    const run: SystemRun = {
      name: 'stub',
      outcomes: new Map([['one', { detected: [{ start: 5, end: 20 }, { start: 27, end: 35 }, { start: 42, end: 48 }], milliseconds: 1 }]]),
    }
    const report = scoreSystem(run, [sample], ['EMAIL', 'PHONE'])
    expect(report.byCategory.EMAIL?.outcomes.fullyMasked).toEqual({ hits: 1, total: 1 })
    expect(report.byCategory.PHONE?.outcomes.partlyMasked).toEqual({ hits: 1, total: 1 })
    expect(report.byCategory.PHONE?.coreFullyMasked).toEqual({ hits: 1, total: 1 })
    expect(report.byCategory.EMAIL?.coreFullyMasked.total).toBe(0)
    expect(report.macroAverage).toEqual({ categories: 2, outcomes: { fullyMasked: 0.5, partlyMasked: 0.5, untouched: 0 } })
    expect(report.overall.regionPrecision).toEqual({ hits: 2, total: 3 })
    expect(report.overall.restoreExact).toBeUndefined()
    expect(report.negativeHits).toEqual({ version: { hits: 1, total: 1 } })
  })
})

describe('dev set core spans', () => {
  it('marks the identifying part of phones, home paths, and internal hosts', () => {
    const filled = fillTemplate('{phone} {homePath} {internalHost} {email}', createRandom(2), 'en')
    const cores = filled.gold.map(gold => gold.core === undefined ? undefined : filled.text.slice(gold.core.start, gold.core.end))
    expect(cores[0]).toMatch(/^\(\d{3}\) 555-01\d{2}$/)
    expect(cores[1]).not.toContain('/')
    expect(cores[2]).not.toContain('.')
    expect(cores[3]).toBeUndefined()
  })
})

describe('held-out set', () => {
  const text = 'call +1 415 555 0134 about 0f9e'
  const record = {
    id: 'h1',
    lang: 'en',
    format: 'chat',
    text,
    spans: [{ start: 5, end: 20, category: 'PHONE', value: '+1 415 555 0134', core: '415 555 0134' }],
    negatives: [{ start: 27, end: 31, kind: 'commit-hash', value: '0f9e' }],
  }

  const directories: string[] = []
  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  })

  function writeSet(lines: readonly object[], manifestHash?: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'heldout-spec-'))
    directories.push(directory)
    const contents = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
    const hash = manifestHash ?? createHash('sha256').update(contents).digest('hex')
    writeFileSync(join(directory, 'set.jsonl'), contents)
    writeFileSync(join(directory, 'MANIFEST'), `${hash}  set.jsonl\n`)
    return join(directory, 'set.jsonl')
  }

  it('loads records whose hash matches the MANIFEST', () => {
    const loaded = loadHeldOutSet(writeSet([record]))
    expect(loaded.fileName).toBe('set.jsonl')
    expect(loaded.samples).toEqual([{
      id: 'h1',
      language: 'en',
      format: 'chat',
      text,
      gold: [{ start: 5, end: 20, category: 'PHONE', core: { start: 8, end: 20 } }],
      negatives: [{ start: 27, end: 31, kind: 'commit-hash' }],
    }])
  })

  it('rejects a file whose hash differs from the MANIFEST', () => {
    expect(() => loadHeldOutSet(writeSet([record], '0'.repeat(64)))).toThrow('MANIFEST records')
  })

  it('accepts a core given as absolute offsets inside the span', () => {
    const sample = parseRecord(JSON.stringify({ ...record, spans: [{ ...record.spans[0], core: { start: 8, end: 20 } }] }), 'x')
    expect(sample.gold[0]?.core).toEqual({ start: 8, end: 20 })
  })

  it('rejects offsets that do not hold the value, an empty category, and a core outside the span', () => {
    const span = record.spans[0]
    const withSpan = (changes: object): string => JSON.stringify({ ...record, spans: [{ ...span, ...changes }] })
    expect(() => parseRecord(withSpan({ start: 4 }), 'x')).toThrow('not the value')
    expect(() => parseRecord(withSpan({ category: '' }), 'x')).toThrow('must not be empty')
    expect(() => parseRecord(withSpan({ core: { start: 0, end: 4 } }), 'x')).toThrow('inside the span')
    expect(() => parseRecord(withSpan({ core: '5' }), 'x')).toThrow('exactly once')
  })

  // After the emoji, UTF-16 offsets run one ahead of code-point offsets.
  const astralText = '😀 Ana Lin, ana@corp.test, build 0f9e'
  const astralRecord = {
    id: 'h2',
    lang: 'en',
    format: 'chat',
    text: astralText,
    spans: [
      { start: 3, end: 10, start_cp: 2, end_cp: 9, category: 'PERSON', value: 'Ana Lin' },
      { start: 12, end: 25, start_cp: 11, end_cp: 24, category: 'EMAIL', value: 'ana@corp.test', core: { start: 12, end: 15, start_cp: 11, end_cp: 14 } },
    ],
    negatives: [{ start: 33, end: 37, start_cp: 32, end_cp: 36, category: 'commit_hash', value: '0f9e' }],
  }

  it('loads categories the dev set does not have and free-form negative labels', () => {
    const sample = parseRecord(JSON.stringify(astralRecord), 'x')
    expect(sample.gold).toEqual([
      { start: 3, end: 10, category: 'PERSON' },
      { start: 12, end: 25, category: 'EMAIL', core: { start: 12, end: 15 } },
    ])
    expect(sample.negatives).toEqual([{ start: 33, end: 37, kind: 'commit_hash' }])
  })

  it('rejects code-point offsets that disagree with the UTF-16 offsets', () => {
    const [person, email] = astralRecord.spans
    const withSpans = (spans: readonly object[]): string => JSON.stringify({ ...astralRecord, spans })
    expect(() => parseRecord(withSpans([{ ...person, start_cp: 3, end_cp: 10 }]), 'x')).toThrow('expected 2..9')
    expect(() => parseRecord(withSpans([{ ...email, core: { ...email?.core, end_cp: 15 } }]), 'x')).toThrow('core code-point offsets')
  })

  it('orders the categories it finds by report order, then unlisted ones by first appearance', () => {
    const withCategories = (...categories: string[]): Sample => ({
      id: '', language: 'en', format: 'chat', text: '', negatives: [],
      gold: categories.map(category => ({ start: 0, end: 1, category })),
    })
    expect(categoriesInReportOrder([withCategories('HOST', 'ZODIAC', 'PERSON'), withCategories('IBAN', 'AGE')]))
      .toEqual(['PERSON', 'IBAN', 'HOST', 'ZODIAC', 'AGE'])
  })

  it('reports by the categories it was scored on', () => {
    const sample = parseRecord(JSON.stringify(astralRecord), 'x')
    const run: SystemRun = { name: 'stub', outcomes: new Map([['h2', { detected: [{ start: 12, end: 25 }], milliseconds: 1 }]]) }
    const report = scoreSystem(run, [sample], ['PERSON', 'EMAIL', 'IBAN'])
    const markdown = renderMarkdown({
      set: 'held-out', source: 'fixture', reproduce: 'n/a', sampleCount: 1, goldCount: 2, negativeCount: 1,
      detectorVersion: 'test', editsAfterResults: [], english: [report], allLanguages: [report], skipped: [],
    })
    expect(markdown).toContain('| PERSON | 0.0% / 0.0% / 100.0% |\n| EMAIL | 100.0% / 0.0% / 0.0% |\n| IBAN | — / — / — |')
    expect(markdown).toContain('| commit_hash | 0.0% |')
    expect(markdown).not.toContain('HOME_PATH')
  })
})
