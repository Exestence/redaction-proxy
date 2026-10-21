// Percent-encoded values: every rule also runs over a percent-decoded
// projection, a detection masks the whole encoded range, and restore writes the
// encoded text back byte for byte. Plus the letter boundary on mobile numbers.
// Every value is invented.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'
import { projectPercent } from '../src/core/rules/normalize.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] })

async function roundTrip(text: string): Promise<{ masked: string; restored: string | false }> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  const masked = result.masked[0] ?? ''
  const back = service.restore(masked, result.registry)
  return { masked, restored: back.ok && back.text }
}

describe('percent-encoded values', () => {
  it.each([
    ['mailto:lin.yating%40example.com', 'mailto:⟦EMAIL_1⟧'],
    ['https://portal.example.org/lookup?q=chen.boyu%2Brent%40example.tw&lang=zh-TW', 'https://portal.example.org/lookup?q=⟦EMAIL_1⟧&lang=zh-TW'],
    ['https://search.example.org/?q=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB', 'https://search.example.org/?q=⟦TERM_1⟧'],
    ['https://search.example.org/?q=%e6%98%9f%e6%b2%b3%e8%a8%88%e7%95%ab%E5%A0%B1%E5%91%8A', 'https://search.example.org/?q=⟦TERM_1⟧%E5%A0%B1%E5%91%8A'],
    ['/open?doc=NIMBUS%2D7-plan', '/open?doc=⟦PROJECT_1⟧-plan'],
    ['https://files.example.org/view?path=%2FUsers%2Flin.yating-test%2Fnotes', 'https://files.example.org/view?path=⟦PATH_1⟧%2Fnotes'],
    ['https://files.example.org/view?path=%2fUsers%2Flin.yating-test%2fnotes', 'https://files.example.org/view?path=⟦PATH_1⟧%2fnotes'],
    ['?p=C%3A%5CUsers%5Cwang-test\\Desktop', '?p=⟦PATH_1⟧\\Desktop'],
    [
      'curl -s "https://api.example.test/v1/users?email=chen.mei%40example.tw&page=2" -H "Accept: application/json"',
      'curl -s "https://api.example.test/v1/users?email=⟦EMAIL_1⟧&page=2" -H "Accept: application/json"',
    ],
    [
      '127.0.0.1 - - [05/Oct/2026:04:00:00 +0800] "GET /search?q=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB HTTP/1.1" 200 512',
      '127.0.0.1 - - [05/Oct/2026:04:00:00 +0800] "GET /search?q=⟦TERM_1⟧ HTTP/1.1" 200 512',
    ],
    ['tel=%2B886912345678', 'tel=⟦PHONE_1⟧'],
  ])('masks %j and restores it byte for byte', async (text, expected) => {
    const { masked, restored } = await roundTrip(text)
    expect(masked).toBe(expected)
    expect(restored).toBe(text)
  })

  it('keeps two case spellings of one encoded term apart so each restores as written', async () => {
    const text = 'a?q=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB b?q=%e6%98%9f%e6%b2%b3%e8%a8%88%e7%95%ab'
    const { masked, restored } = await roundTrip(text)
    expect(masked).toBe('a?q=⟦TERM_1⟧ b?q=⟦TERM_2⟧')
    expect(restored).toBe(text)
  })

  it.each([
    'https://example.org/search?q=hello%20world%20again',
    'https://example.org/a%20b/c%20d.html',
    'progress 100% done',
    'today 50%off everything',
    'https://example.org/search?q=%E5%8F%B0%E5%8C%97%E5%A4%A9%E6%B0%A3',
    'https://example.org/?q=%E6',
    'https://example.org/?q=%E6%98%9F%E6%B2',
    'https://example.org/?q=%FF%FE%41',
    'https://example.org/?utm_source=news%3Dletter&utm_medium=email%26x&ref=%2Fpricing',
    'https://example.org/?q=a+b+c%2Bd',
  ])('keeps %j', async (text) => {
    const { masked } = await roundTrip(text)
    expect(masked).toBe(text)
  })

  it('decodes one level only', async () => {
    const text = 'mailto:lin.yating%2540example.com'
    expect((await roundTrip(text)).masked).toBe(text)
  })
})

describe('percent projection offsets', () => {
  it('maps each decoded character to its whole escape range', () => {
    const projection = projectPercent('a%E6%98%9Fb%40')
    expect(projection?.norm).toBe('a星b@')
    expect(projection?.startMap).toEqual([0, 1, 10, 11])
    expect(projection?.endMap).toEqual([1, 10, 11, 14])
  })

  it('keeps an astral character\'s two code units on one range and a byte order mark in place', () => {
    const projection = projectPercent('%EF%BB%BF%F0%A0%AE%B7')
    expect(projection?.norm).toBe('﻿𠮷')
    expect(projection?.startMap).toEqual([0, 9, 9])
    expect(projection?.endMap).toEqual([9, 21, 21])
  })

  it('returns nothing when no run decodes', () => {
    expect(projectPercent('100% and %E6 and %zz')).toBeUndefined()
  })
})

describe('mobile number boundary', () => {
  it.each([
    'sha256: d3e438437099e5a0912345678ddb00c9839830c22cb081f68492920e96912237  release.tar.gz',
    'abc0912345678',
    '0912345678abc',
    'id=x0912-345-678',
  ])('keeps %j', async (text) => {
    expect((await roundTrip(text)).masked).toBe(text)
  })

  it.each([
    ['call 0912345678 now', 'call ⟦PHONE_1⟧ now'],
    ['（0912-345-678）', '（⟦PHONE_1⟧）'],
    ['?n=%2F0912345678', '?n=%2F⟦PHONE_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect((await roundTrip(text)).masked).toBe(expected)
  })
})
