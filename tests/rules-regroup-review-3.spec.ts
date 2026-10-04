// WO-6 review round 3 (fresh D3 under amendment R3): negatives and positives
// the implementer did not see, aimed at the spaced `@` rule with its closed
// TLD list. Every address is invented.
// The cases under "required fixes" fail at c94e1f3 by design and pass on
// origin/main: each is a spaced `@` false positive whose final label is in
// the list, so amendment R3 step 6 (keyword gate on the spaced form) applies.
import { describe, expect, it } from 'vitest'
import { Context, SessionSeq } from './shim.ts'
import RulesRedactionService from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'

const service = new RulesRedactionService(new Context(), { terms: ['星河計畫'], projectNames: ['NIMBUS-7'] })

async function mask(text: string): Promise<string> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

describe('WO-6 review 3 D3: unseen negatives', () => {
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

describe('WO-6 review 3 D3: required fixes (red at c94e1f3)', () => {
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

describe('WO-6 review 3 D3: unseen positives (each carries an amendment keyword)', () => {
  it.each([
    ['email: wang.yichun @ gmail.com', 'email: ⟦EMAIL_1⟧'],
    ['E-mail: wang_yc @ company.com.tw', 'E-mail: ⟦EMAIL_1⟧'],
    ['信箱 lin_yating @ ntu.edu.tw', '信箱 ⟦EMAIL_1⟧'],
    ['電子郵件：chen.mei ＠ example.com.tw', '電子郵件：⟦EMAIL_1⟧'],
    ['mail to huang.jy ＠ company.co', 'mail to ⟦EMAIL_1⟧'],
    ['聯絡 kevin.lin  @  startup.io', '聯絡 ⟦EMAIL_1⟧'],
    ['寄到 lin.wei ＠ gmail.com', '寄到 ⟦EMAIL_1⟧'],
    ['wang.yichun＠gmail.com', '⟦EMAIL_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })
})
