import { describe, expect, it } from 'vitest'
import { Context } from './shim.ts'
import {
  RedactionError,
  RedactionId,
  RedactionPolicyDigest,
  applySpans,
  emptyRedactionIndex,
  foldRedactionScan,
  placeholder,
} from '../src/core/index.ts'
import { RedactionService } from './shim.ts'
import type {
  RedactionDetection,
  RedactionIndex,
  RedactionMaskResult,
  RedactionPropagation,
  RedactionScan,
  RedactionText,
} from '../src/core/index.ts'
import { SessionSeq } from './shim.ts'

// Every value below is fictional.
const EMAIL = 'lin.fictional@example.test'
const OTHER = 'wang.fictional@example.test'
const DIGEST = RedactionPolicyDigest('sha256:fixture')

/** Detects the two fictional emails and counts detector calls. */
class FixtureRedaction extends RedactionService {
  override readonly policyDigest = DIGEST
  override readonly categories = ['EMAIL', 'NAME', 'WORD']
  calls = 0
  constructor(ctx: Context, override readonly detectorVersion = 'v1', private readonly extra: RedactionDetection[] = []) {
    super(ctx)
  }

  protected override detect(text: string): RedactionDetection[] {
    this.calls += 1
    const found: RedactionDetection[] = [...this.extra]
    for (const value of [EMAIL, OTHER]) {
      for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
        found.push({ start, end: start + value.length, category: 'EMAIL' })
      }
    }
    return found
  }
}

function text(seq: number, value: string, path = '/content/0/text'): RedactionText {
  return { seq: SessionSeq(seq), path, text: value }
}

function scanOf(result: RedactionMaskResult, detectorVersion = 'v1'): RedactionScan {
  return {
    policyDigest: DIGEST,
    detectorVersion,
    spans: result.spans,
    scanned: result.scanned,
    checkpointSpans: [],
    reserved: result.reserved,
  }
}

function index(entries: RedactionIndex['entries'], lastIds: RedactionIndex['lastIds'] = {}): RedactionIndex {
  return { entries, lastIds, reserved: [] }
}

