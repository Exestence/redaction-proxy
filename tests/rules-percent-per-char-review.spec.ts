// Unseen negatives for per-character decoding and the soft hyphen,
// mixed and adjacent spellings, and a second seeded fuzz that checks each
// projected span against its source range. Every value is invented.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { RedactionError, emptyRedactionIndex } from '../src/core/index.ts'
import { RulesDetector } from '../src/core/rules/index.ts'
import type { OffsetProjection } from '../src/core/rules/normalize.ts'
import { composeProjections, projectNfkc, projectPercent } from '../src/core/rules/normalize.ts'

const config = { terms: ['星河計畫', '林雅婷'], projectNames: ['NIMBUS-7'] }
const service = new RulesRedactionService(new Context(), config)

async function roundTrip(texts: readonly string[]): Promise<{ masked: string[]; restored: (string | false)[]; respelled: string[] }> {
  const result = await service.mask(
    texts.map((text, i) => ({ seq: SessionSeq(1), path: `/content/${String(i)}/text`, text })),
    emptyRedactionIndex(),
  )
  const restored = result.masked.map(masked => {
    const back = service.restore(masked, result.registry)
    return back.ok && back.text
  })
  // A configured term or project name restores its first spelling at every position
  // (README "One placeholder per term"); every other value restores as written.
  const respelled: string[] = []
  for (const span of result.applied) {
    const written = texts[Number(span.path.split('/')[2])]?.slice(span.start, span.end)
    if (written !== result.registry.original(span.id)) respelled.push(`${String(span.id)} ${JSON.stringify(written)}`)
  }
  return { masked: [...result.masked], restored, respelled }
}

describe('unseen negatives: soft hyphens, stray bytes, and analytics', () => {
  it.each([
    // Soft hyphens in ordinary prose and code are removed on the NFKC pass; the joined words stay public.
    'Die Donau­dampf­schiff­fahrts­gesell­schaft fährt täglich ab Wien.',
    'The in­ter­na­tion­al­i­za­tion work­flow is doc­u­ment­ed in the hand­book.',
    'function format­Currency(amount) { return amount.toFixed(2) } // re­try after 30 s',
    'ISBN 978­3­16­148410­0, Seite 12­34',
    '星­河­計­算是天文學的一個分支。',
    // Encoded soft hyphens in public page addresses.
    'https://de.wikipedia.org/wiki/Donau%C2%ADdampf%C2%ADschiff%C2%ADfahrt',
    'https://example.org/articles/in%C2%ADter%C2%ADna%C2%ADtion%C2%ADal?ref=feed&page=2',
    // Byte-order-mark runs and UTF-16 bytes.
    'https://example.org/upload?name=%FF%FEr%00e%00p%00o%00r%00t%00.txt',
    'https://example.org/import?csv=%EF%BB%BFid%2Cname%2Camount%0A1%2Cwidget%2C42',
    'https://example.org/?bom=%FE%FF%00h%00i',
    // Analytics query strings with encoded page addresses and titles.
    'https://www.google-analytics.com/g/collect?v=2&tid=G-X1Y2Z3W4V5&gtm=45je4a20v9&_p=1728100000123&ul=de-de&sr=1920x1080&en=page_view&dl=https%3A%2F%2Fexample.de%2Fwissen%2FDonau%C2%ADdampf&dt=Wissen%20%E2%80%93%20Example%FF',
    'https://example.org/pixel.gif?e=click&url=https%3A%2F%2Fshop.example.com%2Fcart%3Fitem%3D42%26qty%3D1&ref=%E6&lang=zh-TW',
    // Public CJK with stray or truncated bytes.
    'https://zh.wikipedia.org/wiki/%E5%8F%B0%E7%81%A3%E9%90%B5%E8%B7%AF%E7%AE%A1%E7%90%86%E5%B1%80%E7',
    'https://www.google.com/search?q=%E5%A4%A9%E6%B0%A3%FF%E9%A0%90%E5%A0%B1+%E5%8F%B0%E5%8D%97&hl=zh-TW',
    'https://example.com.tw/search?kw=%A5%78%A5%5F&enc=big5',
    // Percent-encoded binary and the classic overlong path-traversal strings.
    'data:image/png,%89PNG%0D%0A%1A%0A%00%00%00%0DIHDR%00%00%00%10%00%00%00%10%08%06%00%00%00%1F%F3%FFa',
    'GET /scripts/..%c0%af../winnt/system32/cmd.exe?/c+dir HTTP/1.0 and /..%e0%80%af../etc/hosts',
  ])('keeps %j', async (text) => {
    const { masked, restored } = await roundTrip([text])
    expect(masked[0]).toBe(text)
    expect(restored[0]).toBe(text)
  })
})

describe('mixed and adjacent spellings', () => {
  it('masks a term spelled half literal, half encoded', async () => {
    const text = '?q=星%E6%B2%B3計%E7%95%AB'
    const { masked, restored } = await roundTrip([text])
    expect(masked[0]).toBe('?q=⟦TERM_1⟧')
    expect(restored[0]).toBe(text)
  })

  it('masks adjacent encoded values with stray bytes between them and restores each text', async () => {
    const texts = [
      'lin.yating%40example.com%FF%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB%E6%9E%97%E9%9B%85%E5%A9%B7%E6',
      '星河計畫 and lin.yating@example.com',
    ]
    const { masked, restored } = await roundTrip(texts)
    expect(masked[0]).not.toContain('example.com')
    expect(masked[0]).not.toContain('%E6%98%9F')
    expect(masked[0]).not.toContain('%E6%9E%97')
    expect(masked[1]).toMatch(/^⟦TERM_\d+⟧ and ⟦EMAIL_\d+⟧$/)
    expect(restored).toEqual(texts)
  })
})

