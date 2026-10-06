/**
 * A stand-in for the nym runtime: one token per Han character or per run of
 * other non-space characters, and a fixed class per known word. It lets the
 * name-model suites run without onnxruntime-node or model files.
 */
import { NameModel } from '../src/core/model/name-model.ts'
import { resolveNameModelConfig } from '../src/core/model/config.ts'
import type { NameModelConfig } from '../src/core/model/config.ts'
import type { NameModelRuntime, TokenEncoding } from '../src/core/model/runtime.ts'

export const FAKE_LABELS = ['O', 'B-GIVEN_NAME', 'I-GIVEN_NAME', 'B-SURNAME', 'B-COMPANY_NAME', 'B-CITY', 'B-EMAIL'] as const

type FakeLabel = typeof FAKE_LABELS[number]

const TOKEN = /\p{Script=Han}|[^\s\p{Script=Han}]+/gu
const BOS = 1
const EOS = 2
const CONFIDENT = 10

/** A fake runtime that labels the given words and records what it was asked. */
export class FakeRuntime implements NameModelRuntime {
  readonly classLabels = FAKE_LABELS
  fingerprint = 'sha256:fake-model'
  /** Token count of every window passed to {@link logits}. */
  readonly windows: number[] = []
  released = false
  /** Rejects every inference when set. */
  failure: Error | undefined
  /** Resolves inference only when this promise does, when set. */
  gate: Promise<void> | undefined
  private readonly words: string[] = ['<pad>', '<bos>', '<eos>']

  /** @param labels - word to label; every other word is `O`. */
  constructor(private readonly labels: Readonly<Record<string, FakeLabel>>) {}

  async encode(text: string): Promise<TokenEncoding> {
    const ids = [BOS]
    const offsets: [number, number][] = [[0, 0]]
    for (const match of text.matchAll(TOKEN)) {
      ids.push(this.idOf(match[0]))
      offsets.push([match.index, match.index + match[0].length])
    }
    ids.push(EOS)
    offsets.push([0, 0])
    return { ids, offsets }
  }

  async logits(ids: readonly number[]): Promise<Float32Array> {
    this.windows.push(ids.length)
    await this.gate
    if (this.failure !== undefined) throw this.failure
    const logits = new Float32Array(ids.length * FAKE_LABELS.length)
    ids.forEach((id, row) => {
      const label = this.labels[this.words[id] as string] ?? 'O'
      logits[row * FAKE_LABELS.length + FAKE_LABELS.indexOf(label)] = CONFIDENT
    })
    return logits
  }

  async release(): Promise<void> {
    this.released = true
  }

  private idOf(word: string): number {
    const known = this.words.indexOf(word)
    return known >= 0 ? known : this.words.push(word) - 1
  }
}

/**
 * Build a name model over a fake runtime.
 * @param labels - word to label.
 * @param config - configuration overrides.
 * @returns the model and its runtime.
 */
export function fakeNameModel(
  labels: Readonly<Record<string, FakeLabel>>,
  config: Partial<NameModelConfig> = {},
): { model: NameModel; runtime: FakeRuntime } {
  const runtime = new FakeRuntime(labels)
  return { model: new NameModel(resolveNameModelConfig({ dir: '/fake/model', ...config }), runtime), runtime }
}
