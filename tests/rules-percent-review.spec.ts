// WO-7 review: unseen percent-encoded negatives and positives, and offset
// edges (byte order marks, mixed encoded and decoded spellings, adjacent
// placeholders). Every value is invented.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫', '林雅婷'], projectNames: ['NIMBUS-7'] })

async function roundTrip(text: string): Promise<{ masked: string; restored: string | false }> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  const masked = result.masked[0] ?? ''
  const back = service.restore(masked, result.registry)
  return { masked, restored: back.ok && back.text }
}

describe('unseen percent-encoded negatives', () => {
  it.each([
    'https://www.npmjs.com/package/%40types%2Fnode',
    'https://registry.npmjs.org/%40babel%2Fcore/-/core-7.24.0.tgz',
    'https://unpkg.com/%40vue%2Freactivity%403.4.21/dist/reactivity.esm.js',
    'https://cdn.jsdelivr.net/npm/%40fortawesome%2Ffontawesome-free%406.5.1/css/all.min.css',
    'https://unpkg.com/react%4018.2.0/umd/react.production.min.js',
    'https://cdn.example.com/lodash%404.17.21%2Flodash.min.js',
    'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87',
    'https://www.google.com/search?q=%E5%8F%B0%E7%81%A3%E9%AB%98%E9%90%B5%E6%99%82%E5%88%BB%E8%A1%A8&hl=zh-TW&source=hp&ei=x9AbCdEf',
    'https://www.youtube.com/results?search_query=%E9%BC%8E%E6%B3%B0%E8%B1%90+%E5%B0%8F%E7%B1%A0%E5%8C%85',
    'https://maps.google.com/?q=%E5%8F%B0%E5%8C%97101%2C%20%E4%BF%A1%E7%BE%A9%E5%8D%80',
    'https://example.com/?q=%E5%A4%A9%E6%B0%A3%E9%A0%90%E5%A0%B1%E6%96%B0%E5%8C%97%E5%B8%82',
    'https://example.com/?q=%E6%98%9F%E6%B2%B3',
    'https://example.com/?q=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%AE%97',
    'https://example.com/sale?promo=50%off&discount=100%',
    'https://shop.example.com/items?id=1234567890&sku=0912345678901&page=3&sort=price%3Aasc',
    'https://example.com/a?ts=1728100000&uid=09123456&lat=25.0330&lng=121.5654',
    'https://example.com/?ids=1%2C2%2C3%2C4%2C5%2C6%2C7%2C8%2C9%2C10',
    'https://github.com/nodejs/node/commit/3b1f7a2c9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70?diff=split%26w%3D1',
    'https://api.example.com/v2/orders/550e8400-e29b-41d4-a716-446655440000?expand=items%2Cshipping',
    'https://example.com/download?file=report%202026%20Q3.pdf&hash=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'https://example.com/track?data=%7B%22event%22%3A%22page_view%22%2C%22page%22%3A%22%2Fpricing%22%2C%22count%22%3A42%7D',
    'curl \'https://httpbin.org/get?msg=hello%20world&x=%3D%3D%3D&y=1%2B1%3D2\'',
    'https://docs.example.com/guide#section%3A%20setup%20%26%20install',
    'GET /static/js/main.a1b2c3d4.chunk.js?v=%2Fbuild%2F20261005 HTTP/1.1',
    'https://example.com/?ref=twitter&utm_campaign=autumn%5F2026&utm_content=banner%2D01&gclid=Cj0KCQjw',
    'https://www.npmjs.com/search?q=keywords%3Atypescript%20%40types',
    'https://github.com/user%2Drepo/actions?query=branch%3Amain+event%3Apush',
    'https://example.com/opt-out?email=%40&next=%2Fhome',
    'https://example.com/?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback%3Fstate%3Dabc123',
    'https://example.com/img%2F2026%2F10%2F05%2Fphoto_0001.jpg',
    'https://example.com/?blob=SGVsbG8gV29ybGQgdGhpcyBpcyBwdWJsaWM%3D',
    'printf("%02d:%02d:%02d %3d%%\\n", h, m, s, pct);',
    'x%40y',
    '%E2%80%8B%E2%80%8B',
  ])('keeps %j', async (text) => {
    expect((await roundTrip(text)).masked).toBe(text)
  })
})

