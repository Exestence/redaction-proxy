import { describe, expect, it } from 'vitest'
import { Context } from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'
import RulesRedactionService from './shim.ts'
import { SessionSeq } from './shim.ts'

// Fictional terms; `café` and `株式会社` carry the decomposition and the
// compatibility-ideograph cases.
const TERMS = ['機密專案', 'Nimbus', 'café', '株式会社', 'İstanbul', '〇']
const service = new RulesRedactionService(new Context(), { terms: TERMS })

async function maskOne(text: string): Promise<{ masked: string; restored: string; spans: number }> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  const masked = result.masked[0] ?? ''
  const back = service.restore(masked, result.registry)
  return { masked, restored: back.ok ? back.text : '', spans: result.applied.length }
}

/** Deterministic linear congruential generator, so a failing round is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

describe('Unicode normalization', () => {
  it.each([
    ['precomposed', 'café'],
    ['decomposed', 'cafe\u0301'],
    ['fullwidth latin', 'Ｎｉｍｂｕｓ'],
    ['fullwidth lowercase', 'ｎｉｍｂｕｓ'],
    ['zero width inside', '機\u200b密\u200d專案'],
    ['zero width in a decomposition', 'cafe\u200b\u0301'],
    ['compatibility ideograph', '株式会社'],
    ['a letter whose lower case is longer', 'İstanbul'],
    ['a character whose escape spelling has one case', '〇'],
    ['escaped lower', '\\u6a5f\\u5bc6\\u5c08\\u6848'],
    ['escaped upper', '\\u6A5F\\u5BC6\\u5C08\\u6848'],
  ])('matches a term written as %s and restores it byte for byte', async (_label, needle) => {
    const text = `before ${needle} after`
    const { masked, restored, spans } = await maskOne(text)
    expect(spans).toBe(1)
    expect(masked.startsWith('before ')).toBe(true)
    expect(masked.endsWith(' after')).toBe(true)
    expect(restored).toBe(text)
  })

  it('folds an astral combining mark onto its base character', async () => {
    const text = 'Nimbus A\u{1D165} tail'
    const { masked, restored } = await maskOne(text)
    expect(masked).toBe('⟦TERM_1⟧ A\u{1D165} tail')
    expect(restored).toBe(text)
  })

  it('maps a span back to the original offsets, not to the projection', async () => {
    const text = 'ｘ\u200bｘ機密專案ｙ'
    const result = await service.mask([{ seq: SessionSeq(1), path: '/a', text }], emptyRedactionIndex())
    const applied = result.applied[0]
    expect(applied).toBeDefined()
    expect(text.slice(applied?.start ?? 0, applied?.end ?? 0)).toBe('機密專案')
  })

  it.each([
    ['full-width telephone number', '聯絡 ０９１２３４５６７８', 'PHONE'],
    ['full-width address', 'ｍａｉｌ ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｔｅｓｔ', 'EMAIL'],
    ['full-width home path', 'ls /Ｕｓｅｒｓ/ａｌｉｃｅ', 'PATH'],
    ['full-width assignment', 'ｐａｓｓｗｏｒｄ＝hunter2', 'KEY'],
    ['zero width inside an address', 'ali\u200bce@example.test', 'EMAIL'],
  ])('runs the built-in rules over the projection for a %s', async (_label, text, category) => {
    const { masked, restored } = await maskOne(text)
    expect(masked).toContain(`⟦${category}_`)
    expect(restored).toBe(text)
  })

  it('matches a decorated term in two thousand seeded rounds', async () => {
    const random = rng(20260916)
    const zeroWidth = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff']
    // No ASCII letter, digit, or full-width Latin letter: beside a Latin term edge those cut a longer word.
    const filler = ['中', ' ', '。', '-', '，', '　']
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
    let matched = 0
    let restoredAll = 0
    for (let round = 0; round < 2_000; round += 1) {
      const term = pick(TERMS)
      let needle = ''
      for (const char of term) {
        needle += random() < 0.35 ? pick(zeroWidth) : ''
        needle += random() < 0.3 ? char.normalize('NFD') : char
      }
      let prefix = ''
      let suffix = ''
      for (let i = 0; i < Math.floor(random() * 4); i += 1) prefix += pick(filler)
      for (let i = 0; i < Math.floor(random() * 4); i += 1) suffix += pick(filler)
      const text = prefix + needle + suffix
      const { restored, spans } = await maskOne(text)
      if (spans > 0) matched += 1
      if (restored === text) restoredAll += 1
    }
    expect(matched).toBe(2_000)
    expect(restoredAll).toBe(2_000)
  })
})
