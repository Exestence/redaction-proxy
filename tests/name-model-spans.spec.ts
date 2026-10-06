// Pure pieces of the name model: prose selection, token category choice, span assembly and filters, token windows.
import { describe, expect, it } from 'vitest'
import { tokenWindows } from '../src/core/model/name-model.ts'
import { proseLayout } from '../src/core/model/prose.ts'
import type { ModelSpan } from '../src/core/model/spans.ts'
import { assembleSpans, chooseCategory, classCategories, dropAllowlisted, dropCodeShaped, trimJapaneseNameTails } from '../src/core/model/spans.ts'
import { FAKE_LABELS } from './name-model-fake.ts'

const slices = (text: string, ranges: { start: number; end: number }[]): string[] => ranges.map(({ start, end }) => text.slice(start, end))

describe('proseLayout', () => {
  it('keeps prose paragraphs and skips fenced, indented, code-, YAML-, and log-shaped lines', () => {
    const text = 'Hi Jane Doe,\n\n```ts\nconst who = "Bob";\n```\nI renamed `AliceService` today.\nname: x\nowner: y\nSubject: hello\nconst a = 1;\n    indented\n[ERROR] Bob failed\nbye'
    const { paragraphs, inlineCode } = proseLayout(text)
    expect(slices(text, paragraphs)).toEqual(['Hi Jane Doe,', 'I renamed `AliceService` today.', 'Subject: hello', 'bye'])
    expect(slices(text, inlineCode)).toEqual(['`AliceService`'])
  })

  it('cuts paragraphs at blank lines, so each gets its own model pass', () => {
    expect(slices('Subject: Q3\n\nJohn Doe asked.\nok', proseLayout('Subject: Q3\n\nJohn Doe asked.\nok').paragraphs))
      .toEqual(['Subject: Q3', 'John Doe asked.\nok'])
  })

  it('keeps chat that starts with a lower-case keyword as prose, and keyword-led code as code', () => {
    const prose = ['let me know if Jordan Lee agrees', 'return the laptop to Evelyn Hartwell', 'then ask Evelyn', 'export the report for Evelyn']
    const code = ['import os', 'import { join } from \'node:path\'', 'export const owner = 1', 'return owner', 'let owner: string', 'done']
    expect(prose.map(line => proseLayout(line).paragraphs.length)).toEqual([1, 1, 1, 1])
    expect(code.map(line => proseLayout(line).paragraphs.length)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('keeps a lone YAML-like line as prose', () => {
    expect(proseLayout('note: call Jane tomorrow').paragraphs).toHaveLength(1)
  })
})

describe('chooseCategory', () => {
  const classes = classCategories(FAKE_LABELS, ['NAME', 'ORG', 'LOC', 'ADDR'])

  it('maps BIO classes to categories and drops types the rules own', () => {
    expect(classes).toEqual([undefined, 'NAME', 'NAME', 'NAME', 'ORG', 'LOC', undefined])
  })

  it('sums the probabilities of every class of one category before the threshold', () => {
    // GIVEN_NAME and SURNAME at 0.2 each: neither alone reaches 0.3, their NAME sum does.
    const logits = [Math.log(0.6), Math.log(0.2), -Infinity, Math.log(0.2), -Infinity, -Infinity, -Infinity]
    expect(chooseCategory(logits, classes, 0.3)).toBe('NAME')
    expect(chooseCategory(logits, classes, 0.5)).toBeUndefined()
  })

  it('ignores probability on dropped classes', () => {
    expect(chooseCategory([0, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, 5], classes, 0.3)).toBeUndefined()
  })
})

describe('assembleSpans', () => {
  it('joins tokens of one category across spaces and tabs, never across a newline, and trims whitespace', () => {
    const text = 'Ask Jane\tDoe\nLee now'
    const span = (start: number, end: number, category?: 'NAME'): { start: number; end: number; category: 'NAME' | undefined } => ({ start, end, category })
    const tokens = [span(0, 3), span(3, 8, 'NAME'), span(9, 12, 'NAME'), span(13, 16, 'NAME'), span(16, 20)]
    expect(slices(text, assembleSpans(tokens, text))).toEqual(['Jane\tDoe', 'Lee'])
  })
})

describe('span filters', () => {
  const at = (text: string, value: string, category: ModelSpan['category'] = 'NAME'): ModelSpan => {
    const start = text.indexOf(value)
    return { start, end: start + value.length, category }
  }

  it('drops identifier-shaped, lower-case, slash, and lone digit spans, but keeps an address number', () => {
    const text = 'WangService jane_doe getUser a/b, room 8 today, 世紀大道100號 Jane'
    const spans = ['Wang', 'jane_doe', 'getUser', 'a/b', '8', '世紀大道', '100', 'Jane'].map(value => at(text, value))
    expect(slices(text, dropCodeShaped(spans, text))).toEqual(['世紀大道', '100', 'Jane'])
  })

  it('drops allowlisted spans case-insensitively', () => {
    const text = 'Run KAFKA with Jane'
    expect(slices(text, dropAllowlisted([at(text, 'KAFKA', 'ORG'), at(text, 'Jane')], text, new Set(['kafka'])))).toEqual(['Jane'])
  })

  it('cuts honorifics and particles off Japanese NAME spans only', () => {
    const text = '佐藤美咲さんに、田中先生と、マリアちゃんは、ゆきのに、東京都に'
    const spans = [at(text, '佐藤美咲さんに'), at(text, '田中先生と'), at(text, 'マリアちゃんは'), at(text, 'ゆきのに'), at(text, '東京都に', 'LOC')]
    expect(slices(text, trimJapaneseNameTails(spans, text))).toEqual(['佐藤美咲', '田中', 'マリア', 'ゆきのに', '東京都に'])
  })

  it('leaves Chinese names that end in a Japanese honorific glyph alone', () => {
    const text = '請聯絡王君與林先生'
    expect(slices(text, trimJapaneseNameTails([at(text, '王君'), at(text, '林先生')], text))).toEqual(['王君', '林先生'])
  })
})

describe('tokenWindows', () => {
  it('scores every token once, each by the window where it is furthest from an edge', () => {
    const windows = tokenWindows(1000, 510, 128)
    const owners = new Array<number>(1000).fill(0)
    for (const window of windows) for (let t = window.from + window.dropHead; t < window.to - window.dropTail; t += 1) owners[t] = (owners[t] ?? 0) + 1
    expect(owners.every(count => count === 1)).toBe(true)
    expect(windows.map(({ from, to }) => [from, to])).toEqual([[0, 510], [382, 892], [764, 1000]])
  })

  it('uses one window when the text fits', () => {
    expect(tokenWindows(20, 510, 128)).toEqual([{ from: 0, to: 20, dropHead: 0, dropTail: 0 }])
  })
})