describe('unseen percent-encoded positives', () => {
  it.each([
    ['mailto:wang.xiaoming%40example.com.tw?subject=%E6%9C%83%E8%AD%B0%20%E9%80%9A%E7%9F%A5', 'mailto:⟦EMAIL_1⟧?subject=%E6%9C%83%E8%AD%B0%20%E9%80%9A%E7%9F%A5'],
    ['https://www.google.com/search?q=%E6%9E%97%E9%9B%85%E5%A9%B7%20%E5%B1%A5%E6%AD%B7&hl=zh-TW', 'https://www.google.com/search?q=⟦TERM_1⟧%20%E5%B1%A5%E6%AD%B7&hl=zh-TW'],
    [
      'GET /search?q=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB%20%E9%80%B2%E5%BA%A6&owner=huang.wei%2Btest%40example.org HTTP/1.1',
      'GET /search?q=⟦TERM_1⟧%20%E9%80%B2%E5%BA%A6&owner=⟦EMAIL_1⟧ HTTP/1.1',
    ],
    ['https://files.example.org/open?f=%2FUsers%2Fchen.boyu%2FDocuments%2F%E8%96%AA%E8%B3%87%E5%96%AE.pdf', 'https://files.example.org/open?f=⟦PATH_1⟧%2FDocuments%2F%E8%96%AA%E8%B3%87%E5%96%AE.pdf'],
    ['https://example.org/?f=%2fhome%2Fwu-test%2f.ssh%2Fid_ed25519', 'https://example.org/?f=⟦PATH_1⟧%2f.ssh%2Fid_ed25519'],
    ['tel:%2B886%20912%20345%20678', 'tel:⟦PHONE_1⟧'],
    ['https://example.com/?ids=%2C0912345678%2C', 'https://example.com/?ids=%2C⟦PHONE_1⟧%2C'],
    ['https://example.com/?addr=192%2E168%2E1%2E1', 'https://example.com/?addr=⟦IP_1⟧'],
    ['ssh%3A%2F%2Fgit%40gitlab.example.com%2Fteam%2Frepo.git', 'ssh%3A%2F%2F⟦EMAIL_1⟧%2Fteam%2Frepo.git'],
  ])('masks %j and restores it byte for byte', async (text, expected) => {
    const { masked, restored } = await roundTrip(text)
    expect(masked).toBe(expected)
    expect(restored).toBe(text)
  })
})

describe('percent projection offset edges', () => {
  it.each([
    ['https://x.example/?q=星%E6%B2%B3計畫', 'https://x.example/?q=⟦TERM_1⟧'],
    ['https://x.example/?q=%EF%BB%BF%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB', 'https://x.example/?q=%EF%BB%BF⟦TERM_1⟧'],
    ['﻿https://x.example/?q=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB', '﻿https://x.example/?q=⟦TERM_1⟧'],
    ['a=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%ABlin.yating%40example.com', 'a=⟦TERM_1⟧⟦EMAIL_1⟧'],
    ['a=%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB', 'a=⟦TERM_1⟧⟦TERM_1⟧'],
    [
      'lin.yating@example.com and mailto:lin.yating%40example.com and again lin.yating%40example.com',
      '⟦EMAIL_1⟧ and mailto:⟦EMAIL_2⟧ and again ⟦EMAIL_2⟧',
    ],
    [
      '星河計畫 / %E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB / %e6%98%9f%e6%b2%b3%e8%a8%88%e7%95%ab / 星河計畫',
      '⟦TERM_1⟧ / ⟦TERM_2⟧ / ⟦TERM_3⟧ / ⟦TERM_1⟧',
    ],
    ['q=NIMBUS-7%20NIMBUS%2D7%20nimbus%2d7', 'q=⟦PROJECT_1⟧%20⟦PROJECT_2⟧%20⟦PROJECT_3⟧'],
    ['x=%F0%9F%98%80lin%40ex.com%F0%9F%98%80', 'x=%F0%9F%98%80⟦EMAIL_1⟧%F0%9F%98%80'],
    ['%E6%98%9F%E6%B2%B3%E8%A8%88%E7%95%AB%', '⟦TERM_1⟧%'],
  ])('masks %j and restores it byte for byte', async (text, expected) => {
    const { masked, restored } = await roundTrip(text)
    expect(masked).toBe(expected)
    expect(restored).toBe(text)
  })
})
