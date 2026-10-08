import { describe, expect, it } from 'vitest'
import { Context } from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'
import RulesRedactionService from './shim.ts'
import { SessionSeq } from './shim.ts'

// Every credential below is invented for this suite; none is a working secret.
const service = new RulesRedactionService(new Context())

async function mask(text: string): Promise<string> {
  const result = await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
  return result.masked[0] ?? ''
}

// Values a credential rule must mask. Each is a whole line as a log or a source
// file writes it.
const mustMask = [
  'password=$ecret123',
  'password=$uper$ecret1',
  'password=P@ss(word)1',
  'password=abc<def>123',
  'password={brace}12',
  'password=my[pw]2026',
  'password=john.doe',
  'password=a.b.c.d',
  'PASSWORD=HUNTER_2_X',
  'SECRET=ABCDEF_123456',
  'api_key=KEY_1234567890AB',
  'DB_PASSWORD=$DB_PASSWORD_PROD',
  'password: my&pass',
  'API_KEY=MyToken123',
  'password=Summer2026!',
  'apikey: "Zm9vYmFyMTIzNA"',
  'refresh_token=rt_0123456789abcd',
  'client_secret = cs_abcdef012345',
  'Authorization: Bearer abcdef0123456789',
  'sid=session000001',
  'MY_TOKEN=abc123xyz789',
  'Cookie: sid=abcd1234efgh',
  'Set-Cookie: session=abcd1234; HttpOnly',
  'AKIAIOSFODNN7EXAMPLE',
  'ghp_0123456789abcdefghijklmnopqrstuvwx',
  'sk-abcdefghijklmnopqrstuvwx',
  'AIza0123456789abcdefghijklmnopqrstuvwxy',
  'xoxb-0123456789-abcdefghij',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27u',
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\n-----END OPENSSH PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIabc',
  '{"password":"hunter2"}',
  '{"secret":"hunter2"}',
  '"DEEPSEEK_API_KEY": "hunter2hunter2"',
  "'password' => 'hunter2'",
  'password := "hunter2"',
  'password=hunter2<3you',
  'password=abc(def',
  'password=a[b',
  'password=love{u',
  'password=getToken(x)',
  'password=config.prod2026',
  'PASSWORD=MY_SECRET_VALUE',
  'secret=Record<a>',
  'password=password',
  'password=PASSWORD',
  'api_key=api_key',
  'secretKey=abc12345',
  'secret_key=abc12345',
  'aws_secret_access_key = wJalrXUtnFEMI',
  'secret_key_base=abc12345',
  'secretAccessKey=abc12345',
  'SecretKey=abc12345',
  'secret-key=abc12345',
  'passwordForDb=hunter2',
  'password_hash=abc12345',
  'passwordHash=abc12345',
  'password=fn(a,b)',
  'password=auth.getToken(x)',
  'password=obj.method(arg)',
  'docker run -e PASSWORD=hunter2',
  'db_pass: hunter2',
  'DB_PASS: hunter2',
  'PASS=hunter2',
  'dbPass: hunter2',
  'db.pass: hunter2',
  'db-pass: hunter2',
  'DB-PASS: hunter2',
  'smtp-pass: hunter2',
  'ldap-bind-pass: hunter2',
  '--pass hunter2',
  'curl -u alice:s3cr3t https://x',
  'secret_id=abc12345',
  'VAULT_SECRET_ID=abc12345',
  'secret_text=abc12345',
  'password="a.b("',
  'password: "vi.fn(("',
  'password="Record<string,"',
  // A quoted value may escape its own quote.
  'password="a\\"b12"',
  // Key shapes the redaction core covers that the lists above do not reach.
  'session_id=abc12345',
  '金鑰 = abc12345',
  'curl --user alice:s3cr3t',
  'password=a.b<c>d',
  'password=a.b[c]d',
  'password=a.b(x){y}',
  '密碼：hunter2',
  'ssh://alice:s3cr3t@buildbox/repo',
  'hooks.slack.com/services/T0123456789/B0123456789/abcdefghij',
  // Weak passwords are still passwords.
  'password: admin',
  'password: changeme',
  'DB_PASSWORD=changeme',
  'password: 123456',
  'password: Tr0ub4dor&3',
  '{"password":"xxx123"}',
]

