// Adversarial inputs against the core: leaks, fail-closed screening,
// handler-level pathological inputs, and every chunk split of a streamed reply.
// Ported from the dsh-privacy-router `.verify/` scripts to the core API.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
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

async function maskAll(texts: string[]) {
  return mask(detector, texts.map((text, seq) => ({ seq, path: '', text })), emptyRedactionIndex())
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
    'Nimbus, nimbus and NIMBUS',
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
  ])('masks 200KB of %j within 2s', async unit => {
    const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
    const started = performance.now()
    await maskAll([text])
    expect(performance.now() - started).toBeLessThan(2_000)
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
