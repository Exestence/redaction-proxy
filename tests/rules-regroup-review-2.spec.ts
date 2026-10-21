// Negatives and positives written apart from the rules, aimed at obfuscated
// addresses (email word before a bare ` at `, lower-case TLD and code-root
// guard on spaced forms). Every address is invented.
// The cases under "regressions" are earlier misses and false positives.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] })

async function mask(text: string): Promise<string> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

describe('obfuscated addresses: unseen negatives', () => {
  it.each([
    'contact the team at github.com/issues',
    'email me at noon',
    'contact info for vue.router at github.com',
    'Email support. Next, deploy web.app at firebase.google.com',
    '我在 mail.google.com at noon',
    '// read user.mail at startup',
    '# sync contact.list at api.example.com nightly',
    '    @ property',
    'y = x @ y.T',
    "I'm @ home.tw all day",
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('obfuscated addresses: regressions', () => {
  it.each([
    // An email word before `<dotted product> at <site>`: prose, not an address.
    'If it keeps failing, contact fly.io at community.fly.io',
    'Contact socket.io at github.com/socketio for help',
    '請聯絡 socket.io at github.com 的維護者',
    '聯絡我們 ASP.NET at microsoft.com',
    '有問題請聯絡我們，或到 socket.io at github.com 開 issue',
    'Thanks for the email, socket.io at github.com fixed it',
    // ASCII `.` ends a sentence; `mail` inside `Gmail` and `mailing` is not an email word.
    'I read my email. Socket.io at github.com is down again.',
    'Gmail users: socket.io at github.com has notes',
    'Ask on the mailing list of socket.io at github.com',
    // Spaced `@` matrix products with a two-letter lower-case attribute.
    'z = layer.weight @ state.dx',
    'grad = jac.T @ err.dy',
    'y = enc.out @ dec.wq',
    'x_hat = basis.vecs @ coef.ab',
    'loss = pred.y @ batch.mu',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('obfuscated addresses: unseen positives', () => {
  it.each([
    ['wang.yichun(at)gmail(dot)com', '⟦EMAIL_1⟧'],
    ['john.doe(at)gmail[dot]com', '⟦EMAIL_1⟧'],
    ['chen_mei [at] ntu.edu.tw', '⟦EMAIL_1⟧'],
    ['lin.wei＠example.com.tw', '⟦EMAIL_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })
})

// The bare ` at ` form is not detected (prose is lexically identical to
// an address), so these addresses are asserted unmasked.
describe('bare at is not detected', () => {
  it.each([
    'email: wang.yichun at example.com',
    'my e-mail is chen.mei at gmail.com',
    '電子郵件 lin.wei at company.com.tw',
    'E-mail：lin_yating AT ntu.edu.tw',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

// Spaced `@` is not detected, so these spaced-`@` addresses are asserted unmasked.
describe('spaced @ is not detected', () => {
  it.each([
    '信箱：wang.yichun ＠ gmail.com',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})
