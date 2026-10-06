// The rules detector combined with the name model, through the engine's mask(): scope, rules precedence,
// propagation, allowlist, failure policy, windowing, and release. Every name is fictional.
import { describe, expect, it } from 'vitest'
import { RulesDetector, emptyRedactionIndex, mask } from '../src/core/index.ts'
import { NameModelDetector, NameModelError } from '../src/core/model/detector.ts'
import { fakeNameModel } from './name-model-fake.ts'

const LABELS = {
  Jane: 'B-GIVEN_NAME',
  Doe: 'B-SURNAME',
  Jordan: 'B-GIVEN_NAME',
  許: 'B-SURNAME',
  雅: 'I-GIVEN_NAME',
  雯: 'I-GIVEN_NAME',
  Acme: 'B-COMPANY_NAME',
  Kafka: 'B-COMPANY_NAME',
  Default: 'B-GIVEN_NAME',
  'jane.doe@example.test': 'B-GIVEN_NAME',
} as const

/**
 * Mask texts with the combined detector.
 * @param texts - request texts in order.
 * @param userTexts - which of them the user wrote.
 * @param config - name-model configuration overrides.
 * @returns masked texts and the failures the detector reported.
 */
async function maskWith(texts: string[], userTexts: string[] = texts, config = {}): Promise<{ masked: string[]; failures: unknown[] }> {
  const { model } = fakeNameModel(LABELS, config)
  const failures: unknown[] = []
  const detector = new NameModelDetector(new RulesDetector(), model).forRequest(new Set(userTexts), error => failures.push(error))
  const result = await mask(detector, texts.map((text, seq) => ({ seq, path: '', text })), emptyRedactionIndex())
  return { masked: result.masked, failures }
}

describe('NameModelDetector', () => {
  it('runs the model on user texts only, and rules on every text', async () => {
    const { masked } = await maskWith(['Ask Jordan', 'System: Jane at ops@example.test'], ['Ask Jordan'])
    expect(masked).toEqual(['Ask ⟦NAME_1⟧', 'System: Jane at ⟦EMAIL_1⟧'])
  })

  it('lets a rules detection win over an overlapping model span', async () => {
    expect((await maskWith(['Write to jane.doe@example.test'])).masked).toEqual(['Write to ⟦EMAIL_1⟧'])
  })

  it('propagates a multi-word name to every text through the terms matcher, sharing one placeholder', async () => {
    const { masked } = await maskWith(['Ask Jane Doe', 'tool output: JANE DOE replied'], ['Ask Jane Doe'])
    expect(masked).toEqual(['Ask ⟦NAME_1⟧', 'tool output: ⟦NAME_1⟧ replied'])
  })

  it('propagates a Han name to its spaced spelling', async () => {
    const { masked } = await maskWith(['請問許雅雯', '系統：許 雅 雯 已回覆'], ['請問許雅雯'])
    expect(masked).toEqual(['請問⟦NAME_1⟧', '系統：⟦NAME_1⟧ 已回覆'])
  })

  it('propagates a single word and an ORG to every text, whole words only', async () => {
    const { masked } = await maskWith(['Ask Jordan at Acme', 'JORDAN, Jordan\'s, Jordanian, ACME-Corp, Acmes'], ['Ask Jordan at Acme'])
    expect(masked).toEqual(['Ask ⟦NAME_1⟧ at ⟦ORG_1⟧', '⟦NAME_1⟧, ⟦NAME_1⟧\'s, Jordanian, ⟦ORG_1⟧-Corp, Acmes'])
  })

  it('propagates a Han value as a substring, with no word edges', async () => {
    const { masked } = await maskWith(['請問許雅雯', '許雅雯的報告在Jordan那裡'], ['請問許雅雯'])
    expect(masked).toEqual(['請問⟦NAME_1⟧', '⟦NAME_1⟧的報告在Jordan那裡'])
  })

  it('masks a one-character value only where found', async () => {
    const { masked } = await maskWith(['問許', '許可證'], ['問許'])
    expect(masked).toEqual(['問⟦NAME_1⟧', '許可證'])
  })

  it('drops spans on the default allowlist, which covers tools and setting words', async () => {
    expect((await maskWith(['Set Kafka to Default for Jane'])).masked).toEqual(['Set Kafka to Default for ⟦NAME_1⟧'])
  })

  it('reads prose only: not code blocks, not inline code', async () => {
    const text = 'Ask Jane\n\n```\nJordan = 1\n```\nrename `Jordan` to Doe'
    expect((await maskWith([text])).masked).toEqual(['Ask ⟦NAME_1⟧\n\n```\nJordan = 1\n```\nrename `Jordan` to ⟦NAME_2⟧'])
  })

  it('masks with rules only and reports the failure when inference fails', async () => {
    const { model, runtime } = fakeNameModel(LABELS)
    runtime.failure = new Error('session lost')
    const failures: unknown[] = []
    const detector = new NameModelDetector(new RulesDetector(), model).forRequest(new Set(['Ask Jane at ops@example.test']), error => failures.push(error))
    const result = await mask(detector, [{ seq: 0, path: '', text: 'Ask Jane at ops@example.test' }], emptyRedactionIndex())
    expect(result.masked).toEqual(['Ask Jane at ⟦EMAIL_1⟧'])
    expect(failures).toEqual([runtime.failure])
  })

  it('throws NameModelError when inference fails and the model is required', async () => {
    const { model, runtime } = fakeNameModel(LABELS, { required: true })
    runtime.failure = new Error('session lost')
    const detector = new NameModelDetector(new RulesDetector(), model).forRequest(new Set(['Ask Jane']), () => {})
    await expect(mask(detector, [{ seq: 0, path: '', text: 'Ask Jane' }], emptyRedactionIndex())).rejects.toBeInstanceOf(NameModelError)
  })
})

describe('NameModel', () => {
  it('cuts a long paragraph into overlapping windows and still finds names at both ends', async () => {
    const { model, runtime } = fakeNameModel(LABELS, { windowTokens: 12, windowOverlap: 4 })
    const text = `Jane ${'word '.repeat(30)}Doe`
    expect((await model.find(text)).map(span => text.slice(span.start, span.end))).toEqual(['Jane', 'Doe'])
    expect(runtime.windows.every(length => length <= 12)).toBe(true)
    expect(runtime.windows.length).toBeGreaterThan(1)
  })

  it('answers a paragraph it has seen from the cache', async () => {
    const { model, runtime } = fakeNameModel(LABELS)
    await model.find('Ask Jane')
    await model.find('Ask Jane')
    expect(runtime.windows).toHaveLength(1)
  })

  it('releases the runtime after running inferences finish, and refuses later calls', async () => {
    const { model, runtime } = fakeNameModel(LABELS)
    let open = (): void => {}
    runtime.gate = new Promise(resolve => { open = resolve })
    const running = model.find('Ask Jane')
    const released = model.release()
    expect(runtime.released).toBe(false)
    open()
    await expect(running).resolves.toHaveLength(1)
    await released
    expect(runtime.released).toBe(true)
    await expect(model.find('Ask Doe')).rejects.toThrow('released')
  })
})