describe('RedactionService', () => {
  it('masks detected values with session-stable identities', async () => {
    const service = new FixtureRedaction(new Context())

    const result = await service.mask([
      text(1, `mail ${EMAIL} and ${OTHER}`),
      text(2, `again ${EMAIL}`),
      text(3, 'nothing here'),
    ], emptyRedactionIndex())

    expect(result.masked).toEqual(['mail ⟦EMAIL_1⟧ and ⟦EMAIL_2⟧', 'again ⟦EMAIL_1⟧', 'nothing here'])
    expect(result.spans.map(span => [span.seq, span.id])).toEqual([[1, 'EMAIL_1'], [1, 'EMAIL_2'], [2, 'EMAIL_1']])
    expect(result.scanned).toEqual([{ seq: 3, path: '/content/0/text' }])
    expect(result.reserved).toEqual([])
    expect(result.detected).toBe(3)
    expect(result.registry.originals()).toEqual([EMAIL, OTHER])
    expect(JSON.stringify([result.spans, result.scanned])).not.toContain('example.test')
  })

  it('applies indexed spans without the detector and continues numbering after recorded identities', async () => {
    const service = new FixtureRedaction(new Context())
    const first = await service.mask([text(1, `to ${OTHER}`), text(2, 'clean')], emptyRedactionIndex())
    const recorded = foldRedactionScan(emptyRedactionIndex(), scanOf(first))
    service.calls = 0

    const second = await service.mask([text(1, `to ${OTHER}`), text(2, 'clean'), text(3, `${EMAIL} ${OTHER}`)], recorded)

    expect(service.calls).toBe(1)
    expect(second.detected).toBe(1)
    expect(second.masked).toEqual(['to ⟦EMAIL_1⟧', 'clean', '⟦EMAIL_2⟧ ⟦EMAIL_1⟧'])
    expect(second.spans.map(span => span.seq)).toEqual([3, 3])
    expect(second.applied).toHaveLength(3)
    // Re-detecting from scratch yields the same masked text (reuse is equivalent to rescanning).
    const fresh = await service.mask([text(1, `to ${OTHER}`), text(2, 'clean')], emptyRedactionIndex())
    expect(second.masked.slice(0, 2)).toEqual(fresh.masked)
  })

  it('adds non-overlapping detections for locations recorded by an older detector version', async () => {
    const old = new FixtureRedaction(new Context(), 'v0')
    const recorded = await old.mask([text(1, `${EMAIL} note`)], emptyRedactionIndex())
    const oldIndex = foldRedactionScan(emptyRedactionIndex(), scanOf(recorded, 'v0'))
    const upgraded = new FixtureRedaction(new Context(), 'v1', [
      { start: 0, end: 4, category: 'NAME' },
      { start: EMAIL.length + 1, end: EMAIL.length + 5, category: 'WORD' },
    ])

    const result = await upgraded.mask([text(1, `${EMAIL} note`)], oldIndex)

    expect(upgraded.calls).toBe(1)
    expect(result.masked).toEqual(['⟦EMAIL_1⟧ ⟦WORD_1⟧'])
    expect(result.spans.map(span => span.id)).toEqual(['WORD_1'])
    const again = await upgraded.mask([text(1, 'no longer present')], foldRedactionScan(oldIndex, scanOf(result)))
      .catch((error: unknown) => error)
    expect(again).toBeInstanceOf(RedactionError)
  })

  it('records a rescan with no new span as scanned so the new version is indexed', async () => {
    const old = new FixtureRedaction(new Context(), 'v0')
    const recorded = await old.mask([text(1, 'clean')], emptyRedactionIndex())
    const oldIndex = foldRedactionScan(emptyRedactionIndex(), scanOf(recorded, 'v0'))
    const upgraded = new FixtureRedaction(new Context(), 'v1')
    const result = await upgraded.mask([text(1, 'clean')], oldIndex)
    expect(result.scanned).toEqual([{ seq: 1, path: '/content/0/text' }])
    const next = foldRedactionScan(oldIndex, scanOf(result))
    expect(next.entries).toEqual([{ seq: 1, path: '/content/0/text', detectorVersion: 'v1', spans: [] }])
  })

  it('reserves literal identities of policy categories so they are never allocated or restored', async () => {
    const service = new FixtureRedaction(new Context())
    const first = await service.mask([text(1, `see EMAIL_1, FOO_2 and ${EMAIL}`)], emptyRedactionIndex())

    expect(first.masked).toEqual(['see EMAIL_1, FOO_2 and ⟦EMAIL_2⟧'])
    expect(first.reserved).toEqual(['EMAIL_1'])
    // A bare literal stays literal; a bracketed reserved identity is not a binding.
    expect(service.restore('EMAIL_1 belongs to ⟦EMAIL_2⟧', first.registry)).toMatchObject({ ok: true, text: `EMAIL_1 belongs to ${EMAIL}` })
    expect(service.restore('⟦EMAIL_1⟧', first.registry)).toMatchObject({ ok: false, reason: 'unknown-placeholder' })

    // A later round rebuilt from the log keeps the reservation and allocates the same way as one continuous registry.
    const recorded = foldRedactionScan(emptyRedactionIndex(), scanOf(first))
    expect(recorded.reserved).toEqual(['EMAIL_1'])
    const rebuilt = await service.mask([text(1, `see EMAIL_1, FOO_2 and ${EMAIL}`), text(2, OTHER)], recorded)
    const continuous = await service.mask([text(1, `see EMAIL_1, FOO_2 and ${EMAIL}`), text(2, OTHER)], emptyRedactionIndex())
    expect(rebuilt.masked).toEqual(continuous.masked)
    expect(rebuilt.masked[1]).toBe('⟦EMAIL_3⟧')
    expect(rebuilt.reserved).toEqual([])

    // A bound identity that occurs literally in original text is a collision.
    await expect(service.mask([text(1, `see EMAIL_1, FOO_2 and ${EMAIL}`), text(3, 'quoted EMAIL_2')], recorded))
      .rejects.toMatchObject({ code: 'conflict' })
    const bound = index([{ seq: SessionSeq(1), path: '/p', detectorVersion: 'v1', spans: [{ start: 0, end: 3, id: RedactionId('EMAIL_1') }] }])
    await expect(service.mask([text(1, 'abc', '/p'), text(2, 'literal EMAIL_1')], bound)).rejects.toMatchObject({ code: 'conflict' })
    const reservedThenBound: RedactionIndex = { ...bound, reserved: [RedactionId('EMAIL_1')] }
    await expect(service.mask([text(1, 'abc', '/p')], reservedThenBound)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses an index recorded under another policy', async () => {
    const service = new FixtureRedaction(new Context())
    const foreign: RedactionIndex = { ...emptyRedactionIndex(), policyDigest: RedactionPolicyDigest('sha256:other') }
    const error = await service.mask([text(1, EMAIL)], foreign).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'policy' })
    expect(String(error)).not.toContain('example.test')
    await expect(service.mask([text(1, EMAIL)], { ...emptyRedactionIndex(), policyDigest: DIGEST })).resolves.toMatchObject({ masked: ['⟦EMAIL_1⟧'] })
  })

  it('rejects delimiters, misfit or conflicting recorded spans, and invalid detections', async () => {
    const service = new FixtureRedaction(new Context())
    await expect(service.mask([text(1, 'has ⟦ delimiter')], emptyRedactionIndex())).rejects.toMatchObject({ code: 'unsupported' })
    await expect(service.mask([text(1, 'has ⟧ delimiter')], emptyRedactionIndex())).rejects.toMatchObject({ code: 'unsupported' })

    const misfit = index([{ seq: SessionSeq(1), path: '/p', detectorVersion: 'v1', spans: [{ start: 0, end: 99, id: RedactionId('EMAIL_1') }] }], { EMAIL: 1 })
    await expect(service.mask([text(1, 'short', '/p')], misfit)).rejects.toMatchObject({ code: 'conflict' })
    const empty = index([{ seq: SessionSeq(1), path: '/p', detectorVersion: 'v1', spans: [{ start: 2, end: 2, id: RedactionId('EMAIL_1') }] }])
    await expect(service.mask([text(1, 'short', '/p')], empty)).rejects.toMatchObject({ code: 'conflict' })
    const negative = index([{ seq: SessionSeq(1), path: '/p', detectorVersion: 'v1', spans: [{ start: -1, end: 2, id: RedactionId('EMAIL_1') }] }])
    await expect(service.mask([text(1, 'short', '/p')], negative)).rejects.toMatchObject({ code: 'conflict' })

    const conflicting = index([
      { seq: SessionSeq(1), path: '/a', detectorVersion: 'v1', spans: [{ start: 0, end: 3, id: RedactionId('EMAIL_1') }] },
      { seq: SessionSeq(2), path: '/b', detectorVersion: 'v1', spans: [{ start: 0, end: 3, id: RedactionId('EMAIL_1') }] },
    ])
    const conflict = await service.mask([text(1, 'abc', '/a'), text(2, 'xyz', '/b')], conflicting).catch((error: unknown) => error)
    expect(conflict).toMatchObject({ name: 'RedactionError', code: 'conflict' })
    expect(String(conflict)).not.toContain('abc')
    const shared = index([
      { seq: SessionSeq(1), path: '/a', detectorVersion: 'v1', spans: [{ start: 0, end: 3, id: RedactionId('EMAIL_1') }] },
      { seq: SessionSeq(2), path: '/b', detectorVersion: 'v1', spans: [{ start: 0, end: 3, id: RedactionId('EMAIL_2') }] },
    ])
    await expect(service.mask([text(1, 'abc', '/a'), text(2, 'abc', '/b')], shared)).rejects.toMatchObject({ code: 'conflict' })

    const lower = new FixtureRedaction(new Context(), 'v1', [{ start: 0, end: 1, category: 'email' }])
    await expect(lower.mask([text(1, 'x')], emptyRedactionIndex())).rejects.toThrow('must be upper-case')
    const outside = new FixtureRedaction(new Context(), 'v1', [{ start: 0, end: 5, category: 'NAME' }])
    await expect(outside.mask([text(1, 'x')], emptyRedactionIndex())).rejects.toThrow('outside its text')
  })

  it('restores strictly and re-applying restored spans reproduces the masked output (I5)', async () => {
    const service = new FixtureRedaction(new Context())
    const { registry } = await service.mask([text(1, `${EMAIL} ${OTHER}`)], emptyRedactionIndex())
    const raw = '## Summary\n- contact ⟦EMAIL_2⟧ then ⟦EMAIL_2⟧; owner ⟦EMAIL_1⟧'

    const restored = service.restore(raw, registry)

    expect(restored).toMatchObject({ ok: true, text: `## Summary\n- contact ${OTHER} then ${OTHER}; owner ${EMAIL}`, missing: [] })
    if (!restored.ok) throw new Error('unreachable')
    expect(applySpans(restored.text, restored.spans)).toBe(raw)
    expect(service.restore('only ⟦EMAIL_1⟧', registry)).toMatchObject({ ok: true, missing: ['EMAIL_2'] })
    expect(service.restore('plain', registry.subset([RedactionId('EMAIL_2'), RedactionId('EMAIL_9')]))).toEqual({ ok: true, text: 'plain', spans: [], missing: ['EMAIL_2'] })

    const unknown = service.restore('see ⟦EMAIL_7⟧', registry)
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown-placeholder' })
    expect(JSON.stringify(unknown)).not.toContain('example.test')
    expect(service.restore('see ⟦not an id⟧', registry)).toMatchObject({ ok: false, reason: 'unknown-placeholder' })
    expect(service.restore('outside ⟦EMAIL_1⟧ restricted', registry.subset([RedactionId('EMAIL_2')]))).toMatchObject({ ok: false, reason: 'unknown-placeholder' })
    expect(service.restore('stray ⟦ then ⟦EMAIL_1⟧', registry)).toMatchObject({ ok: false, reason: 'malformed-placeholder' })
    expect(service.restore('⟦EMAIL_1⟧ trailing ⟧', registry)).toMatchObject({ ok: false, reason: 'malformed-placeholder' })
  })
})

