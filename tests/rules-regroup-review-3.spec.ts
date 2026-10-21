// Negatives and positives written apart from the rules, aimed at spaced `@`
// addresses with a closed TLD list. Every address is invented.
// The cases under "regressions" are spaced `@` false positives whose final
// label is in the list, so the keyword gate on the spaced form applies.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] })

async function mask(text: string): Promise<string> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

describe('spaced @ with a closed TLD list: unseen negatives', () => {
  it.each([
    '@ app.route("/")',
    '    @ pytest.fixture',
    'decorate with @ app.route',
    'git remote add origin git@github.com:acme/api.git',
    '@ media screen and (max-width: 600px)',
    '@ import url(theme.css);',
    'pkg @ https://github.com/org/pkg.git',
    'C = A.data @ B.data',
    'y = X.T @ model.coef_',
    // Julia: `@` is a macro sigil, matrix products use `*`.
    'y = @views model.W * x.us',
    '@ time model.fc(x.co)',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('spaced @ with a closed TLD list: regressions', () => {
  it.each([
    // numpy/PyTorch matrix products whose right-hand attribute is a listed label.
    'x = data.io @ weights.co',
    'y = layer.input @ proj.dev',
    'h = state.me @ cell.us',
    'out = attn.probs @ value.us',
    'recon = svd.us @ svd.de',
    'out = feats.ai @ head.app',
    'logits = hidden @ self.lm.co',
    // Shell prompts printed as `user @ host`.
    'deploy @ build01.acme.io:~$',
    'root @ web01.example.com #',
    // Prose and chat handles.
    'ping @ kevin.dev about it',
    'cc @ alice.me',
    'meet @ cafe.tw at 3',
    'follow us @ acme.co',
    'find us @ shop.tw',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})

describe('spaced @ with a closed TLD list: unseen positives', () => {
  it.each([
    ['wang.yichun＠gmail.com', '⟦EMAIL_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })
})

// Spaced `@` is not detected, so these spaced-`@` addresses are asserted unmasked.
describe('spaced @ is not detected', () => {
  it.each([
    'email: wang.yichun @ gmail.com',
    'E-mail: wang_yc @ company.com.tw',
    '信箱 lin_yating @ ntu.edu.tw',
    '電子郵件：chen.mei ＠ example.com.tw',
    'mail to huang.jy ＠ company.co',
    '聯絡 kevin.lin  @  startup.io',
    '寄到 lin.wei ＠ gmail.com',
  ])('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })
})
