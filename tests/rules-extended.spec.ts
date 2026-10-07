// Extended rules: opt-in widenings of the default host and credential rules,
// and strict variants of the card and entropy rules. Every credential below is
// random text in a vendor's documented format; every card is a published test
// number.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULE_NAMES,
  DETECTOR_VERSION,
  EXTENDED_RULE_NAMES,
  RulesDetector,
  emptyRedactionIndex,
  mask,
  restore,
} from '../src/core/index.ts'
import type { RedactionRuleName } from '../src/core/index.ts'

/** Policy digest of the default rules, which hosts persist with their span index. */
const DEFAULT_DIGEST = 'sha256:49cba7ce69b8961ec8f8e056240beb401c8b8eba1d2f98a4a4e16460712239ff'

async function maskWith(rules: RedactionRuleName[], text: string): Promise<string> {
  const result = await mask(new RulesDetector({ rules }), [{ seq: 1, path: '', text }], emptyRedactionIndex())
  const back = restore(result.masked[0] ?? '', result.registry)
  expect(back.ok && back.text).toBe(text)
  return result.masked[0] ?? ''
}

describe('extended rule configuration', () => {
  it('leaves the default detector version and digest alone and versions a detector with any extended rule', () => {
    expect(new RulesDetector().policyDigest).toBe(DEFAULT_DIGEST)
    const withHost = new RulesDetector({ rules: [...DEFAULT_RULE_NAMES, 'private-host'] })
    expect(withHost.detectorVersion).toBe(`${DETECTOR_VERSION}+ext-1`)
    expect(withHost.policyDigest).not.toBe(DEFAULT_DIGEST)
    expect(new RulesDetector({ rules: ['iban', 'token-format'] }).detectorVersion).toBe(`${DETECTOR_VERSION}+intl-2+ext-1`)
    expect(new RulesDetector({ rules: [...EXTENDED_RULE_NAMES] }).categories).toEqual(['CARD', 'ENTROPY', 'KEY', 'HOST'])
  })
})

describe('card-strict', () => {
  it.each([
    'pay 4111111111111111 now',
    'pay 4111 1111 1111 1111 now',
    'pay 4111-1111-1111-1111 now',
    'pay 378282246310005 now',
    'pay 3782 822463 10005 now',
    'pay 04111111111111111 now',
    'card 4111 1111 1111 1111 exp 2026',
  ])('masks the card in %j', async (text) => {
    expect(await maskWith(['card-strict'], text)).toContain('⟦CARD_1⟧')
  })

  it('masks each card of a list', async () => {
    expect(await maskWith(['card-strict'], 'cards 4111111111111111 5555555555554444'))
      .toBe('cards ⟦CARD_1⟧ ⟦CARD_2⟧')
  })

  it.each([
    ['groups joined by mixed separators', 'ports 8000 5259-6589 0921-9030'],
    ['a numeric UUID', 'id 123-4567-8901-4111-111111111111'],
    ['a revision range', 'fix a1b2c3d..4111111111 111111 and abc12..4111111111111111'],
    ['digits glued to a letter or `_`', 'x4111111111111111 4111111111111111_x'],
    ['a card grouping extended by one more group', '4111 1111 1111 1111 1234'],
    ['the run the default rule slides a window over', 'id 14111111111111111 here'],
    ['a nanosecond timestamp', 'ts=1758000000000000000 level=info'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['card-strict'], text)).toBe(text)
  })

  it('reads a card right after a high escape', async () => {
    expect(await maskWith(['card-strict'], '?q=%E65454-5454-5454-5454')).toBe('?q=%E6⟦CARD_1⟧')
  })

  it('leaves the default card rule as it was', async () => {
    expect(await maskWith(['card'], 'ports 8000 5259-6589 0921-9030')).not.toBe('ports 8000 5259-6589 0921-9030')
  })
})

describe('entropy-strict', () => {
  const sha1 = '0123456789abcdef0123456789abcdef01234567'
  const sha256 = `${sha1}0123456789abcdef01234567`

  it.each([
    `README.md: ${sha1}`,
    `  docs/guide.zh.md: "${sha256}"`,
    `+README.ja.md: ${sha1}`,
    `-docs/x.md: ${sha1}`,
  ])('leaves a digest keyed by a file name alone in %j', async (text) => {
    expect(await maskWith(['entropy-strict'], text)).toBe(text)
  })

  it('masks a bare run, a run keyed by anything else, and a run beside a credential word', async () => {
    expect(await maskWith(['entropy-strict'], `value ${sha1} end`)).toBe('value ⟦ENTROPY_1⟧ end')
    expect(await maskWith(['entropy-strict'], `build: ${sha1}`)).toBe('build: ⟦ENTROPY_1⟧')
    expect(await maskWith(['entropy-strict'], `token.txt: ${sha1}`)).toBe('token.txt: ⟦KEY_1⟧')
  })

  it('leaves the default entropy rule as it was', async () => {
    expect(await maskWith(['entropy'], `README.md: ${sha1}`)).toBe('README.md: ⟦ENTROPY_1⟧')
  })
})

