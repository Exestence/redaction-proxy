import { describe, expect, it } from 'vitest'
import { Context } from './shim.ts'
import { RedactionId, emptyRedactionIndex, foldRedactionScan } from '../src/core/index.ts'
import type { RedactionIndex, RedactionSpan } from '../src/core/index.ts'
import RulesRedactionService from './shim.ts'
import { SessionSeq } from './shim.ts'

// No built-in rule fires on any value below, so every span comes from the
// recorded index and every further occurrence comes from propagation.
const service = new RulesRedactionService(new Context())

function indexOf(spans: readonly RedactionSpan[]): RedactionIndex {
  return foldRedactionScan(emptyRedactionIndex(), {
    policyDigest: service.policyDigest,
    detectorVersion: service.detectorVersion,
    spans: [...spans],
    scanned: [],
    checkpointSpans: [],
    reserved: [],
  })
}

function span(seq: number, start: number, end: number, id: string): RedactionSpan {
  return { seq: SessionSeq(seq), path: '/content/0/text', start, end, id: RedactionId(id) }
}

async function maskSeeded(texts: readonly string[], spans: readonly RedactionSpan[]): Promise<string[]> {
  const submitted = texts.map((text, at) => ({ seq: SessionSeq(at + 1), path: '/content/0/text', text }))
  return (await service.mask(submitted, indexOf(spans))).masked
}

async function maskOne(text: string, start: number, end: number, id = 'TERM_1'): Promise<string> {
  return (await maskSeeded([text], [span(1, start, end, id)]))[0] ?? ''
}

