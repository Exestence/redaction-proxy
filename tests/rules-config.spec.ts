import { describe, expect, it } from 'vitest'
import { Context } from './shim.ts'
import { emptyRedactionIndex } from '../src/core/index.ts'
import RulesRedactionService from './shim.ts'
import { isTaiwanNationalId, resolveRulesConfig } from '../src/core/index.ts'
import { SessionSeq } from './shim.ts'

// Fictional corpus: example.test domain, a made-up key, a made-up home path,
// checksum-valid identification numbers generated for tests, and invented names.
const CORPUS = {
  email: 'chen.fictional+qa@example.test',
  key: 'sk-FICTIONALfictional0123456789abcd',
  github: `ghp_${'F'.repeat(36)}`,
  path: '/Users/fictional-user/projects/secret-plan.md',
  twid: 'A123456789',
  name: '林小明',
}

async function maskOne(service: RulesRedactionService, value: string): Promise<string> {
  const [masked] = (await service.mask([{ seq: SessionSeq(1), path: '/content/0/text', text: value }], emptyRedactionIndex())).masked
  return masked ?? ''
}

describe('RulesRedactionService', () => {
  it('masks every corpus category and leaves no original in the output', async () => {
    const service = new RulesRedactionService(new Context(), { terms: [CORPUS.name] })
    const source = `我是${CORPUS.name}，信箱 ${CORPUS.email}，金鑰 ${CORPUS.key} 與 ${CORPUS.github}，檔案 ${CORPUS.path}，身分證 ${CORPUS.twid}。`

    const masked = await maskOne(service, source)

    // A home path masks its prefix only, so the directory structure survives the summary.
    expect(masked).toBe('我是⟦TERM_1⟧，信箱 ⟦EMAIL_1⟧，金鑰 ⟦KEY_1⟧ 與 ⟦KEY_2⟧，檔案 ⟦PATH_1⟧/projects/secret-plan.md，身分證 ⟦TWID_1⟧。')
    for (const value of [CORPUS.email, CORPUS.key, CORPUS.github, CORPUS.twid, CORPUS.name]) {
      expect(masked).not.toContain(value)
    }
    expect(masked).not.toContain('fictional-user')
    expect(service.detectorVersion).toBe('rules-8')
    expect(service.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('masks a home path in any spelling and after a preceding directory', async () => {
    const service = new RulesRedactionService(new Context(), { rules: ['user-path'] })
    expect(await maskOne(service, '/Users/a/x /users/a/x /USERS/a/x')).toBe('⟦PATH_1⟧/x ⟦PATH_2⟧/x ⟦PATH_3⟧/x')
    expect(await maskOne(service, 'ls /Volumes/Backup/Users/alice')).toBe('ls /Volumes/Backup⟦PATH_1⟧')
    expect(await maskOne(service, 'C:\\Users\\bob\\notes')).toBe('⟦PATH_1⟧\\notes')
    expect(await maskOne(service, 'read "/home/carol/a.txt"')).toBe('read "⟦PATH_1⟧/a.txt"')
    expect(await maskOne(service, 'cat ~dave/notes')).toBe('cat ⟦PATH_1⟧/notes')
    expect(await maskOne(service, '{"file":"\\/Users\\/erin\\/x"}')).toBe('{"file":"⟦PATH_1⟧\\/x"}')
  })

  it('skips identification numbers with an invalid checksum or embedded in a longer token', async () => {
    const service = new RulesRedactionService(new Context(), { rules: ['tw-national-id'] })
    expect(await maskOne(service, 'bad A123456788 embedded XA123456789 ok A123456789')).toBe('bad A123456788 embedded XA123456789 ok ⟦TWID_1⟧')
    expect(isTaiwanNationalId('B123456780')).toBe(true)
    expect(isTaiwanNationalId('a123456789')).toBe(false)
  })

  it('matches every case of a term, one identity per spelling, and exposes the fixed category set', async () => {
    const service = new RulesRedactionService(new Context(), { rules: ['email', 'tw-national-id'], terms: ['fictional-user'] })
    expect(await maskOne(service, 'FICTIONAL-USER and Fictional-User.')).toBe('⟦TERM_1⟧ and ⟦TERM_2⟧.')
    expect(service.categories).toEqual(['EMAIL', 'TWID', 'TERM'])
    expect(new RulesRedactionService(new Context()).categories)
      .toEqual(['EMAIL', 'PATH', 'KEY', 'TWID', 'PHONE', 'TAXID', 'CARD', 'IP', 'HOST', 'ENTROPY'])
    expect(new RulesRedactionService(new Context(), { projectNames: ['Nimbus'] }).categories).toContain('PROJECT')
  })

  it('honors the enabled rule list and keeps term text out of the policy digest', async () => {
    const onlyEmail = new RulesRedactionService(new Context(), { rules: ['email'], terms: [CORPUS.name, CORPUS.name] })
    expect(await maskOne(onlyEmail, `${CORPUS.email} ${CORPUS.path} ${CORPUS.name} ${CORPUS.name}`))
      .toBe(`⟦EMAIL_1⟧ ${CORPUS.path} ⟦TERM_1⟧ ⟦TERM_1⟧`)
    const otherName = new RulesRedactionService(new Context(), { rules: ['email'], terms: ['王大華'] })
    expect(otherName.policyDigest).toBe(onlyEmail.policyDigest)
    expect(new RulesRedactionService(new Context(), { rules: [] }).policyDigest).not.toBe(onlyEmail.policyDigest)
    expect(await maskOne(new RulesRedactionService(new Context(), { rules: [] }), CORPUS.email)).toBe(CORPUS.email)
  })

  it('fails loud on invalid configuration', () => {
    expect(resolveRulesConfig()).toEqual({
      rules: ['email', 'user-path', 'api-key', 'tw-national-id', 'phone', 'tax-id', 'card', 'ip', 'host', 'entropy'],
      terms: [],
      projectNames: [],
      allowlist: ['git@github.com', 'noreply@github.com'],
    })
    expect(() => resolveRulesConfig({ extra: true } as never)).toThrow('unknown key "extra"')
    expect(() => resolveRulesConfig({ rules: 'email' } as never)).toThrow('rules must be an array')
    expect(() => resolveRulesConfig({ rules: ['sms'] } as never)).toThrow('unknown rule "sms"')
    expect(() => resolveRulesConfig({ terms: 'x' } as never)).toThrow('terms must be an array')
    expect(() => resolveRulesConfig({ terms: [' '] })).toThrow('non-blank string')
    expect(() => resolveRulesConfig({ terms: [1] } as never)).toThrow('non-blank string')
    expect(() => resolveRulesConfig({ terms: ['⟦x'] })).toThrow('placeholder delimiter')
    expect(() => resolveRulesConfig({ projectNames: [''] })).toThrow('every projectNames entry must be a non-blank string')
    expect(() => resolveRulesConfig({ allowlist: 'x' } as never)).toThrow('allowlist must be an array')
    expect(() => resolveRulesConfig({ terms: ['\u200b'] })).toThrow('survives normalization')
  })
})
