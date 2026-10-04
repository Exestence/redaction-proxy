import { describe, expect, it } from 'vitest'
import { Context } from './shim.ts'
import { RedactionError, emptyRedactionIndex } from '../src/core/index.ts'
import RulesRedactionService from './shim.ts'
import { SessionSeq } from './shim.ts'

// Every number below is invented: the card numbers are the published test
// numbers, the identification numbers are checksum-valid inventions, and the
// addresses are in reserved ranges.
const service = new RulesRedactionService(new Context())

async function mask(text: string, of: RulesRedactionService = service): Promise<string> {
  const result = await of.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

describe('telephone and business numbers', () => {
  it.each([
    ['0912345678', '⟦PHONE_1⟧'],
    ['0912-345-678', '⟦PHONE_1⟧'],
    ['0912 345 678', '⟦PHONE_1⟧'],
    ['+886912345678', '⟦PHONE_1⟧'],
    ['+886-2-2345-6789', '⟦PHONE_1⟧'],
    ['電話 02-23456789', '電話 ⟦PHONE_1⟧'],
    ['tel (02)2345-6789', 'tel ⟦PHONE_1⟧'],
    ['統一編號 12345678', '統一編號 ⟦TAXID_1⟧'],
    ['tax_id: 87654321', 'tax_id: ⟦TAXID_1⟧'],
    ['統編 12345678 2026年', '統編 ⟦TAXID_1⟧ 2026年'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it.each([
    'call 091234567 back',
    'ref 09123456789012 here',
    'count 12345678 rows',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('payment card numbers', () => {
  it.each([
    'pay 4111111111111111 now',
    'pay 4111 1111 1111 1111 now',
    'pay 378282246310005 now',
    'pay 04111111111111111 now',
  ])('masks the card in %j', async (text) => {
    expect(await mask(text)).toContain('⟦CARD_1⟧')
  })

  it.each([
    'id 14111111111111111 here',
    'id 41111111111111111 here',
    'counter limit 18446744073709551615 reached',
    'ts=1758000000000000000 level=info',
  ])('keeps the digit run in %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('addresses and host names', () => {
  it.each([
    ['ping 10.0.0.5', 'ping ⟦IP_1⟧'],
    ['ping 192.168.1.1', 'ping ⟦IP_1⟧'],
    ['ping 172.16.0.1', 'ping ⟦IP_1⟧'],
    ['ssh nas.local', 'ssh ⟦HOST_1⟧'],
    ['curl build.internal/x', 'curl ⟦HOST_1⟧/x'],
    ['ping printer.lan', 'ping ⟦HOST_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it.each([
    'ping 8.8.8.8',
    'ping 10.0.0.999',
    'ping 172.32.0.1',
    'const x = this.local',
    'see .local suffixes',
    'call ctx.local(1)',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('high-entropy runs', () => {
  it('masks a long hexadecimal run with no revision context', async () => {
    expect(await mask('value 0123456789abcdef0123456789abcdef01234567 end'))
      .toBe('value ⟦ENTROPY_1⟧ end')
  })

  it('masks a high-entropy base64 run', async () => {
    expect(await mask('opaque aB3dEfGh1jKlMn0pQrStUvWxYz2AbCdEfGh4 end')).toBe('opaque ⟦ENTROPY_1⟧ end')
  })

  it.each([
    ['hexadecimal', 'secret 0123456789abcdef0123456789abcdef end'],
    ['base64', 'secret aB3dEfGh1jKlMn0pQrStUvWxYz2AbCdEfGh4 end'],
  ])('reports a %s run beside credential words as a credential', async (_label, text) => {
    expect(await mask(text)).toContain('⟦KEY_1⟧')
  })

  it.each([
    'commit 0123456789abcdef0123456789abcdef01234567',
    'integrity sha512-aB3dEfGh1jKlMn0pQrStUvWxYz2AbCdEfGh4',
    'at /0123456789abcdef0123456789abcdef01234567',
    'digest aB3dEfGh1jKlMn0pQrStUvWxYz2AbCdEfGh4',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })

  it('stops the walk back from a host suffix after 253 characters', async () => {
    const text = `${'z'.repeat(10)}.${'y'.repeat(253)}.local`
    expect(await mask(text)).toBe(text)
  })
})

describe('overlap resolution', () => {
  it('covers the union of overlapping ranges instead of the first by start order', async () => {
    // The literal starts before the credential value and ends inside it; resolving
    // by start order alone would mask only the literal and send `2xyz` verbatim.
    const overlapping = new RulesRedactionService(new Context(), { terms: ['secret=hunter'] })
    expect(await mask('my-secret=hunter2xyz', overlapping)).toBe('my-⟦TERM_1⟧')
  })
})

describe('input screening', () => {
  it.each([
    ['a NUL character', 'before \u0000 after'],
    ['a replacement character', 'before \uFFFD after'],
    ['a lone high surrogate', 'before \uD800 after'],
    ['a lone low surrogate', 'before \uDC00 after'],
    ['a control character', 'before \u001B[31m after'],
  ])('refuses the whole text for %s', async (_label, text) => {
    await expect(mask(text)).rejects.toBeInstanceOf(RedactionError)
    await expect(mask(text)).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('accepts tab, newline, carriage return, and astral characters', async () => {
    const text = 'a\tb\r\nc \u{1F600} d'
    expect(await mask(text)).toBe(text)
  })

  it('names the class of character and its offset, never the text', async () => {
    await expect(mask('abc\u0000def')).rejects.toThrow('text holds a NUL character at offset 3')
  })
})
