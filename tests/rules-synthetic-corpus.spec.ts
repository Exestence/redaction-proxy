import { describe, expect, it } from 'vitest'
import { Context } from './shim.ts'
import { INTERNATIONAL_RULE_NAMES, RedactionError, emptyRedactionIndex } from '../src/core/index.ts'
import RulesRedactionService from './shim.ts'
import { SessionSeq } from './shim.ts'

const service = new RulesRedactionService(new Context(), { projectNames: ['nimbus'], terms: ['機密'] })
const internationalOnly = new RulesRedactionService(new Context(), { rules: [...INTERNATIONAL_RULE_NAMES] })

interface MaskOutcome {
  masked: string
  categories: string[]
  refused?: string
}

async function mask(text: string, maskingService: RulesRedactionService = service): Promise<MaskOutcome> {
  try {
    const result = await maskingService.mask([{ seq: SessionSeq(1), path: '/content/0/text', text }], emptyRedactionIndex())
    return {
      masked: result.masked[0] ?? '',
      categories: result.applied.map(span => span.id.slice(0, span.id.lastIndexOf('_'))),
    }
  } catch (error) {
    if (!(error instanceof RedactionError)) throw error
    return { masked: text, categories: [], refused: error.code }
  }
}

/** Deterministic linear congruential generator, so a failing shape is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

// Public source carries almost no long digit runs, so a code corpus alone says
// nothing about what card detection costs on a log, which is the other payload
// this provider carries.
describe('log shapes', () => {
  const random = rng(20260916)
  const digits = (n: number): string => Array.from({ length: n }, () => Math.floor(random() * 10)).join('')
  const shapes: [string, () => string, number][] = [
    ['nanosecond timestamp', () => `2026-09-16T10:00:00Z ts=17${digits(17)} level=info`, 0.02],
    ['snowflake id', () => `tweet id=1${digits(18)} author=bob`, 0.02],
    ['discord id', () => `message 9${digits(17)} delivered`, 0.02],
    ['random 20 digits', () => `ref ${digits(20)} settled`, 0.02],
    ['random 24 digits', () => `trace ${digits(24)} closed`, 0.02],
    ['numeric uuid', () => `uuid ${digits(32)} created`, 0.02],
    ['json log line', () => `{"ts":17${digits(17)},"id":${digits(18)},"span":${digits(16)}}`, 0.12],
    ['int64 max', () => 'counter limit 18446744073709551615 reached', 0.02],
    ['digit table row', () => `| ${digits(4)} | ${digits(4)} | ${digits(4)} |`, 0.02],
  ]

  it.each(shapes)('keeps card false positives on a %s under its ceiling', async (_name, generate, ceiling) => {
    const rounds = 2_000
    let hits = 0
    for (let i = 0; i < rounds; i += 1) {
      const { categories } = await mask(generate())
      if (categories.includes('CARD')) hits += 1
    }
    expect(hits / rounds).toBeLessThan(ceiling)
  })
})

// Identifier-shaped log values: the international rules check digits or ask
// for a keyword, so a random identifier of the same length is not one.
describe('international rules on log shapes', () => {
  const random = rng(20261005)
  const digits = (n: number): string => Array.from({ length: n }, () => Math.floor(random() * 10)).join('')
  const shapes: [string, () => string, number][] = [
    ['nanosecond timestamp', () => `2026-09-16T10:00:00Z ts=17${digits(17)} level=info`, 0.002],
    ['snowflake id', () => `tweet id=1${digits(18)} author=bob`, 0.002],
    ['json log line', () => `{"ts":17${digits(17)},"id":${digits(18)},"span":${digits(16)}}`, 0.002],
    ['9-digit id', () => `id ${digits(9)} ok`, 0.002],
    ['11-digit id starting with 1', () => `id 1${digits(10)} ok`, 0.002],
    ['12-digit order number', () => `order ${digits(12)} shipped`, 0.002],
    ['15-digit id', () => `id ${digits(15)} ok`, 0.002],
    ['18-digit id', () => `id ${digits(18)} ok`, 0.002],
    ['dated build serial', () => `build ${digits(6)}-${digits(7)}`, 0.01],
  ]

  it.each(shapes)('keeps international false positives on a %s under its ceiling', async (_name, generate, ceiling) => {
    const rounds = 2_000
    let hits = 0
    for (let i = 0; i < rounds; i += 1) {
      const { categories } = await mask(generate(), internationalOnly)
      if (categories.length > 0) hits += 1
    }
    expect(hits / rounds).toBeLessThan(ceiling)
  })
})

// Timing the patterns alone missed a two-minute identifier scan, because the
// cost was in what the match handler did afterwards, not in the match.
describe('adversarial inputs', () => {
  const SIZE = 200 * 1024
  const units = [
    'A_KEY=', 'A=', 'C:\\Users\\', '4111 ', 'sk-', 'a1', 'a.', '~a/', 'aA0', '@a.', '-', '_1',
    'password=', 'Bearer ', 'Cookie: ', '0912', 'A1234567', 'eyJ', '\\u4e2d', '.local', '10.1.',
    'key', 'sid', 'pwd', 'session', 'token', 'KEY_', 'API_KEY=', 'a_key=b ',
    'Cookie: a=b\n', 'Authorization: Bearer x\n', '.lan.', '10.1.2.3 ', '4111 1111 ',
    '0912345678 ', 'A123456789 ', '-----BEGIN RSA PRIVATE KEY-----\n', 'TAG_1 ', '~a/b ',
    '/Users/a/', 'a@b.co ', 'password=a ', 'session=a ', 'nimbus ', '機密 ',
  ]

  it.each(units)('masks 200KB of %j within the test budget', async (unit) => {
    const filled = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
    const text = unit === 'a.' ? `${filled.slice(0, SIZE - 3)}lan` : filled
    const { masked, refused } = await mask(text)
    expect(refused).toBeUndefined()
    expect(masked.length).toBeGreaterThan(0)
    // The per-test timeout is the bound, not a wall-clock assertion, which is a
    // CI flake under concurrency. A quadratic scan costs minutes and exceeds it.
  }, 60_000)
})
