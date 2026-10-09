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
const DEFAULT_DIGEST = 'sha256:2e02d33a356f25bd3b258d00a19728d837d8be95e1bb1c46422e0a67828c674d'

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
    expect(new RulesDetector({ rules: [...EXTENDED_RULE_NAMES] }).categories).toEqual(['CARD', 'ENTROPY', 'KEY', 'HOST', 'TWID', 'PHONE', 'EMAIL', 'IP'])
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
    'pay 41 1111 111 1111 111 now',
    'pay 41111-11111-111111 now',
    'pay 4111.1111.1111.1111 now',
    'pay 4111 1111-1111 1111 now',
    'pay 41.1111.111.1111.111 now',
    'pay 4111 - 1111 - 1111 - 1111 now',
    'pay 4111 1111\n    1111 1111 now',
    'pay 41111111\n11111111 now',
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
    // Luhn-valid as one 20-digit run, so only the length bound leaves it alone.
    ['a card grouping extended by one more group', '4111 1111 1111 1111 1230'],
    ['the run the default rule slides a window over', 'id 14111111111111111 here'],
    ['a nanosecond timestamp', 'ts=1758000000000000000 level=info'],
    ['the fraction of a decimal number', '{"x":1432.4982166290283,"y":93.78770156095185}'],
    // 4432.1234567890129 is Luhn-valid as one 17-digit run.
    ['a decimal number with a card prefix', '{"x":4432.1234567890129}'],
    ['a version with a one-digit part', 'release 4.1.11111111111111'],
    ['a column of numbers over more than one line break', '4111\n1111\n1111\n1111'],
    // Each run below is Luhn-valid as one number with a card prefix.
    ['a latitude and longitude pair', 'at 45.123456 -18.636239 now'],
    ['two IPv4 addresses', 'from 55.51.129.143 62.43.181.28'],
    ['money with space thousands and cents', 'total 54 477 295 848.94'],
    ['a dotted date range', 'vom 43.10.2026 - 27.10.2022'],
    ['dotted groups mixed with another separator', 'pay 4111 1111-1111.1111 now'],
    ['a hexdump row of more than six groups', '00000010  43 41 42 43 44 45 46 42'],
    ['a card regrouped into more than six groups', 'pay 41 11 11 11 11 11 11 11 now'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['card-strict'], text)).toBe(text)
  })

  it('reads a card right after a high escape', async () => {
    expect(await maskWith(['card-strict'], '?q=%E65454-5454-5454-5454')).toBe('?q=%E6⟦CARD_1⟧')
    expect(await maskWith(['card-strict'], '?q=%E65454.5454.5454.5454')).toBe('?q=%E6⟦CARD_1⟧')
  })

  it('masks a regrouped card as one whole run', async () => {
    expect(await maskWith(['card-strict'], 'pay 4111 1111\n1111 1111 now')).toBe('pay ⟦CARD_1⟧ now')
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
    `uses: actions/checkout@${sha1} # v4`,
  ])('leaves a digest keyed by a file name or pinned after @ alone in %j', async (text) => {
    expect(await maskWith(['entropy-strict'], text)).toBe(text)
  })

  it('masks a bare run, a run keyed by anything else, and a run beside a credential word', async () => {
    expect(await maskWith(['entropy-strict'], `value ${sha1} end`)).toBe('value ⟦ENTROPY_1⟧ end')
    expect(await maskWith(['entropy-strict'], `build: ${sha1}`)).toBe('build: ⟦ENTROPY_1⟧')
    expect(await maskWith(['entropy-strict'], `x@${sha256}`)).toBe('x@⟦ENTROPY_1⟧')
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
    'SK0123456789abcdef0123456789ABCDEF',
    'sq0atp-AbCdEfGhIjKlMnOpQrStUv',
    `EAAA${'AbCdEfGhIjKlMnOpQrSt'.repeat(3)}`,
    'glsa_AbCdEfGhIjKlMnOpQrStUvWxYz012345_0a1b2c3d',
    'glc_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==',
    'dapi0123456789abcdef0123456789abcdef',
    'dapi0123456789abcdef0123456789abcdef-2',
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
    ['a vendor prefix on a value of the wrong length or alphabet', 'SK0123456789abcdef dapi0123456789abcdefXYZ glsa_short_0a1b2c3d'],
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
    ["the password is 'Hunter22!'", "the password is '⟦KEY_1⟧'"],
    ['the passcode is 482913', 'the passcode is ⟦KEY_1⟧'],
    ['密码是 abc12345，密碼: abc12346', '密码是 ⟦KEY_1⟧，密碼: ⟦KEY_2⟧'],
    ['パスワードは abc12345 です', 'パスワードは ⟦KEY_1⟧ です'],
    ['비밀번호 abc12345, 비밀번호는 abc12346', '비밀번호 ⟦KEY_1⟧, 비밀번호는 ⟦KEY_2⟧'],
    ['Passwort: abc12345, Passwort ist abc12346', 'Passwort: ⟦KEY_1⟧, Passwort ist ⟦KEY_2⟧'],
    ['mot de passe : abc12345', 'mot de passe : ⟦KEY_1⟧'],
    ['contraseña: abc12345, senha é abc12346', 'contraseña: ⟦KEY_1⟧, senha é ⟦KEY_2⟧'],
    ['{"密碼": "hunter0x"}', '{"密碼": "⟦KEY_1⟧"}'],
    ['{"令牌": "abc123", \'金鑰\': \'xyz789\'}', '{"令牌": "⟦KEY_1⟧", \'金鑰\': \'⟦KEY_2⟧\'}'],
    [`{"jwt": "${token}"}`, '{"jwt": "⟦KEY_1⟧"}'],
    [`jwt: ${token}`, 'jwt: ⟦KEY_1⟧'],
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
    ['a quoted CJK key with a code value', '{"密碼": "config.password"}'],
    ['a quoted key whose value is no credential', '{"jwt": "required", "token": "some-config-name"}'],
    ['a short value after a general word', 'token Ab3dEf9h'],
    ['a URL', 'key https://example.com/Zq8xT2vK9mN4pL7wR3sYuB1'],
    ['a date or a version after a password word', 'pw 2026-10-07 expires, passcode: 1.2.3.4, Passwort: 2026-10-07'],
    ['prose after a password word in another language', '密码是错误的，请重试。Passwort vergessen? mot de passe oublié, パスワードを変更してください'],
    ['prose in another script after a password word', 'Token Password 以静态形式被读取。passwd 条目解析沙箱用户的登录主目录，以'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['credential-phrase'], text)).toBe(text)
  })
})

