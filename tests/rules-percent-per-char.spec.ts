// Percent decoding one UTF-8 sequence at a time (WO-9): an invalid or truncated
// escape no longer stops the rest of its run from decoding, and the decoded text
// is folded through NFKC with invisible characters removed. Every value is invented.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'
import { RulesDetector } from '../src/core/rules/index.ts'
import { composeProjections, projectNfkc, projectPercent } from '../src/core/rules/normalize.ts'

const config = { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] }
const service = new RulesRedactionService(new Context(), config)
const TERM = '%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB'

async function roundTrip(text: string): Promise<{ masked: string; restored: string | false }> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  const masked = result.masked[0] ?? ''
  const back = service.restore(masked, result.registry)
  return { masked, restored: back.ok && back.text }
}

describe('per-character percent decoding', () => {
  it.each([
    // A truncated trailing escape after an encoded term.
    [`https://search.example.org/?q=${TERM}%E6`, 'https://search.example.org/?q=⟦TERM_1⟧%E6'],
    [`https://search.example.org/?q=${TERM}%E6%98`, 'https://search.example.org/?q=⟦TERM_1⟧%E6%98'],
    // A stray byte between two encoded CJK characters, on either side of the term.
    [`?q=${TERM}%FF%E5%A0%B1%E5%91%8A`, '?q=⟦TERM_1⟧%FF%E5%A0%B1%E5%91%8A'],
    [`?q=%E5%A0%B1%FF${TERM}`, '?q=%E5%A0%B1%FF⟦TERM_1⟧'],
    // An invalid continuation byte in the middle of an email, in the run that holds `%40`.
    ['mailto:lin.yating%E6%40example.com', 'mailto:⟦EMAIL_1⟧'],
    // An encoded zero-width space inside an email.
    ['mailto:lin%E2%80%8B.yating%40example.com', 'mailto:⟦EMAIL_1⟧'],
    // Encoded full-width digits forming a national identification number.
    ['?id=A%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96%EF%BC%97%EF%BC%98%EF%BC%99', '?id=⟦TWID_1⟧'],
    // An encoded soft hyphen inside a term.
    ['?q=%E6%98%9F%C2%AD%E6%B2%B3%E8%A8%88%E7%95%AB', '?q=⟦TERM_1⟧'],
  ])('masks %j and restores it byte for byte', async (text, expected) => {
    const { masked, restored } = await roundTrip(text)
    expect(masked).toBe(expected)
    expect(restored).toBe(text)
  })

  it('still masks an encoded zero-width joiner inside a project name beside a stray byte', async () => {
    // Configured literals already fold their own decoded text, so this holds on rules-4 too.
    const text = '/open?doc=NIMBUS%e2%80%8d%2D7&x=%fe'
    const { masked, restored } = await roundTrip(text)
    expect(masked).toBe('/open?doc=⟦PROJECT_1⟧&x=%fe')
    expect(restored).toBe(text)
  })

  it('removes a literal soft hyphen inside a term', async () => {
    const text = '星\u00AD河計畫'
    const { masked, restored } = await roundTrip(text)
    expect(masked).toBe('⟦TERM_1⟧')
    expect(restored).toBe(text)
  })

  it.each([
    'https://example.org/?q=%FF%FE',
    'progress 100% done',
    'today 50%off everything',
    'https://example.org/search?q=hello%20world%20again',
    'https://example.org/a%20b/c%20d.html',
    'https://example.org/search?q=%E5%8F%B0%E5%8C%97%FF',
    'https://example.org/search?q=%E5%8F%B0%E5%8C%97%E5',
    'https://example.org/search?q=hello%FFworld',
    `https://example.org/search?q=%E6%98%9F%E6%B2%B3%FF%E8%A8%88%E7%AE%97`,
    'https://example.org/?utm_source=news%3Dletter&utm_medium=email%26x%FF&ref=%2Fpricing',
    'https://www.example-analytics.com/collect?v=2&tid=G-ABCDEF&dl=https%3A%2F%2Fexample.org%2Fpricing%3Fref%3Dnav&dt=Pricing%20%7C%20Example&ul=zh-tw&sr=1512x982',
    'https://example.org/?q=%C0%AF%E0%80%AF%ED%A0%80',
  ])('keeps %j', async (text) => {
    expect((await roundTrip(text)).masked).toBe(text)
  })
})

