// WO-6 review (D3, D4): negatives and positives the implementer did not see,
// and identity/restore checks across spellings. Every number is invented;
// identification and business numbers are checksum-valid inventions.
// The cases under "required fixes" fail at b5fa653 by design: they are the
// review's FAIL findings and must pass before WO-6 merges.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] })

async function mask(text: string): Promise<string> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

describe('WO-6 review D3: unseen negatives', () => {
  it.each([
    '訂單編號 09-2025-0001 已出貨',
    '這批貨的序號是 B 223456789，請核對',
    'SKU: KB-0912-3456 黑色款',
    '物流單號 0912 3456 7890 1234',
    '時間 09:30 到 10:30，地點 A 棟 3 樓',
    '發票號碼 AB-12345678 金額 1200',
    'const ts = "09-1234-5678T00:00"',
    '星河旅行社的計畫書',
    'release 1.2.3 at 10.0.0 tag',
    'We met at github.com last year.',
    'see config.yaml at github.com',
    'John Smith at gmail.com',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('WO-6 review D3: required fixes (red at b5fa653)', () => {
  it.each([
    // English prose: a dotted product or file name before ` at `.
    'Grab socket.io at github.com before upgrading',
    'I saw ASP.NET at microsoft.com yesterday',
    'Find the user.guide at docs.example.com',
    'see setup.cfg at github.com',
    'the main.rs at github.com',
    // Code: matrix product with a two-letter attribute (PyTorch `.mT`).
    'out = A.T @ B.mT',
    'attn = self.q @ self.k.mT',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('WO-6 review D3: unseen positives', () => {
  it.each([
    ['mail: lin.yating[at]school[dot]tw', 'mail: ⟦EMAIL_1⟧'],
    ['申請人 K231-415926 已補件', '申請人 ⟦TWID_1⟧ 已補件'],
    ['統一編號 5271-8444', '統一編號 ⟦TAXID_1⟧'],
    ['手機 09 3141 5926 晚上打', '手機 ⟦PHONE_1⟧ 晚上打'],
    ['代號 星河·計畫 與 nimbus 7', '代號 ⟦TERM_1⟧ 與 ⟦PROJECT_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })
})

describe('WO-6 review D4: identity and restore across spellings', () => {
  const spellings = ['星河計畫', '星河 計畫', '星河-計畫', 'NIMBUS-7', 'nimbus 7', 'Nimbus_7']
  const text = spellings.join(' / ')

  it('sends no spelling and lists every spelling for the leak scan', async () => {
    const result = await service.mask([{ seq: SessionSeq(1), path: '/a', text }], emptyRedactionIndex())
    const masked = result.masked[0] ?? ''
    expect(masked).toBe('⟦TERM_1⟧ / ⟦TERM_2⟧ / ⟦TERM_3⟧ / ⟦PROJECT_1⟧ / ⟦PROJECT_2⟧ / ⟦PROJECT_3⟧')
    for (const fragment of ['星', '計', 'NIMBUS', 'nimbus', 'Nimbus', '7']) expect(masked).not.toContain(fragment)
    expect([...result.registry.originals()].sort()).toEqual([...spellings].sort())
  })

  it('restores each identity to its own spelling, deterministically', async () => {
    const restoreOnce = async (): Promise<string | false> => {
      const result = await service.mask([{ seq: SessionSeq(1), path: '/a', text }], emptyRedactionIndex())
      const back = service.restore('⟦TERM_1⟧ ⟦PROJECT_1⟧ ⟦TERM_1⟧', result.registry)
      return back.ok && back.text
    }
    expect(await restoreOnce()).toBe('星河計畫 NIMBUS-7 星河計畫')
    expect(await restoreOnce()).toBe(await restoreOnce())
  })

  it('restores the recorded spelling, not a later one, after reuse', async () => {
    const first = await service.mask([{ seq: SessionSeq(1), path: '/a', text: '星河-計畫' }], emptyRedactionIndex())
    const index = {
      entries: [{ seq: SessionSeq(1), path: '/a', detectorVersion: service.detectorVersion, spans: first.spans.map(({ start, end, id }) => ({ start, end, id })) }],
      lastIds: { TERM: 1 },
      reserved: [],
      policyDigest: service.policyDigest,
    }
    const second = await service.mask([
      { seq: SessionSeq(2), path: '/b', text: '星河計畫' },
      { seq: SessionSeq(1), path: '/a', text: '星河-計畫' },
    ], index)
    expect(second.masked).toEqual(['⟦TERM_2⟧', '⟦TERM_1⟧'])
    const back = service.restore('⟦TERM_1⟧', second.registry)
    expect(back.ok && back.text).toBe('星河-計畫')
  })

  it('refuses an index recorded under rules-2 instead of reusing it', async () => {
    const index = { ...emptyRedactionIndex(), policyDigest: 'sha256:rules-2-digest' as typeof service.policyDigest }
    await expect(service.mask([{ seq: SessionSeq(1), path: '/a', text: '星河計畫' }], index)).rejects.toMatchObject({ code: 'policy' })
  })
})

// WO-6 amendment R4: spaced `@` is not detected (the classifier is the only
// guard), so these spaced-`@` addresses are asserted unmasked.
describe('WO-6 round 5: spaced @ is not detected', () => {
  it.each([
    '請寄到 chen.meiling ＠ example.tw，謝謝',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})