describe('redaction helpers', () => {
  it('validates identities and renders placeholders', () => {
    expect(placeholder(RedactionId('TWID_12'))).toBe('⟦TWID_12⟧')
    expect(() => RedactionId('email_1')).toThrow('CATEGORY_n')
    expect(() => RedactionId('EMAIL_0')).toThrow('CATEGORY_n')
  })

  it('folds scans additively, ignoring overlapping spans and keeping the first policy', () => {
    const seq = SessionSeq(4)
    const first = foldRedactionScan(emptyRedactionIndex(), {
      policyDigest: DIGEST,
      detectorVersion: 'v1',
      spans: [{ seq, path: '/x', start: 5, end: 9, id: RedactionId('EMAIL_3') }, { seq, path: '/x', start: 0, end: 2, id: RedactionId('EMAIL_1') }],
      scanned: [{ seq, path: '/y' }],
      checkpointSpans: [{ seq: SessionSeq(5), path: '/content/1/text', start: 0, end: 3, id: RedactionId('KEY_2') }],
      reserved: [RedactionId('KEY_1')],
    })
    const second = foldRedactionScan(first, {
      policyDigest: RedactionPolicyDigest('sha256:later'),
      detectorVersion: 'v2',
      spans: [{ seq, path: '/x', start: 6, end: 8, id: RedactionId('EMAIL_4') }],
      scanned: [{ seq, path: '/y' }],
      checkpointSpans: [],
      reserved: [RedactionId('KEY_1'), RedactionId('EMAIL_9')],
    })

    expect(first.entries.find(entry => entry.path === '/x')?.spans.map(span => span.id)).toEqual(['EMAIL_1', 'EMAIL_3'])
    expect(second.entries.find(entry => entry.path === '/x')).toMatchObject({ detectorVersion: 'v2', spans: [{ id: 'EMAIL_1' }, { id: 'EMAIL_3' }] })
    expect(second.entries.find(entry => entry.path === '/y')).toMatchObject({ detectorVersion: 'v2', spans: [] })
    expect(second.lastIds).toEqual({ EMAIL: 4, KEY: 2 })
    expect(first.lastIds).toEqual({ EMAIL: 3, KEY: 2 })
    expect(second.reserved).toEqual(['KEY_1', 'EMAIL_9'])
    expect(second.policyDigest).toBe(DIGEST)
  })
})