describe('per-character projection offsets', () => {
  it('copies an invalid escape 1:1 and decodes the rest of its run', () => {
    const projection = projectPercent('%FF%E6%98%9F%E6')
    expect(projection?.norm).toBe('%FF星%E6')
    expect(projection?.startMap).toEqual([0, 1, 2, 3, 12, 13, 14])
    expect(projection?.endMap).toEqual([1, 2, 3, 12, 13, 14, 15])
  })

  it('rejects overlong forms and surrogates one escape at a time', () => {
    expect(projectPercent('%C0%AF%ED%A0%80%F5%80')).toBeUndefined()
    expect(projectPercent('%C0%AF%41')?.norm).toBe('%C0%AFA')
  })

  it('composes the NFKC projection of the decoded text back to the encoded source', () => {
    const percent = projectPercent('a%E2%80%8B%EF%BC%91')
    expect(percent).toBeDefined()
    if (percent === undefined) return
    const composed = composeProjections(percent, projectNfkc(percent.norm))
    expect(composed.norm).toBe('a1')
    expect(composed.startMap).toEqual([0, 10])
    expect(composed.endMap).toEqual([10, 19])
  })
})

describe('fuzz: mixed valid escapes, invalid bytes, literals, and invisible characters', () => {
  // Seeded so a failure reproduces.
  let seed = 0x9e3779b9
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const hexCase = (s: string): string => (random() < 0.5 ? s.toLowerCase() : s.toUpperCase())
  const encode = (s: string): string =>
    [...new TextEncoder().encode(s)].map(b => hexCase(`%${b.toString(16).padStart(2, '0')}`)).join('')
  const pieces: readonly (() => string)[] = [
    () => encode(pick(['星', '河', '計', '畫', '星河計畫', '台北', 'a', '@', '/', '.', '１', '＠', '\u200b', '\u00AD', '\ufeff', '𠮷', 'lin.yating@example.com', 'A123456789'])),
    () => hexCase(pick(['%FF', '%FE', '%80', '%BF', '%C0', '%C1', '%E6', '%E6%98', '%F0%9F', '%F5', '%ED%A0%80', '%C2'])),
    () => pick(['lin', '.yating', '@example.com', '?q=', '&x=', '/', ' ', '100%', '%', '%2', '%zz', '星河', '計畫', 'NIMBUS', '-7', '0912', '345678', 'A12345']),
    () => pick(['\u200b', '\u200d', '\u00AD', '\ufeff']),
    () => pick(['https://example.org/search', 'curl -s ', 'mailto:', 'tel:', ' GET ', '，']),
  ]
  const detector = new RulesDetector(config)

  it('never throws and masks only whole escapes, restoring byte for byte', async () => {
    let checked = 0
    let maskedTexts = 0
    for (let n = 0; n < 10_000; n += 1) {
      let text = ''
      const count = 1 + Math.floor(random() * 12)
      for (let k = 0; k < count; k += 1) text += pick(pieces)()
      const detections = detector.detect(text)
      const projection = projectPercent(text)
      // An offset strictly inside an escape group that decoded is never a detection edge;
      // an escape copied as written maps 1:1 like any literal text.
      const inside = new Set<number>()
      if (projection !== undefined) {
        const composed = composeProjections(projection, projectNfkc(projection.norm))
        for (const map of [projection, composed]) {
          for (let i = 0; i < map.norm.length; i += 1) {
            // oxlint-disable-next-line typescript/no-non-null-assertion -- `i` is inside the projection.
            expect(map.startMap[i]!).toBeLessThan(map.endMap[i]!)
            if (i > 0) expect(map.startMap[i]!).toBeGreaterThanOrEqual(map.startMap[i - 1]!)
          }
        }
        for (let i = 0; i < projection.norm.length; i += 1) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- `i` is inside the projection.
          const start = projection.startMap[i]!
          // oxlint-disable-next-line typescript/no-non-null-assertion -- `i` is inside the projection.
          const end = projection.endMap[i]!
          for (let k = start + 1; k < end; k += 1) inside.add(k)
          // Each decoded character decodes back from its source range.
          const source = text.slice(start, end)
          expect((projectPercent(source)?.norm ?? source).includes(projection.norm.charAt(i))).toBe(true)
        }
      }
      for (const { start, end } of detections) {
        expect(start).toBeLessThan(end)
        expect(inside.has(start) || inside.has(end), `${JSON.stringify(text)} [${String(start)}, ${String(end)})`).toBe(false)
      }
      const { masked, restored } = await roundTrip(text)
      expect(restored).toBe(text)
      if (detections.length > 0) {
        expect(masked).not.toBe(text)
        maskedTexts += 1
      }
      checked += 1
    }
    expect(checked).toBe(10_000)
    // The generator reaches the rules: a large share of the inputs mask something.
    expect(maskedTexts).toBeGreaterThan(1_000)
  }, 60_000)
})