describe('tw-national-id-loose', () => {
  it.each([
    ['身分證 a123456789', '身分證 ⟦TWID_1⟧'],
    ['ID A1234\u00a056789.', 'ID ⟦TWID_1⟧.'],
    ['ID A\u202f123456789', 'ID ⟦TWID_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(['tw-national-id-loose'], text)).toBe(expected)
  })

  it.each([
    ['a lower-case letter with a bad checksum', 'id a123456780'],
    ['a plain space at a split the default rule does not read', 'id A1234 56789'],
    ['a longer token', 'xa123456789 a1234567890'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['tw-national-id-loose'], text)).toBe(text)
  })
})

describe('tw-passport-nhi', () => {
  it.each([
    ['護照 312345678', '護照 ⟦TWID_1⟧'],
    ['Passport No. 312345678', 'Passport No. ⟦TWID_1⟧'],
    ['passport number is 312345678', 'passport number is ⟦TWID_1⟧'],
    ['passport #: 312345678', 'passport #: ⟦TWID_1⟧'],
    ['passport_number=312345678', 'passport_number=⟦TWID_1⟧'],
    ['passport number 312-345-678', 'passport number ⟦TWID_1⟧'],
    ['健保卡號：0000 1234 5678', '健保卡號：⟦TWID_1⟧'],
    ['健保卡 000012345678', '健保卡 ⟦TWID_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(['tw-passport-nhi'], text)).toBe(expected)
  })

  it.each([
    ['nine digits without a keyword', 'order 312345678'],
    ['twelve digits without a keyword', 'trace 0000 1234 5678'],
    ['a longer number after the keyword', '護照 3123456789'],
    ['mixed or longer hyphen groups after the keyword', 'passport 312-345678 and passport 312-345-678-9'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['tw-passport-nhi'], text)).toBe(text)
  })
})

