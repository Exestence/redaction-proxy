// A stray high escape (`%E6`, `%FF`, `%c0`) right before a value is a left
// boundary for the rules with an ASCII left boundary (WO-9b): telephone,
// identification, business and card numbers, private addresses, and token
// prefixes. Every value is invented.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), {})

async function roundTrip(...texts: string[]): Promise<{ masked: string[]; restored: (string | false)[] }> {
  const result = await service.mask(
    texts.map((text, i) => ({ seq: SessionSeq(i + 1), path: '/content/0/text', text })),
    emptyRedactionIndex(),
  )
  const restored = result.masked.map((masked) => {
    const back = service.restore(masked, result.registry)
    return back.ok && back.text
  })
  return { masked: result.masked, restored }
}

describe('a high escape before a value is a left boundary', () => {
  it.each([
    ['?q=%FF0912-345-678', '?q=%FF⟦PHONE_1⟧'],
    ['?q=%E60912345678', '?q=%E6⟦PHONE_1⟧'],
    ['?q=%c0%2B886%20912%20345%20678', '?q=%c0⟦PHONE_1⟧'],
    ['?q=%E6A123456789', '?q=%E6⟦TWID_1⟧'],
    ['?q=%e6F%20222333444', '?q=%e6⟦TWID_1⟧'],
    ['?q=tax%20id%20%E612345678', '?q=tax%20id%20%E6⟦TAXID_1⟧'],
    ['?q=%E7%B5%B1%E7%B7%A8%c012345678', '?q=%E7%B5%B1%E7%B7%A8%c0⟦TAXID_1⟧'],
    ['?q=%E65454%205454%205454%205454', '?q=%E6⟦CARD_1⟧'],
    ['?q=%E65454-5454-5454-5454', '?q=%E6⟦CARD_1⟧'],
    ['?q=%E66011000000000004', '?q=%E6⟦CARD_1⟧'],
    ['?q=%c0192.168.1.20', '?q=%c0⟦IP_1⟧'],
    ['?q=%E610.20.30.40&x=1', '?q=%E6⟦IP_1⟧&x=1'],
    ['?q=%c0sk-proj-Ab3dEf0123456789XyZw', '?q=%c0⟦KEY_1⟧'],
    ['?q=%E6ghp_Ab3dEf0123456789XyZwQrSt', '?q=%E6⟦KEY_1⟧'],
    ['?q=%FFAKIAABCDEFGHIJ234567', '?q=%FF⟦KEY_1⟧'],
  ])('masks %j and restores it byte for byte', async (text, expected) => {
    const { masked, restored } = await roundTrip(text)
    expect(masked[0]).toBe(expected)
    expect(restored[0]).toBe(text)
  })

  it('propagates a value to an occurrence right after a high escape', async () => {
    const { masked, restored } = await roundTrip('password = Xk9fQ2mZ7pL4wR', 'see %E6Xk9fQ2mZ7pL4wR')
    expect(masked).toEqual(['password = ⟦KEY_1⟧', 'see %E6⟦KEY_1⟧'])
    expect(restored).toEqual(['password = Xk9fQ2mZ7pL4wR', 'see %E6Xk9fQ2mZ7pL4wR'])
  })

  it('keeps masking a value after an escape that ends in a letter, as before', async () => {
    const { masked } = await roundTrip('?q=%FF4111%201111%201111%201111')
    expect(masked[0]).toBe('?q=%FF⟦CARD_1⟧')
  })

  it('still does not propagate into a longer token after a low escape', async () => {
    const { masked } = await roundTrip('password = Xk9fQ2mZ7pL4wR', 'see %41Xk9fQ2mZ7pL4wR')
    expect(masked[1]).toBe('see %41Xk9fQ2mZ7pL4wR')
  })

  it.each([
    // A 12-digit order number and a 16-digit run that fails Luhn.
    'https://shop.example.org/order?id=%E6202610051234',
    'https://shop.example.org/order?id=%E64111111111111112',
    // `%41%42` decodes to the letters `AB`, which are part of the token.
    'https://example.org/?q=%41%420912345678',
    'https://example.org/?q=%41%42A123456789',
    // Analytics hits with stray bytes beside counters and timestamps.
    'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1234567890.1696500000&ul=%E6&_s=12&_p=1696500000123&dt=%E6%96%B0%E8%81%9E%20%7C%20Example&sr=1920x1080',
    'https://px.example.net/p.gif?e=view&ts=%FF1696500000123&s=%E6%96%B0&r=%FE20261005',
    // Binary-ish escape runs followed by digits that are no value.
    'data:image/jpeg,%FF%D8%FF%E0%00%10JFIF%00%01%01%00%00%01%00%01%00%00%FF%DB%00C%00%08%06%06',
    '?blob=%FF%D8%FF%E01234567890123%FF%D920261005',
  ])('leaves %j unmasked', async (text) => {
    const { masked } = await roundTrip(text)
    expect(masked[0]).toBe(text)
  })
})