// Source and prose a credential rule must leave alone.
const mustKeep = [
  'password: string',
  'apiKey: z.string()',
  'token=process.env.TOKEN',
  'getSecret()',
  'ReadonlySet<string>',
  '${DB_PASSWORD}',
  'agent.session',
  'Record<string, string>',
  'secret: Buffer',
  "case 'secret':\n  return {",
  'sequenceDiagram\n  Session: opened',
  'Session: user joined',
  'token: TokenStream',
  'sid: number',
  'const password = config.password',
  'password: opts?.password',
  'apiKey: this.apiKey',
  'password: MAX_RETRIES',
  'const session = await x',
  'type SessionEventType = keyof X',
  'const SESSION_KEY: readonly string[]',
  'sessionId = request.id',
  'session = Session.create(SessionId(1))',
  'sid = craftSid(1',
  'password=Array<{',
  'password => validate(password)',
  'onChange={password => setPassword(password)}',
  'First pass: the actual output',
  'const sessionStore = new Map()',
  'tests pass: 12',
  '--- PASS: TestFoo (0.00s)',
  'PASS: test/foo.test.js',
  '// Pre-pass: package name to dir',
  'first-pass: collect',
  'resolveApiKey = vi.fn(() =>',
  'api_key = os.environ.get(',
  'password_reset_url=https://x.test/reset',
  'private_key_path=/etc/ssl/private.pem',
  'access_token_ttl=3600',
  'password_max_length=128',
  "'SECRET-READ: DENIED'",
  'run -u 1000:1000 img',
  'Cookie: 1/a/yes/ok/id/x=',
  'Cookie: short=1',
  'A Fortune Cookie: says hi',
  'password: Promise',
  'token=args.token',
  'token=MAX_RETRIES',
  'password=${DB_PASSWORD}',
  'Authorization: ....',
  'ssh://alice@buildbox/repo',
  '密碼：ab',
  '密碼："unclosed',
  '密碼：process.env.PASSWORD',
  // Attribute words name a property of a credential, not the credential.
  'password_default: None',
  'password_default=hunter2',
  'password_field: PasswordField',
  'password_field=hunter2',
  'apiKeyEnv: DEEPSEEK_API_KEY',
  'secretEnv: MY_SECRET_NAME',
  'token={a}',
  'secret=Record<string>',
  'password=my.camelCase',
  'password=my.auth',
  'password="unclosed',
  'MY_TOKEN=111111',
  // A Slack documentation URL is not an incoming-webhook URL.
  'see https://api.slack.com/messaging/webhooks',
  'password=a.b<c',
  'password=a.b[c',
  'password=a.b(x)[',
  'password=a.b(x)<',
  'password=a.b(x){',
  // Schema words, protocol roles and content types, type names, and masked spellings.
  ...[
    'required', 'Optional', 'example', 'placeholder', 'none', 'None', 'text', 'index', 'system', 'user',
    'assistant', 'tool', 'image', 'messages', 'content', 'str', 'int', 'float', '***', '********', 'xxx', 'XXXXXXXX', '<redacted>',
    '[REDACTED]', 'your-password', 'your_password', '...',
  ].flatMap(value => [
    `password: ${value}`, `{"password":"${value}"}`, `PASSWORD=${value}`, `Authorization: ${value}`, `密碼：${value}`,
  ]),
]

describe('credential rule', () => {
  it.each(mustMask)('masks %j', async (text) => {
    expect(await mask(text)).toContain('⟦KEY_')
  })

  it.each(mustKeep)('keeps %j', async (text) => {
    expect(await mask(text)).toBe(text)
  })

  // A `toContain('⟦KEY_')` assertion passes even when the rule masks the wrong
  // range, so every case whose exact boundary is the point is pinned here.
  it.each([
    // Trailing brackets that close nothing inside the value are not part of it.
    ['password=hunter2)', 'password=⟦KEY_1⟧)'],
    ['password=hunter2]', 'password=⟦KEY_1⟧]'],
    ['password=hunter2}', 'password=⟦KEY_1⟧}'],
    // Under a general key word the value ends at a query-string separator.
    ['token=abc123&x=1', 'token=⟦KEY_1⟧&x=1'],
    ['url?token=abcd1234&next=/home', 'url?token=⟦KEY_1⟧&next=/home'],
    // The webhook URL is the credential; the scheme is not part of it.
    [
      'webhook_url=https://hooks.slack.com/services/T0123456789/B0123456789/abcdefghij',
      'webhook_url=https://⟦KEY_1⟧',
    ],
  ])('masks exactly the value in %j', async (text, expected) => {
    expect(await mask(text)).toBe(expected)
  })

  it('binds the value as the text spells it, escape included', async () => {
    const source = '{"password":"hun\\"ter2"}'
    const result = await service.mask([{ seq: SessionSeq(1), path: '/a', text: source }], emptyRedactionIndex())
    expect(result.masked[0]).toBe('{"password":"⟦KEY_1⟧"}')
    expect(result.registry.originals()).toEqual(['hun\\"ter2'])
    const back = service.restore(result.masked[0] ?? '', result.registry)
    expect(back.ok && back.text).toBe(source)
  })

  it('masks a credential word written with separators where it sits, and nowhere else', async () => {
    // `s-e-c-r-e-t` normalizes to a credential word, so it is masked where the
    // rule found it but never propagated.
    const texts = ['password=s-e-c-r-e-t', 'later s-e-c-r-e-t again']
    const submitted = texts.map((text, at) => ({ seq: SessionSeq(at + 1), path: '/a', text }))
    const result = await service.mask(submitted, emptyRedactionIndex())
    expect(result.masked).toEqual(['password=⟦KEY_1⟧', 'later s-e-c-r-e-t again'])
  })

  it('leaves an allowlisted address alone and masks the rest', async () => {
    expect(await mask('git@github.com and alice@example.test')).toBe('git@github.com and ⟦EMAIL_1⟧')
    const narrowed = new RulesRedactionService(new Context(), { allowlist: [] })
    const result = await narrowed.mask([{ seq: SessionSeq(1), path: '/a', text: 'git@github.com' }], emptyRedactionIndex())
    expect(result.masked[0]).toBe('⟦EMAIL_1⟧')
  })
})
