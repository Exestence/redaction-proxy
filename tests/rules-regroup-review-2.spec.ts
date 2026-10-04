// WO-6 review round 2 (D3): negatives and positives the implementer did not
// see, aimed at the round-2 rules (email word before a bare ` at `, lower-case
// TLD and code-root guard on spaced forms). Every address is invented.
// The cases under "required fixes" fail at 0b31e32 by design: they are the
// round-2 FAIL findings and must pass before WO-6 merges.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] })

async function mask(text: string): Promise<string> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

describe('WO-6 review 2 D3: unseen negatives', () => {
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

describe('WO-6 review 2 D3: required fixes (red at 0b31e32)', () => {
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

describe('WO-6 review 2 D3: unseen positives', () => {
  it.each([
    ['email: wang.yichun at example.com', 'email: ⟦EMAIL_1⟧'],
    ['my e-mail is chen.mei at gmail.com', 'my e-mail is ⟦EMAIL_1⟧'],
    ['電子郵件 lin.wei at company.com.tw', '電子郵件 ⟦EMAIL_1⟧'],
    ['E-mail：lin_yating AT ntu.edu.tw', 'E-mail：⟦EMAIL_1⟧'],
    ['wang.yichun(at)gmail(dot)com', '⟦EMAIL_1⟧'],
    ['john.doe(at)gmail[dot]com', '⟦EMAIL_1⟧'],
    ['chen_mei [at] ntu.edu.tw', '⟦EMAIL_1⟧'],
    ['lin.wei＠example.com.tw', '⟦EMAIL_1⟧'],
    ['信箱：wang.yichun ＠ gmail.com', '信箱：⟦EMAIL_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })
})