describe('private-host', () => {
  it.each([
    ['host db-1.corp is down', 'host ⟦HOST_1⟧ is down'],
    ['connect to nas.home.arpa', 'connect to ⟦HOST_1⟧'],
    ['ci.intra, git.intranet, box.localdomain', '⟦HOST_1⟧, ⟦HOST_2⟧, ⟦HOST_3⟧'],
    ['open https://jenkins.corp.example.com:8080/job', 'open https://⟦HOST_1⟧:8080/job'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(['private-host'], text)).toBe(expected)
  })

  it.each([
    ['a reverse-domain package', 'import com.acme.intra.Billing;'],
    ['a file name', 'see settings.corp.yaml'],
    ['a namespace', 'Contoso.Corp.Billing'],
    ['a code member', 'this.corp and ctx.intranet'],
    ['a call', 'x = svc.corp(1)'],
    ['a suffix the rule leaves out', 'user.home and this.private'],
    ['a bare suffix', 'the .corp suffix'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['private-host'], text)).toBe(text)
  })
})

describe('token-format', () => {
  it.each([
    'glpat-AbCdEfGhIjKl1234567890',
    'sk_live_51HxYzAbCdEfGhIjKlMnOp',
    'rk_test_51HxYzAbCdEfGhIjKlMnOp',
    'whsec_AbCdEfGhIjKl123456',
    'SG.AbCdEfGhIjKlMnOpQrSt.UvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvW',
    'hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567',
    'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'xapp-1-A0123BCD-0123456789-abcdef',
    'shpat_0123456789abcdef0123456789abcdef',
    `dop_v1_${'0123456789abcdef'.repeat(4)}`,
    'ATATT3xFfGF0AbCdEfGhIjKlMnOpQrSt',
    '123456789:AAAbCdEfGhIjKlMnOpQrStUvWxYz0123456',
    'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.e30.abc',
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.',
  ])('masks %j', async (text) => {
    expect(await maskWith(['token-format'], `use ${text} here`)).toBe('use ⟦KEY_1⟧ here')
  })

  it('masks the value of an Azure key field', async () => {
    expect(await maskWith(['token-format'], 'AccountName=x;AccountKey=AbCdEf1234567890GhIjKlMnOpQr==;Suffix=y'))
      .toBe('AccountName=x;AccountKey=⟦KEY_1⟧;Suffix=y')
    expect(await maskWith(['token-format'], '?sv=2021-08-06&sig=AbCdEf1234567890GhIjKl%3D'))
      .toBe('?sv=2021-08-06&sig=⟦KEY_1⟧')
  })

  it.each([
    ['a publishable Stripe key', 'pk_live_51HxYzAbCdEfGhIjKlMnOp'],
    ['a short prefix lookalike', 'hf_short glpat-short sk_live_short'],
    ['a prefix inside a word', 'xsk_live_51HxYzAbCdEfGhIjKlMnOp'],
    ['a short SAS field', 'sig=abc'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['token-format'], text)).toBe(text)
  })
})

describe('credential-phrase', () => {
  const token = 'Zq8xT2vK9mN4pL7wR3sYuB1'

  it.each([
    [`Use token ${token} for the call`, 'Use token ⟦KEY_1⟧ for the call'],
    [`here is my key: ${token}`, 'here is my key: ⟦KEY_1⟧'],
    [`the secret is ${token}.`, 'the secret is ⟦KEY_1⟧.'],
    [`my API key was ${token}`, 'my API key was ⟦KEY_1⟧'],
    ['access token 0123456789abcdef0123', 'access token ⟦KEY_1⟧'],
    ['the password is hunter2!x', 'the password is ⟦KEY_1⟧'],
    ['pw: Tr0ub4dor&3', 'pw: ⟦KEY_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(['credential-phrase'], text)).toBe(expected)
  })

  it.each([
    ['prose without a value', 'the password is required and the token is valid'],
    ['a word value', 'primary key user_id_2026, key: some-config-name-v2'],
    ['a timestamp', 'the token expires at 2026-10-07T12:00:00Z'],
    ['an environment reference', 'api key is $OPENAI_API_KEY, password is ${DB_PASSWORD}'],
    ['a resource path', 'secret: projects/123/secrets/db/versions/1'],
    ['an address', 'key 0x7f3a9b2c4d5e6f708192a3b4'],
    ['a member chain', 'token: process.env.GITHUB_TOKEN_2'],
    ['a call', 'key = getKey(config2)'],
    ['a shell variable', 'HOME=$PWD path=$bin:PATH'],
    ['a member or a flag', 'this.key Zq8xT2vK9mN4pL7wR3sYuB1 --password hunter2!x'],
    ['an assignment, which the api-key rule reads', 'token=Zq8xT2vK9mN4pL7wR3sYuB1'],
    ['a short value after a general word', 'token Ab3dEf9h'],
    ['a URL', 'key https://example.com/Zq8xT2vK9mN4pL7wR3sYuB1'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['credential-phrase'], text)).toBe(text)
  })
})

describe('pathological inputs to the extended rules', () => {
  const SIZE = 200 * 1024
  it.each([
    '4111 ', '4111-', '4111 1111-', '..4111', 'a4111', 'README.md: ', `a.md: ${'0123456789abcdef'.repeat(2)}01234567 `,
    '.corp', 'a.corp.b', '.home.arpa.', 'com.a.corp.', 'glpat-', 'SG.aaaaaaaaaaaaaaaa.', 'eyJaaaaaaaaaa.aa.',
    'sig=', 'AccountKey=', '1234567890:AA', 'token ', 'key is ', 'password: ', 'pw ', 'token is is ', ' \t',
  ])('masks 200KB of %j within 2s of CPU time', async unit => {
    const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
    const started = process.cpuUsage()
    await mask(new RulesDetector({ rules: [...EXTENDED_RULE_NAMES] }), [{ seq: 1, path: '', text }], emptyRedactionIndex())
    const used = process.cpuUsage(started)
    expect((used.user + used.system) / 1_000).toBeLessThan(2_000)
  })
})
