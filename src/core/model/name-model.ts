/**
 * The optional name model: finds person names, organizations, places, and
 * addresses in the prose of one user-written text.
 *
 * @module redaction-proxy/core/model/name-model
 */

import { createHash } from 'node:crypto'
import type { NameModelCategory, NameModelConfig, ResolvedNameModelConfig } from './config.ts'
import { SPECIAL_TOKENS_PER_WINDOW, resolveNameModelConfig } from './config.ts'
import { proseLayout } from './prose.ts'
import type { NameModelRuntime, TokenEncoding } from './runtime.ts'
import { loadNymRuntime } from './runtime.ts'
import type { ModelSpan, ScoredToken } from './spans.ts'
import { assembleSpans, chooseCategory, classCategories, dropAllowlisted, dropCodeShaped, dropOverlapping, trimJapaneseNameTails } from './spans.ts'

// ponytail: fixed-size LRU of paragraph results; clients resend the whole history every turn, so without it every
// earlier user message is inferred again. Raise it if long conversations show misses. Keys are sha256 digests, so
// the cache holds no user text and its size does not grow with paragraph length.
const PARAGRAPH_CACHE_ENTRIES = 1024

/** One window of text tokens and the part of it whose scores are kept. */
interface TokenWindow {
  /** First text token of the window, counted without BOS. */
  from: number
  /** One past the last text token of the window. */
  to: number
  /** Leading tokens whose scores another window owns. */
  dropHead: number
  /** Trailing tokens whose scores another window owns. */
  dropTail: number
}

/**
 * Cut a run of text tokens into overlapping windows. Each token is scored by
 * the window in which it is furthest from an edge: neighbouring windows
 * share `overlap` tokens and each keeps its half.
 * @param textTokens - number of text tokens, without BOS and EOS.
 * @param size - text tokens per window.
 * @param overlap - tokens two neighbouring windows share; even.
 * @returns windows in order.
 */
export function tokenWindows(textTokens: number, size: number, overlap: number): TokenWindow[] {
  const windows: TokenWindow[] = []
  const half = overlap / 2
  for (let from = 0; ; from += size - overlap) {
    const to = Math.min(from + size, textTokens)
    const last = to === textTokens
    windows.push({ from, to, dropHead: from === 0 ? 0 : half, dropTail: last ? 0 : half })
    if (last) return windows
  }
}

/**
 * The name model. Detection reads only prose paragraphs, one model pass per
 * paragraph: on joined messages of about 1,000 tokens, one pass found 73% of
 * names and one pass per paragraph 95%.
 */
export class NameModel {
  /** The resolved configuration. */
  readonly config: ResolvedNameModelConfig
  private readonly runtime: NameModelRuntime
  private readonly classCategory: readonly (NameModelCategory | undefined)[]
  private readonly allowlist: ReadonlySet<string>
  private readonly cache = new Map<string, ModelSpan[]>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private released = false

  /**
   * @param config - resolved configuration.
   * @param runtime - the loaded inference runtime; this model owns it from now on.
   */
  constructor(config: ResolvedNameModelConfig, runtime: NameModelRuntime) {
    this.config = config
    this.runtime = runtime
    this.classCategory = classCategories(runtime.classLabels, config.categories)
    this.allowlist = new Set(config.allowlist.map(entry => entry.toLowerCase()))
  }

  /** sha256 over the model and tokenizer files. */
  get fingerprint(): string {
    return this.runtime.fingerprint
  }

  /**
   * Find names, organizations, places, and addresses in the prose of one text.
   * @param text - one user-written text.
   * @returns spans in start order; none inside code lines or overlapping inline code.
   * @throws {Error} when inference fails or the model was released.
   */
  async find(text: string): Promise<ModelSpan[]> {
    if (this.released) throw new Error('nameModel: the model was released')
    const run = this.findInProse(text)
    this.inFlight.add(run)
    try {
      return await run
    } finally {
      this.inFlight.delete(run)
    }
  }

  /**
   * Wait for running inferences, then free the native session. Later calls to
   * {@link find} fail.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await Promise.allSettled(this.inFlight)
    await this.runtime.release()
  }

  /**
   * Run the model over every prose paragraph of one text.
   * @param text - one user-written text.
   * @returns spans in text offsets.
   */
  private async findInProse(text: string): Promise<ModelSpan[]> {
    const { paragraphs, inlineCode } = proseLayout(text)
    const spans: ModelSpan[] = []
    for (const paragraph of paragraphs) {
      for (const span of await this.findInParagraph(text.slice(paragraph.start, paragraph.end))) {
        spans.push({ ...span, start: span.start + paragraph.start, end: span.end + paragraph.start })
      }
    }
    return dropOverlapping(spans, inlineCode)
  }

  /**
   * Find spans in one paragraph, from the cache when it was seen before.
   * @param paragraph - one paragraph.
   * @returns filtered spans in paragraph offsets.
   */
  private async findInParagraph(paragraph: string): Promise<ModelSpan[]> {
    const key = createHash('sha256').update(paragraph).digest('base64')
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const tokens = await this.scoreTokens(await this.runtime.encode(paragraph))
    const assembled = trimJapaneseNameTails(assembleSpans(tokens, paragraph), paragraph)
    const spans = dropAllowlisted(dropCodeShaped(assembled, paragraph), paragraph, this.allowlist)
    this.cache.set(key, spans)
    if (this.cache.size > PARAGRAPH_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string)
    return spans
  }

  /**
   * Choose a category for every text token, one window at a time.
   * @param encoding - the paragraph's tokens, BOS first and EOS last.
   * @returns the text tokens with their categories.
   */
  private async scoreTokens(encoding: TokenEncoding): Promise<ScoredToken[]> {
    const { ids, offsets } = encoding
    const bos = ids[0] as number
    const eos = ids.at(-1) as number
    const textTokens = ids.length - SPECIAL_TOKENS_PER_WINDOW
    const size = this.config.windowTokens - SPECIAL_TOKENS_PER_WINDOW
    const classes = this.classCategory.length
    const scored: ScoredToken[] = []
    for (const window of tokenWindows(textTokens, size, this.config.windowOverlap)) {
      const logits = await this.runtime.logits([bos, ...ids.slice(1 + window.from, 1 + window.to), eos])
      for (let t = window.from + window.dropHead; t < window.to - window.dropTail; t += 1) {
        // Row 0 of the window is BOS, so text token t sits at row t - from + 1.
        const row = t - window.from + 1
        const [start, end] = offsets[t + 1] as [number, number]
        const category = chooseCategory(logits.subarray(row * classes, (row + 1) * classes), this.classCategory, this.config.threshold)
        scored.push({ start, end, category })
      }
    }
    return scored
  }
}

/**
 * Validate the configuration and load the model before any request is served.
 * @param config - the `nameModel` configuration block.
 * @returns the loaded model.
 * @throws {Error} on an invalid configuration, a missing file or optional dependency, or a model that does not load.
 */
export async function loadNameModel(config: NameModelConfig): Promise<NameModel> {
  const resolved = resolveNameModelConfig(config)
  return new NameModel(resolved, await loadNymRuntime(resolved.dir))
}
