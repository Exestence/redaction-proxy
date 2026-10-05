import { describe, expect, it } from 'vitest'
import { isTaiwanNationalId } from '../src/core/index.ts'
import { buildDataset, fillTemplate } from '../bench/public/dataset.ts'
import type { Sample } from '../bench/public/dataset.ts'
import { isCovered, mergeOverlapping, percentile, scoreSystem } from '../bench/public/metrics.ts'
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

  it('scores recall, leak, precision, and hard-negative hits', () => {
    const sample: Sample = {
      id: 'one',
      language: 'en',
      format: 'chat',
      text: 'mail a@b.example.com or 555 about v1.2.3',
      gold: [{ start: 5, end: 20, category: 'EMAIL' }, { start: 24, end: 27, category: 'PHONE' }],
      negatives: [{ start: 34, end: 40, kind: 'version' }],
    }
    const run: SystemRun = {
      name: 'stub',
      outcomes: new Map([['one', {
        detected: [{ start: 5, end: 20 }, { start: 34, end: 40 }],
        masked: 'mail ⟦EMAIL_1⟧ or 555 about ⟦KEY_1⟧',
        milliseconds: 1,
      }]]),
    }
    const report = scoreSystem(run, [sample])
    expect(report.overall.recall).toEqual({ hits: 1, total: 2 })
    expect(report.overall.leak).toEqual({ hits: 1, total: 2 })
    expect(report.overall.precision).toEqual({ hits: 1, total: 2 })
    expect(report.overall.restoreExact).toBeUndefined()
    expect(report.byCategory.EMAIL.recall).toEqual({ hits: 1, total: 1 })
    expect(report.byCategory.PHONE.leak).toEqual({ hits: 1, total: 1 })
    expect(report.negativeHits.version).toEqual({ hits: 1, total: 1 })
  })
})