describe('fuzz (second seed): projected spans decode from their source ranges', () => {
  let seed = 0x2545f491
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
  // Encode some characters of a value and keep the rest literal.
  const mixed = (s: string): string => [...s].map(c => (random() < 0.5 ? encode(c) : c)).join('')
  const values = ['星河計畫', '林雅婷', 'NIMBUS-7', 'lin.yating@example.com', 'A123456789', '0912345678', '+886912345678', '台北', 'hello']
  const pieces: readonly (() => string)[] = [
    () => encode(pick(values)),
    () => mixed(pick(values)),
    () => pick(values),
    () => encode(pick(['﻿', '­', '​', '⁠', '１', '＠', 'Ａ', '𠮷', '😀', 'é', 'é', '�'])),
    // Overlong forms, surrogates, out-of-range leads, lone continuations, truncations.
    () => hexCase(pick(['%C0%80', '%C1%BF', '%E0%80%AF', '%F0%80%80%AF', '%ED%A0%80', '%ED%BF%BF', '%F4%90%80%80', '%F5%80%80%80', '%80', '%BF', '%FF%FE', '%FE%FF', '%EF%BB%BF', '%E6', '%E6%98', '%F0%9F%98', '%C2'])),
    () => hexCase(pick(['%00', '%0A', '%09', '%7F', '%C2%85', '%25', '%2540', '%20', '%2B'])),
    () => pick(['﻿', '­', '​', '‍', ' ', '/', '?q=', '&', '=', '%', '%2', '%G0', '100%', 'mailto:', '，', '\n']),
  ]
  const detector = new RulesDetector(config)

  type Projector = (s: string) => OffsetProjection | undefined
  const percentNfkc: Projector = s => {
    const p = projectPercent(s)
    return p === undefined ? undefined : composeProjections(p, projectNfkc(p.norm))
  }
  // Each projection, paired with how it reads a source slice on its own.
  const projectors: readonly [Projector, (s: string) => string][] = [
    [projectNfkc, s => projectNfkc(s).norm],
    [projectPercent, s => projectPercent(s)?.norm ?? s],
    [percentNfkc, s => projectNfkc(projectPercent(s)?.norm ?? s).norm],
  ]

  it('never throws unexpectedly, maps every span to whole source groups, and restores byte for byte', async () => {
    let maskedTexts = 0
    let spans = 0
    let refused = 0
    const uncovered: string[] = []
    let respelledTexts = 0
    for (let n = 0; n < 10_000; n += 1) {
      const count = 1 + Math.floor(random() * 10)
      const texts = [0, 1].map(() => {
        let text = ''
        for (let k = 0; k < count; k += 1) text += pick(pieces)()
        return text
      })
      const text = texts[0] ?? ''
      let detections
      try {
        detections = detector.detect(text)
      } catch (error) {
        // Only a screened character in the submitted text may refuse it; none is generated.
        expect(error).toBeInstanceOf(RedactionError)
        refused += 1
        continue
      }
      // Every span a projection's own rules find maps to a source range whose
      // projection is that span, and the detections cover it.
      for (const [project, reread] of projectors) {
        const projection = project(text)
        // `detect` on a projection that still decodes would decode a second level (`%2540`).
        if (projection === undefined || projection.norm === text || projectPercent(projection.norm) !== undefined) continue
        let found
        try {
          found = detector.detect(projection.norm)
        } catch {
          // A decoded NUL, control, or replacement character refuses the projection on its own;
          // `detect` on the submitted text runs the rules on it without screening.
          continue
        }
        for (const span of found) {
          const start = projection.startMap[span.start] ?? -1
          const end = projection.endMap[span.end - 1] ?? -1
          const source = text.slice(start, end)
          const again = reread(source)
          expect(again, `${JSON.stringify(text)} span ${JSON.stringify(projection.norm.slice(span.start, span.end))}`)
            .toBe(projection.norm.slice(span.start, span.end))
          spans += 1
          if (!detections.some(d => d.start <= start && end <= d.end)) uncovered.push(`${JSON.stringify(text)} ${JSON.stringify(source)}`)
        }
      }
      const { masked, restored, respelled } = await roundTrip(texts)
      if (respelled.length === 0) expect(restored).toEqual(texts)
      else {
        expect(respelled.filter(r => !/^(TERM|PROJECT)_\d+ /.test(r))).toEqual([])
        respelledTexts += 1
      }
      if (detections.length > 0) {
        expect(masked[0]).not.toBe(text)
        maskedTexts += 1
      }
    }
    expect(refused).toBe(0)
    process.stderr.write(`review fuzz: masked ${String(maskedTexts)}, spans ${String(spans)}, term respellings ${String(respelledTexts)}\n`)
    expect(uncovered.slice(0, 20)).toEqual([])
    expect(maskedTexts).toBeGreaterThan(3_000)
    expect(spans).toBeGreaterThan(3_000)
  }, 120_000)
})
