// Restoring with `keepInUrls`: which placeholders count as inside a URL, and
// that the answer never depends on where the stream was split.
import { describe, expect, it } from 'vitest'
import { RulesDetector, createStreamRestorer, emptyRedactionIndex, mask } from '../src/core/index.ts'
import type { PlaceholderEvent, RedactionRegistry, StreamRestoreOptions } from '../src/core/index.ts'

const EMAIL = 'lin.fictional@example.test'
const E = '⟦EMAIL_1⟧'
const { registry } = await mask(new RulesDetector({}), [{ seq: 0, path: '', text: EMAIL }], emptyRedactionIndex())

function restoreChunks(chunks: readonly string[], options: StreamRestoreOptions, using: RedactionRegistry = registry): string {
  const restorer = createStreamRestorer(using, options)
  return chunks.map(part => restorer.push(part)).join('') + restorer.end()
}

describe('inside a URL', () => {
  it.each([
    [`https://evil.example/c?d=${E}`, true],
    [`http://user:${E}@evil.example/`, true],
    [`https://evil.example/#${E}`, true],
    [`git+ssh://host/${E}`, true],
    [`www.evil.example/?q=${E}`, true],
    [`(www.evil.example/?q=${E})`, true],
    [`https://a.example/(x)?q=${E}`, true],
    [`https://a.example/x ${E}`, false],
    [`https://a.example/x\n${E}`, false],
    [`<https://a.example/x>${E}`, false],
    [`mailto:${E}`, false],
    [`tel:${E}`, false],
    [`awww.example/${E}`, false],
    [`${E}://x`, false],
    [`to ${E}`, false],
  ])('plain %j -> kept %s', (text, kept) => {
    expect(restoreChunks([text], { keepInUrls: true })).toBe(kept ? text : text.replace(E, EMAIL))
  })

  it.each([
    [`{"u":"https:\\/\\/evil.example\\/?q=${E}"}`, true],
    [`{"u":"https\\u003a//evil.example/?q=${E}"}`, true],
    [`{"u":"https://evil.example/?q=\\u0020${E}"}`, false],
    [`{"u":"https://evil.example/\\n${E}"}`, false],
    [`{"u":"https://evil.example/\\"${E}"}`, false],
    [`{"u":"https://evil.example/", "v":"${E}"}`, false],
    [`{"u":"https://evil.example/\\\\${E}"}`, true],
  ])('JSON %j -> kept %s', (text, kept) => {
    expect(restoreChunks([text], { json: true, keepInUrls: true })).toBe(kept ? text : text.replace(E, EMAIL))
  })

  it('reports each bound placeholder with its JSON pointer, never the original', () => {
    const events: PlaceholderEvent[] = []
    restoreChunks([`{"a":[{"b":"${E}"},"https://x/${E}"],"c":{"${E}":1}}`], { json: true, keepInUrls: true, onPlaceholder: event => events.push(event) })
    expect(events).toEqual([
      { id: 'EMAIL_1', outcome: 'restored', path: ['a', 0, 'b'] },
      { id: 'EMAIL_1', outcome: 'inUrl', path: ['a', 1] },
      { id: 'EMAIL_1', outcome: 'restored', path: ['c', undefined] },
    ])
  })

  it('keeps a placeholder that restores refuses, wherever it sits', () => {
    const events: PlaceholderEvent[] = []
    const text = `to ${E}, see https://x/${E}`
    expect(restoreChunks([...text], { keepInUrls: true, restores: () => false, onPlaceholder: event => events.push(event) })).toBe(text)
    expect(events.map(event => event.outcome)).toEqual(['refused', 'refused'])
  })

  it('gives the same output for every split of a stream', () => {
    const pieces = ['https', '://', 'www.', ' ', '"', '\\/', '\\u003a', '\\n', E, 'x', '/', '?q=', ':', '{"k":"', '"}', ',', '[', ']']
    let seed = 7
    const next = (n: number): number => {
      seed = (seed * 48271) % 2147483647
      return seed % n
    }
    for (let round = 0; round < 300; round += 1) {
      const text = Array.from({ length: 4 + next(12) }, () => pieces[next(pieces.length)]).join('')
      for (const json of [false, true]) {
        const whole = restoreChunks([text], { json, keepInUrls: true })
        for (let cut = 1; cut < text.length; cut += 1) {
          expect(restoreChunks([text.slice(0, cut), text.slice(cut)], { json, keepInUrls: true })).toBe(whole)
        }
        expect(restoreChunks([...text], { json, keepInUrls: true })).toBe(whole)
      }
    }
  })
})