/** Reports every occurrence of each bound original in every submitted text. */
class PropagatingRedaction extends FixtureRedaction {
  propagateCalls = 0

  protected override propagate(texts: readonly string[], values: ReadonlyMap<string, string>): RedactionPropagation[] {
    this.propagateCalls += 1
    const found: RedactionPropagation[] = []
    for (const [at, body] of texts.entries()) {
      for (const [value, category] of values) {
        for (let start = body.indexOf(value); start !== -1; start = body.indexOf(value, start + 1)) {
          found.push({ text: at, start, end: start + value.length, category })
        }
      }
    }
    return found
  }
}

describe('RedactionService propagation', () => {
  it('adds a span to a location the detector did not rescan', async () => {
    const service = new PropagatingRedaction(new Context())
    const first = await service.mask([text(1, `hi ${EMAIL}`)], emptyRedactionIndex())
    const folded = foldRedactionScan(emptyRedactionIndex(), scanOf(first))

    const second = await service.mask([text(1, `hi ${EMAIL}`), text(2, `also ${EMAIL}`)], folded)

    expect(service.calls).toBe(2)
    expect(second.masked).toEqual(['hi ⟦EMAIL_1⟧', 'also ⟦EMAIL_1⟧'])
    // The first location was reused, so only the second carries a new span.
    expect(second.spans.map(span => span.seq)).toEqual([SessionSeq(2)])
  })

  it('reaches an occurrence inside an already-scanned text', async () => {
    const service = new PropagatingRedaction(new Context())
    const seeded = index([{
      seq: SessionSeq(1),
      path: '/content/0/text',
      detectorVersion: 'v1',
      spans: [{ start: 0, end: 5, id: RedactionId('WORD_1') }],
    }])

    const result = await service.mask([text(1, 'lemon pie and lemon tart')], seeded)

    expect(service.calls).toBe(0)
    expect(result.masked).toEqual(['⟦WORD_1⟧ pie and ⟦WORD_1⟧ tart'])
    expect(result.spans).toEqual([{ seq: SessionSeq(1), path: '/content/0/text', start: 14, end: 19, id: 'WORD_1' }])
    expect(result.scanned).toEqual([])
  })

  it('drops a propagated range that overlaps a span already located', async () => {
    const service = new PropagatingRedaction(new Context())
    const result = await service.mask([text(1, `${EMAIL} once`)], emptyRedactionIndex())
    expect(result.masked).toEqual(['⟦EMAIL_1⟧ once'])
    expect(result.applied).toHaveLength(1)
  })

  it('drops a detection that runs into the span before it', async () => {
    // The overlap test bisects the located spans, so a range starting inside
    // the preceding span must be refused by the predecessor, not the successor.
    const service = new FixtureRedaction(new Context(), 'v1', [
      { start: 0, end: 5, category: 'WORD' },
      { start: 2, end: 7, category: 'WORD' },
    ])

    const result = await service.mask([text(1, 'lemon pie here')], emptyRedactionIndex())

    expect(result.masked).toEqual(['⟦WORD_1⟧ pie here'])
    expect(result.applied).toHaveLength(1)
  })

  it('masks only the uncovered part of a propagated range', async () => {
    // A propagated range may start inside a span already located and run past
    // it. The part no span covers is still sensitive, so it is masked on its
    // own and binds just that slice.
    const service = new PropagatingRedaction(new Context())
    const seeded = index([
      { seq: SessionSeq(1), path: '/content/0/text', detectorVersion: 'v1', spans: [{ start: 0, end: 5, id: RedactionId('WORD_1') }] },
      { seq: SessionSeq(2), path: '/content/0/text', detectorVersion: 'v1', spans: [{ start: 0, end: 3, id: RedactionId('WORD_2') }] },
    ], { WORD: 2 })

    const result = await service.mask([text(1, 'lemon'), text(2, 'lemonade')], seeded)

    // `lemon` propagates into text 2 at 0..5, where `lem` is already located.
    expect(result.masked).toEqual(['\u27E6WORD_1\u27E7', '\u27E6WORD_2\u27E7\u27E6WORD_3\u27E7ade'])
    expect(result.spans).toEqual([
      { seq: SessionSeq(2), path: '/content/0/text', start: 3, end: 5, id: 'WORD_3' },
    ])
    expect(result.registry.original(RedactionId('WORD_3'))).toBe('on')
  })

  it('refuses a propagated range that names a text outside the call', async () => {
    class Stray extends FixtureRedaction {
      protected override propagate(): RedactionPropagation[] {
        return [{ text: 3, start: 0, end: 1, category: 'WORD' }]
      }
    }
    await expect(new Stray(new Context()).mask([text(1, 'abc')], emptyRedactionIndex()))
      .rejects.toThrow('redaction propagation names text 3, which was not submitted')
  })

  it('receives every original the call bound, reused and newly detected', async () => {
    const service = new PropagatingRedaction(new Context())
    const first = await service.mask([text(1, `a ${EMAIL}`)], emptyRedactionIndex())
    const folded = foldRedactionScan(emptyRedactionIndex(), scanOf(first))
    const second = await service.mask([text(1, `a ${EMAIL}`), text(2, `b ${OTHER} ${EMAIL}`)], folded)
    expect(second.masked).toEqual(['a ⟦EMAIL_1⟧', 'b ⟦EMAIL_2⟧ ⟦EMAIL_1⟧'])
    expect(service.propagateCalls).toBe(2)
  })
})
