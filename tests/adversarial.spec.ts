// Adversarial inputs against the core: leaks, fail-closed screening,
// handler-level pathological inputs, and every chunk split of a streamed reply.
// Ported from the dsh-privacy-router `.verify/` scripts to the core API.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INTERNATIONAL_RULE_NAMES,
  RedactionError,
  RulesDetector,
  createStreamRestorer,
  emptyRedactionIndex,
  mask,
  restore,
  restoreLenient,
} from '../src/core/index.ts'
import type { RedactionRegistry } from '../src/core/index.ts'

const detector = new RulesDetector({ projectNames: ['Nimbus'], terms: ['機密專案'] })

const internationalOnly = new RulesDetector({ rules: [...INTERNATIONAL_RULE_NAMES] })

async function maskAll(texts: string[], using = detector) {
  return mask(using, texts.map((text, seq) => ({ seq, path: '', text })), emptyRedactionIndex())
}

describe('leaks', () => {
  it.each([
    '/Users/alice/Code/Nimbus/src/index.ts',
    'mail ann.lee@contoso.test please',
    'card 4111 1111 1111 1111 exp 2026',
    'cards 4111111111111111 5555555555554444',
    'api_key=Sup3rS3cretValue99',
    'Authorization: Bearer abcdefghijklmnop0123',
    '-----BEGIN EC PRIVATE KEY-----\nMIIabc\n',
    'ssh to nas.lan at 10.1.2.3',
    '機密專案 kickoff',
    '{"home":"\\/Users\\/alice\\/x"}',
    'C:\\\\Users\\\\alice\\\\AppData',
    '身分證 A123456789 電話 0912-345-678',
    'ａｌｉｃｅ＠example.test and ali\u200bce@example.test',
  ])('masks every detected value of %j and round-trips', async text => {
    const result = await maskAll([text])
    const masked = result.masked[0] ?? ''
    expect(result.registry.ids().length).toBeGreaterThan(0)
    for (const original of result.registry.originals()) expect(masked).not.toContain(original)
    const back = restore(masked, result.registry)
    expect(back.ok && back.text).toBe(text)
  })

  it('masks each spelling of a configured term under its own identity and restores every spelling exactly', async () => {
    const result = await maskAll(['Nimbus, nimbus and NIMBUS'])
    expect(result.masked[0]).toBe('⟦PROJECT_1⟧, ⟦PROJECT_2⟧ and ⟦PROJECT_3⟧')
    expect(result.registry.originals()).toEqual(['Nimbus', 'nimbus', 'NIMBUS'])
    const back = restore(result.masked[0] ?? '', result.registry)
    expect(back.ok && back.text).toBe('Nimbus, nimbus and NIMBUS')
  })
})

describe('fail closed', () => {
  it.each([
    ['NUL', `/Users/alice${String.fromCharCode(0)}`],
    ['replacement', '/Users/alice\uFFFD'],
    ['lone surrogate', `/Users/alice${String.fromCharCode(0xdc00)}`],
    ['control', '/Users/alice\u0001'],
    ['placeholder', '⟦PATH_1⟧ /Users/alice'],
    ['closing delimiter', 'a lone ⟧ bracket'],
  ])('refuses a %s text whole, without naming its content', async (_name, text) => {
    const error = await maskAll([text]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RedactionError)
    expect((error as RedactionError).code).toBe('unsupported')
    expect((error as Error).message).not.toContain('alice')
  })
})

describe('pathological inputs', () => {
  const SIZE = 200 * 1024
  // Handler-level: the cost of an earlier two-minute scan was in the match
  // handler, not the pattern, so whole-detector timings are what count.
  it.each([
    'A_KEY=', 'C:\\Users\\', '4111 ', 'sk-', 'a1', 'a.', '~a/', 'aA0', '@a.', '-', '_1',
    'password=', 'Bearer ', 'Cookie: ', '0912', 'A1234567', 'eyJ', '\\u4e2d', '.local', '10.1.',
    'key', 'sid', 'session', 'token', 'KEY_', 'a_key=b ', '.lan.', '4111 1111 ', 'A123456789 ',
    '-----BEGIN RSA PRIVATE KEY-----\n', 'TAG_1 ', '/Users/a/', 'a@b.co ', 'password=a ', '0912345678 ',
    ' @ ', 'a.b at ', '(at)', 'a [dot] ', 'a(dot)', ' ', '09-1234-', 'A 1', '統編 1234-', 'Nimbus ', '機密 ',
    '%41', '%30', '%E6%98%9F', '%2', '%', 'a%40b.co ', '%2FUsers%2F', '%E6%A9%9F%E5%AF%86',
  ])('masks 200KB of %j within 2s of CPU time', async unit => {
    const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
    // CPU time of this worker process rather than wall-clock time, so other
    // test files running in parallel do not count against the budget.
    const started = process.cpuUsage()
    await maskAll([text])
    const used = process.cpuUsage(started)
    expect((used.user + used.system) / 1_000).toBeLessThan(2_000)
  })
})