describe('tw-mobile-loose', () => {
  it.each([
    ['打 0912.345.678', '打 ⟦PHONE_1⟧'],
    ['打 0912／345／678', '打 ⟦PHONE_1⟧'],
    ['打 ０９１２．３４５．６７８', '打 ⟦PHONE_1⟧'],
    ['call 0912/345/678.', 'call ⟦PHONE_1⟧.'],
    ['打 0912_345_678', '打 ⟦PHONE_1⟧'],
    ['打 (0912)345678', '打 ⟦PHONE_1⟧'],
    ['打 (0912) 345-678', '打 ⟦PHONE_1⟧'],
    ['打 (0912)-345-678', '打 ⟦PHONE_1⟧'],
    ['打 (0912) 345 678', '打 ⟦PHONE_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(['tw-mobile-loose'], text)).toBe(expected)
  })

  it.each([
    ['versions, dates, and addresses', 'v1.2.3 on 2026.10.08 at 10.0.0.1'],
    ['a longer dotted run', '0912.345.678.9 and 10912.345.678'],
    ['mixed separators', '0912.345/678'],
    ['snake-case identifiers and longer underscored runs', 'v1_2_3 x_0912_345_678 0912_345_678_9 0912_345_6789'],
    ['a longer bracketed run', '(0912)3456789'],
    ['a bracketed run of other lengths', '(0912) 345 6789 (0912) 2026 (0912) 345 678 9'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['tw-mobile-loose'], text)).toBe(text)
  })
})

describe('email-escaped', () => {
  it.each([
    ['mail lin&#64;example.test', 'mail ⟦EMAIL_1⟧'],
    ['mail lin&#x40;example.test', 'mail ⟦EMAIL_1⟧'],
    ['{"to":"lin\\u0040example.test"}', '{"to":"⟦EMAIL_1⟧"}'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(['email-escaped'], text)).toBe(expected)
  })

  it.each([
    ['an escape without a local part', 'at &#64;example.test'],
    ['an escape without a domain', 'lin&#64; and lin\\u0040x'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['email-escaped'], text)).toBe(text)
  })
})

describe('ip-cgnat-ula', () => {
  it.each([
    ['host 100.64.1.2', 'host ⟦IP_1⟧'],
    ['host 100.127.255.254', 'host ⟦IP_1⟧'],
    ['host fd12:3456:789a::1', 'host ⟦IP_1⟧'],
    ['route fc00::1/7', 'route ⟦IP_1⟧/7'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(['ip-cgnat-ula'], text)).toBe(expected)
  })

  it.each([
    ['addresses outside 100.64.0.0/10', '100.63.1.2 100.128.1.2 100.64.1.256'],
    ['a MAC address', 'mac fd:12:34:56:78:9a'],
    ['a public IPv6 address', '2001:db8::1'],
    ['a hash holding fd12', 'sha 0afd1234abcd'],
    ['a network prefix', 'ULAs live in fc00::/7; ours is fd12:3456:789a::/48'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(['ip-cgnat-ula'], text)).toBe(text)
  })
})

describe('pathological inputs to the extended rules', () => {
  const SIZE = 200 * 1024
  it.each([
    '4111 ', '4111-', '4111 1111-', '..4111', 'a4111', 'README.md: ', `a.md: ${'0123456789abcdef'.repeat(2)}01234567 `,
    '.corp', 'a.corp.b', '.home.arpa.', 'com.a.corp.', 'glpat-', 'SG.aaaaaaaaaaaaaaaa.', 'eyJaaaaaaaaaa.aa.',
    'sig=', 'AccountKey=', '1234567890:AA', 'token ', 'key is ', 'password: ', 'pw ', 'token is is ', ' \t',
    'a1234\u00a0', '護照 ', '健保卡 0000 ', '0912.345.', 'a&#64;', 'a\\u0040', '100.64.1.', 'fd12:', '"密碼": ',
  ])('masks 200KB of %j within 2s of CPU time', async unit => {
    const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
    const started = process.cpuUsage()
    await mask(new RulesDetector({ rules: [...EXTENDED_RULE_NAMES] }), [{ seq: 1, path: '', text }], emptyRedactionIndex())
    const used = process.cpuUsage(started)
    expect((used.user + used.system) / 1_000).toBeLessThan(2_000)
  })
})