describe('value propagation', () => {
  it.each([
    ['王的國王', 0, 1, '⟦TERM_1⟧的國王'],
    ['Li visits Library', 0, 2, '⟦TERM_1⟧ visits Library'],
    ['12345678 vs 123456789', 0, 8, '⟦TERM_1⟧ vs 123456789'],
    ['123456 vs 1234567890', 0, 6, '⟦TERM_1⟧ vs 1234567890'],
    ['abcdef and abcdef', 0, 6, '⟦TERM_1⟧ and ⟦TERM_1⟧'],
    ['abcde and abcde', 0, 5, '⟦TERM_1⟧ and abcde'],
    ['林小明 met 林小明', 0, 3, '⟦TERM_1⟧ met ⟦TERM_1⟧'],
  ])('holds the length threshold in %j', async (text, start, end, expected) => {
    expect(await maskOne(text, start, end)).toBe(expected)
  })

  it.each([
    ['secret1 xsecret1 secret1x -secret1-', 0, 7, '⟦TERM_1⟧ xsecret1 secret1x -⟦TERM_1⟧-'],
    ['SECRET1 vs secret1', 11, 18, 'SECRET1 vs ⟦TERM_1⟧'],
    ['prefix prefixed prefix', 0, 6, '⟦TERM_1⟧ prefixed ⟦TERM_1⟧'],
    ['\u{1F600}\u{1F601} and \u{1F600}\u{1F601}', 0, 4, '⟦TERM_1⟧ and ⟦TERM_1⟧'],
  ])('holds the edge guard in %j', async (text, start, end, expected) => {
    expect(await maskOne(text, start, end)).toBe(expected)
  })

  it('takes the longest indexed value at one position', async () => {
    // `alphabeta` inside `alphabetagamma` is glued to more letters, so the edge guard keeps it.
    const masked = await maskOne('alphabeta alphabetagamma alpha', 0, 9)
    expect(masked).toBe('⟦TERM_1⟧ alphabetagamma alpha')
    const both = await maskSeeded(
      ['alphabeta alphabetagamma alpha'],
      [span(1, 0, 9, 'TERM_1'), span(1, 10, 24, 'PROJECT_1')],
    )
    expect(both[0]).toBe('⟦TERM_1⟧ ⟦PROJECT_1⟧ alpha')
  })

  it.each([63, 64, 65, 200])('propagates a value of %i code units', async (length) => {
    const value = 'v'.repeat(length)
    expect(await maskOne(`${value} then ${value}`, 0, length)).toBe('⟦TERM_1⟧ then ⟦TERM_1⟧')
  })

  it('propagates across texts and into a location the detector did not rescan', async () => {
    const masked = await maskSeeded(
      ['value000001 here and value000001 again', 'and value000001 there'],
      [span(1, 0, 11, 'TERM_1')],
    )
    expect(masked).toEqual(['⟦TERM_1⟧ here and ⟦TERM_1⟧ again', 'and ⟦TERM_1⟧ there'])
  })

  it('records a propagated span so a later mask reuses it without the detector', async () => {
    const submitted = [
      { seq: SessionSeq(1), path: '/content/0/text', text: 'value000001 here and value000001 again' },
    ]
    const first = await service.mask(submitted, indexOf([span(1, 0, 11, 'TERM_1')]))
    expect(first.spans).toHaveLength(1)
    expect(first.spans[0]).toMatchObject({ start: 21, end: 32, id: 'TERM_1' })
    const folded = foldRedactionScan(indexOf([span(1, 0, 11, 'TERM_1')]), {
      policyDigest: service.policyDigest,
      detectorVersion: service.detectorVersion,
      spans: first.spans,
      scanned: first.scanned,
      checkpointSpans: [],
      reserved: first.reserved,
    })
    const second = await service.mask(submitted, folded)
    expect(second.masked[0]).toBe('⟦TERM_1⟧ here and ⟦TERM_1⟧ again')
    expect(second.spans).toHaveLength(0)
  })

  it('never propagates a value that is itself a credential word', async () => {
    const masked = await maskSeeded(['password: password, and password again'], [span(1, 10, 18, 'KEY_1')])
    expect(masked[0]).toBe('password: ⟦KEY_1⟧, and password again')
  })

  it('prefers the longer value when an indexed and a scanned value start together', async () => {
    const short = `-${'q'.repeat(62)}-`
    const long = `${short}${'z'.repeat(6)}`
    const masked = await maskSeeded(
      [short, long, `${long} end`],
      [span(1, 0, short.length, 'TERM_1'), span(2, 0, long.length, 'TERM_2')],
    )
    expect(masked[2]).toBe('⟦TERM_2⟧ end')
  })

  it('masks the union of two values that overlap at a non-alphanumeric edge', async () => {
    // Keeping only the first occurrence would send `-jkl-mno`, the tail of the
    // second value, verbatim.
    const service2 = new RulesRedactionService(new Context())
    const texts = ['password=abc-def-ghi', 'password=ghi-jkl-mno', 'log abc-def-ghi-jkl-mno end']
    const submitted = texts.map((text, at) => ({ seq: SessionSeq(at + 1), path: '/content/0/text', text }))
    const { masked } = await service2.mask(submitted, emptyRedactionIndex())
    // The union is a value of its own, so it takes its own identity.
    expect(masked[2]).toBe('log ⟦KEY_3⟧ end')
    for (const value of ['abc-def-ghi', 'ghi-jkl-mno', '-jkl-mno', 'abc-def-']) {
      expect(masked.join('\n')).not.toContain(value)
    }
  })

  it('leaves a shorter value when the longest match at that position is glued to more text', async () => {
    // The trie takes the longest match at a position and does not retry a
    // shorter one. `foobar-xyz` is followed by `q`, so its edge guard fails and
    // the `foobar` prefix is never reconsidered. An implementation that fell
    // back to the shorter value would mask it here.
    const masked = await maskSeeded(
      ['foobar and foobar-xyzq', 'foobar-xyz here'],
      [span(1, 0, 6, 'TERM_1'), span(2, 0, 10, 'TERM_2')],
    )
    expect(masked[0]).toBe('⟦TERM_1⟧ and foobar-xyzq')
  })

  it('masks the part of a propagated range that a detected span does not cover', async () => {
    // The union of the two credentials runs into the literal, so the union is
    // refused whole. Its uncovered part is still sensitive: dropping it sent
    // the first credential verbatim.
    const overlapping = new RulesRedactionService(new Context(), { terms: ['mno-zzz'] })
    const texts = ['password=abc-def-ghi', 'password=ghi-jkl-mno', 'log abc-def-ghi-jkl-mno-zzz end']
    const submitted = texts.map((text, at) => ({ seq: SessionSeq(at + 1), path: '/content/0/text', text }))
    const result = await overlapping.mask(submitted, emptyRedactionIndex())

    expect(result.masked[2]).toBe('log ⟦KEY_3⟧⟦TERM_1⟧ end')
    for (const value of ['abc-def-ghi', 'ghi-jkl-mno', 'mno-zzz', 'abc-def-', '-jkl-']) {
      expect(result.masked.join('\n')).not.toContain(value)
    }
    for (const [at, masked] of result.masked.entries()) {
      const back = overlapping.restore(masked, result.registry)
      expect(back.ok && back.text).toBe(texts[at])
    }
  })

  it('does not propagate a full-width spelling of a detected value', async () => {
    // Propagation runs on the submitted text only; the NFKC projection is a
    // detection pass, not an index of the values it found.
    const service2 = new RulesRedactionService(new Context())
    const texts = ['password=hunter22x', 'later ｈｕｎｔｅｒ２２ｘ appears']
    const submitted = texts.map((text, at) => ({ seq: SessionSeq(at + 1), path: '/content/0/text', text }))
    const { masked } = await service2.mask(submitted, emptyRedactionIndex())
    expect(masked[0]).toBe('password=⟦KEY_1⟧')
    expect(masked[1]).toBe('later ｈｕｎｔｅｒ２２ｘ appears')
  })

  it('propagates a value that names its own key, which only over-masks', async () => {
    // The redaction core also withholds a value equal to its key name. The
    // provider cannot: `propagate` receives bound originals, not the key each
    // was read from, and a per-instance flag would race concurrent masks.
    const service2 = new RulesRedactionService(new Context())
    const texts = ['DB_PASSWORD=db_password', 'set db_password elsewhere']
    const submitted = texts.map((text, at) => ({ seq: SessionSeq(at + 1), path: '/content/0/text', text }))
    const { masked } = await service2.mask(submitted, emptyRedactionIndex())
    expect(masked).toEqual(['DB_PASSWORD=⟦KEY_1⟧', 'set ⟦KEY_1⟧ elsewhere'])
  })

  it('indexes five thousand values without a combined pattern', async () => {
    const values = Array.from({ length: 5_000 }, (_, i) => `qa.person${String(i).padStart(5, '0')}@example.test`)
    const carrier = values.join('\n')
    const haystack = `first ${values[0] ?? ''} last ${values[4_999] ?? ''} ${'filler '.repeat(2_000)}`
    let at = 0
    const spans = values.map((value, i) => {
      const start = at
      at += value.length + 1
      return span(1, start, start + value.length, `EMAIL_${i + 1}`)
    })
    const started = process.hrtime.bigint()
    const masked = await maskSeeded([carrier, haystack], spans)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    expect(masked[1]).toBe(`first ⟦EMAIL_1⟧ last ⟦EMAIL_5000⟧ ${'filler '.repeat(2_000)}`)
    expect(ms).toBeLessThan(10_000)
  })
})