describe('pathological inputs at 1 MB', () => {
  // The env-line check once read back to the previous newline from every key,
  // so one 1.28 MB line of `password=` took 21 s.
  it.each(['password=', 'PASSWORD=', ' PASSWORD='])('masks 1 MB of %j within 2s of CPU time', async unit => {
    const text = unit.repeat(Math.ceil(1024 * 1024 / unit.length))
    const started = process.cpuUsage()
    await maskAll([text])
    const used = process.cpuUsage(started)
    expect((used.user + used.system) / 1_000).toBeLessThan(2_000)
  })

  it.each([' ', '\t', ' '.repeat(200), `export${' '.repeat(200)}`])('reads an env line after any indent: %j', async indent => {
    const result = await maskAll([`x\n${indent}DB_PASSWORD=ZQ7WRT_PLM3_XKV9\n`])
    expect(result.masked[0]).not.toContain('ZQ7WRT_PLM3_XKV9')
  })
})

describe('pathological inputs to the international rules', () => {
  const SIZE = 200 * 1024
  it.each([
    '+', '+44 ', '+1 (415) ', '+8613812345678', 'DE89 ', 'DE89 3704 ', 'GB82WEST', 'DE12345678', '123-45-',
    '123 45 ', 'ssn ', 'ssn 1', 'AB 12 34 ', 'AB123456', 'Steuer-ID ', 'tin 1', '1 85 05 ', 'sécurité sociale 1',
    '12345678', 'X1234567', 'RSSMRA', '11010519491231002', '138-1234-', '手机 138', 'A123456(', 'HKID A',
    'マイナンバー 1234 ', '090-1234-', '900101-', '1 ',
    '(415) ', '415-555-', '415.555.', '1-', '0', '020 7946 ', '07700 ', '01 23 ', '01.', '03-1234-', '0120-',
    '010-1234-', '(11) 9', 'phone ', 'tel 1', 'phone +1 ', 'phone (0', 'phone 1 2 3 ', 'phone 1-', 'phone 2026-10-',
    '電話 0', 'call me at ',
  ])('masks 200KB of %j within 2s of CPU time', async unit => {
    const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
    const started = process.cpuUsage()
    await maskAll([text], internationalOnly)
    const used = process.cpuUsage(started)
    expect((used.user + used.system) / 1_000).toBeLessThan(2_000)
  })
})

describe('stream restore', () => {
  let registry: RedactionRegistry
  const ready = maskAll(['/Users/alice and nas.lan and say "hi" to ann@contoso.test']).then(result => {
    registry = result.registry
  })

  const replies = [
    '⟦PATH_1⟧/x then ⟦HOST_1⟧ tail',
    'see ⟦EMAIL_1⟧.',
    'unknown ⟦EMAIL_9⟧ stays',
    '⟦⟦PATH_1⟧⟧ doubled',
    'a lone ⟧ and a lone ⟦ in prose',
    '⟦not a placeholder⟧ and ⟦PATH_1',
    'code: `[HOST]` map[key] {{tpl}} 【標】 [[x]]',
  ]

  it.each(replies)('every 2- and 3-cut of %j streams what one push restores', async reply => {
    await ready
    const expected = restoreLenient(reply, registry)
    for (let i = 0; i <= reply.length; i += 1) {
      for (let j = i; j <= reply.length; j += 1) {
        const stream = createStreamRestorer(registry)
        const out = stream.push(reply.slice(0, i)) + stream.push(reply.slice(i, j)) + stream.push(reply.slice(j)) + stream.end()
        expect(out).toBe(expected)
      }
    }
  })

  it('restores known placeholders and keeps unknown or malformed ones as text', async () => {
    await ready
    expect(restoreLenient('⟦PATH_1⟧/x ⟦EMAIL_9⟧ ⟦PATH_1', registry)).toBe('/Users/alice/x ⟦EMAIL_9⟧ ⟦PATH_1')
  })

  it('JSON-escapes originals inside tool-call arguments', async () => {
    const result = await maskAll(['token="hun\\"ter2\\nX" end'])
    const json = `{"secret":"${'⟦KEY_1⟧'}"}`
    const out = restoreLenient(json, result.registry, { json: true })
    expect(JSON.parse(out)).toEqual({ secret: result.registry.originals()[0] })
  })

  it('stays linear on a 100KB reply in 4-character chunks and under an unclosed opener', async () => {
    await ready
    for (const text of [
      '⟦PATH_1⟧ some filler words here. '.repeat(3200),
      `⟦ unclosed then ${'filler words here. '.repeat(5400)}`,
      `⟦PATH_1${'_'.repeat(100_000)}`,
    ]) {
      const started = performance.now()
      const stream = createStreamRestorer(registry)
      let out = ''
      for (let i = 0; i < text.length; i += 4) out += stream.push(text.slice(i, i + 4))
      out += stream.end()
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(out).toBe(restoreLenient(text, registry))
    }
  })
})

describe('core independence', () => {
  it('imports nothing outside the core and Node built-ins', () => {
    const root = join(import.meta.dirname, '../src/core')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8')
      for (const [, specifier] of source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
        expect(specifier, file).toMatch(/^(?:\.{1,2}\/|node:)/)
      }
    }
  })
})
