// Realistic regroupings of identifiers (WO-6): configured terms split by a
// separator, obfuscated addresses, identification, business, and mobile
// numbers with one internal separator, the full-width call guard, and the
// business-number tie with a telephone keyword. Every number is invented:
// identification and business numbers are checksum-valid inventions unless
// a case says otherwise.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] })

async function mask(text: string): Promise<string> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

describe('configured terms split by a separator', () => {
  it.each([
    ['備註：星河 計畫', '備註：⟦TERM_1⟧'],
    ['備註：星河-計畫', '備註：⟦TERM_1⟧'],
    ['備註：星河_計畫', '備註：⟦TERM_1⟧'],
    ['備註：星河・計畫', '備註：⟦TERM_1⟧'],
    ['資料 NIMBUS 7 已上線', '資料 ⟦PROJECT_1⟧ 已上線'],
    ['資料 NIMBUS_7 已上線', '資料 ⟦PROJECT_1⟧ 已上線'],
    ['資料 nimbus7 已上線', '資料 ⟦PROJECT_1⟧ 已上線'],
    ['備註：星河  計畫 隔了兩個空格', '備註：⟦TERM_1⟧ 隔了兩個空格'],
    ['NIMBUS - 7 has two separators', '⟦PROJECT_1⟧ has two separators'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it.each([
    '只寫了星河兩個字',
    '這個計畫延後',
    '星河計 是另一個詞',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })

  it.each([
    'Margaret  Holloway',
    'cc: Margaret\n    Holloway',
    'cc: margaret\r\n\tHOLLOWAY',
  ])('masks a name with a run of separators in %j, and a term configured with one', async (text) => {
    for (const term of ['Margaret Holloway', 'Margaret  Holloway']) {
      const named = new RulesRedactionService(new Context(), { terms: [term] })
      const result = await named.mask([{ seq: SessionSeq(1), path: '/a', text }], emptyRedactionIndex())
      expect(result.masked[0]).toBe(text.replace(/margaret[\s\S]*holloway/i, '⟦TERM_1⟧'))
    }
  })

  it('steps over an astral character between overlapping occurrences', async () => {
    const astral = new RulesRedactionService(new Context(), { terms: ['𠮷野家'] })
    const result = await astral.mask([{ seq: SessionSeq(1), path: '/a', text: '去𠮷 野家 𠮷野家𠮷野家' }], emptyRedactionIndex())
    expect(result.masked[0]).toBe('去⟦TERM_1⟧ ⟦TERM_2⟧⟦TERM_2⟧')
  })

  it('binds each spelling to its own identity and restores every spelling exactly', async () => {
    const text = '星河計畫、星河 計畫、星河-計畫'
    const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
    expect(result.masked[0]).toBe('⟦TERM_1⟧、⟦TERM_2⟧、⟦TERM_3⟧')
    expect(result.registry.originals()).toEqual(['星河計畫', '星河 計畫', '星河-計畫'])
    const back = service.restore('⟦TERM_1⟧ / ⟦TERM_3⟧', result.registry)
    expect(back.ok && back.text).toBe('星河計畫 / 星河-計畫')
  })

  it('keeps a recorded spelling\'s identity and gives a new spelling in a later call its own', async () => {
    const first = await service.mask([{ seq: SessionSeq(1), path: '/a', text: '星河 計畫' }], emptyRedactionIndex())
    const index = {
      entries: [{ seq: SessionSeq(1), path: '/a', detectorVersion: service.detectorVersion, spans: first.spans.map(({ start, end, id }) => ({ start, end, id })) }],
      lastIds: { TERM: 1 },
      reserved: [],
      policyDigest: service.policyDigest,
    }
    const second = await service.mask([
      { seq: SessionSeq(1), path: '/a', text: '星河 計畫' },
      { seq: SessionSeq(2), path: '/b', text: '星河-計畫' },
    ], index)
    expect(second.masked).toEqual(['⟦TERM_1⟧', '⟦TERM_2⟧'])
  })
})

describe('obfuscated email addresses', () => {
  it.each([
    ['mail wang.yichun(at)example.com now', 'mail ⟦EMAIL_1⟧ now'],
    ['寄到 liu_kuanting＠school.test 謝謝', '寄到 ⟦EMAIL_1⟧ 謝謝'],
    ['mail wang.yichun [at] example.com now', 'mail ⟦EMAIL_1⟧ now'],
    ['mail wang.yichun@example[dot]com now', 'mail ⟦EMAIL_1⟧ now'],
    ['mail wang.yichun [at] example (dot) com now', 'mail ⟦EMAIL_1⟧ now'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it.each([
    'meet at home.tw',
    'the docs live at github.com',
    'a @ b',
    'Ping me at standup, not at discord.com.',
    'y = x @ self.weight',
    'released v1.2 at github.com',
    'package.json at github.com',
    'wang.yichun at example.com',
    'mail is down; socket.io at github.com has the fix and more',
    'cc Amy\n@bob.dev please review',
    'A.T @ B.mt',
    'h = inputs.T @ model.fc',
    'mail wang.yichun   @ example.tw',
    'mail wang.yichun @ example.xyz',
    'x @ foo.com',
    '12 @ foo.com',
    'see @ localhost',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('identification numbers with one separator', () => {
  it.each([
    ['資料請參考 A123-456789，謝謝', '資料請參考 ⟦TWID_1⟧，謝謝'],
    ['--target A 123456789 # 請求', '--target ⟦TWID_1⟧ # 請求'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it.each([
    '資料請參考 A123-456780，謝謝',
    '資料請參考 A1234-56789，謝謝',
    // A product code that fails the checksum; `M132-682948` passes it and is masked.
    '商品型號 M132-682949，庫存剩 30 件。',
    '資料請參考 A12-3456789，謝謝',
    '料號 A123-456789-01',
    '料號 XA123-456789',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('business numbers with one separator', () => {
  it.each([
    ['統編 3208-5109', '統編 ⟦TAXID_1⟧'],
    ['Tax ID: 0420 9924', 'Tax ID: ⟦TAXID_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it.each([
    '統編 3208-5108',
    '訂單 3208-5109',
    '統編 3208-51099',
    '統編 32-08-5109',
    '統編 3208-5109-1',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })

  it('masks a business number after a telephone keyword as a business number', async () => {
    expect(await mask('聯絡窗口是 統編：02086968，謝謝。')).toBe('聯絡窗口是 統編：⟦TAXID_1⟧，謝謝。')
    expect(await mask('聯絡 VAT 02086968')).toBe('聯絡 VAT ⟦TAXID_1⟧')
  })
})

describe('mobile numbers grouped 2-4-4', () => {
  it.each([
    ['"owner": "09-8471-4724"', '"owner": "⟦PHONE_1⟧"'],
    ['在 09 0075 1778 上重現', '在 ⟦PHONE_1⟧ 上重現'],
    ['call 09 1234 5678 now', 'call ⟦PHONE_1⟧ now'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it.each([
    '報表日期：09-2026-1005',
    '檔名 report_09-2026-1200.csv',
    'ref 1209-8471-4724 here',
    'ref 09-8471-47245 here',
    '在 09-8471 4724 上重現',
    'request-id: 442c1a09-5618-4584-a2ad-3dd3ec501c2c',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('the call guard on a full-width host', () => {
  it('masks a full-width host followed by a full-width parenthesis', async () => {
    expect(await mask('轉帳備註：ｎａｓ．ｌａｎ（代墊的晚餐錢）')).toBe('轉帳備註：⟦HOST_1⟧（代墊的晚餐錢）')
  })

  it.each([
    'call foo.lan(1)',
    'call foo.lan(1) ｘ',
    'call ｆｏｏ．ｌａｎ(1)',
  ])('keeps the call in %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

// WO-6 round 3 dropped the bare ` at ` form (prose is lexically identical to
// an address), so these former positives are asserted unmasked.
describe('WO-6 round 3: bare at is not detected', () => {
  it.each([
    'mail wang.yichun at example.com now',
    '信箱：wang.yichun at example.com',
    'Contact: hsu_yawen AT corp.test',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

// WO-6 amendment R4: spaced `@` is not detected, so these spaced-`@` addresses are asserted unmasked.
describe('WO-6 round 5: spaced @ is not detected', () => {
  it.each([
    'CONTACT=wang.yichun @ example.tw',
    '寄到 liu_kuanting ＠ school.test 謝謝',
    'CONTACT=cheng.yuhsiang41 @ example.tw',
    '寄給 lin.yating  @  ntu.edu.tw 吧',
    'john @ example.com',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})
