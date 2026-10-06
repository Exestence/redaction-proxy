/**
 * The nym ONNX runtime: loads `Wismut/nym-pii-multilingual-small` (edge-int8)
 * with `onnxruntime-node` and its tokenizer with the native `tokenizers`
 * package, both imported only here and only when the name model is
 * configured.
 *
 * The tokenizer is built from compact files (`vocab.json`, `merges.txt`,
 * `added_tokens.json`) written by `scripts/fetch-name-model.mjs`, not from
 * the 12 MB `tokenizer.json`: loading that file costs 230-330 MB of resident
 * memory, the compact files 112 MB, with identical ids and offsets.
 *
 * @module redaction-proxy/core/model/runtime
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Files the runtime reads from the model directory. */
const NAME_MODEL_FILES = ['model_int8.onnx', 'config.json', 'vocab.json', 'merges.txt', 'added_tokens.json'] as const

/** Token ids of one text with their UTF-16 ranges; special tokens carry `[0, 0]`. */
export interface TokenEncoding {
  ids: number[]
  offsets: [number, number][]
}

/** What the name model needs from an inference runtime. */
export interface NameModelRuntime {
  /** The model's `id2label`, by class index. */
  readonly classLabels: readonly string[]
  /** sha256 over every model and tokenizer file, for the policy digest. */
  readonly fingerprint: string
  /**
   * Tokenize one text.
   * @param text - the text.
   * @returns ids with BOS first and EOS last, and UTF-16 offsets.
   */
  encode(text: string): Promise<TokenEncoding>
  /**
   * Run the model over one window of ids.
   * @param ids - token ids, BOS first and EOS last.
   * @returns logits, `ids.length` rows of `classLabels.length` values.
   */
  logits(ids: readonly number[]): Promise<Float32Array>
  /** Free the native session; no call may be in flight. */
  release(): Promise<void>
}

/** One entry of `added_tokens.json`, as in `tokenizer.json`. */
interface AddedTokenEntry {
  content: string
  special: boolean
  normalized: boolean
  single_word: boolean
  lstrip: boolean
  rstrip: boolean
}

/**
 * Import an optional dependency.
 * @param name - package name.
 * @returns the module.
 * @throws {Error} naming the package when it is not installed.
 */
async function importOptional<T>(name: string): Promise<T> {
  try {
    return await import(name) as T
  } catch (error) {
    throw new Error(`nameModel: optional dependency "${name}" could not be loaded (${(error as Error).message}); install it with pnpm install`)
  }
}

/**
 * Check that every runtime file exists.
 * @param dir - the model directory.
 * @throws {Error} naming each missing file.
 */
function requireFiles(dir: string): void {
  const missing = NAME_MODEL_FILES.filter(file => !existsSync(join(dir, file)))
  if (missing.length > 0) {
    throw new Error(`nameModel: ${dir} is missing ${missing.join(', ')}; run scripts/fetch-name-model.mjs ${dir}`)
  }
}

/**
 * Hash every runtime file, streaming so the model is never held in memory.
 * @param dir - the model directory.
 * @returns `sha256:` and the hex digest.
 */
async function fingerprintFiles(dir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of NAME_MODEL_FILES) {
    hash.update(`${file}\u0000`)
    for await (const chunk of createReadStream(join(dir, file))) hash.update(chunk as Buffer)
  }
  return `sha256:${hash.digest('hex')}`
}

/**
 * Map code-point offsets, which the Rust tokenizer reports, to UTF-16 offsets.
 * @param text - the encoded text.
 * @returns per code-point index, its UTF-16 offset; one extra entry for the end.
 */
function utf16Offsets(text: string): number[] {
  const map = [0]
  for (const char of text) map.push((map.at(-1) as number) + char.length)
  return map
}

/**
 * Build the nym tokenizer from the compact files. It reproduces
 * `tokenizer.json`: spaces become `▁`, Metaspace splits with `▁` prepended,
 * BPE with byte fallback, added tokens cut before normalization, and BOS/EOS
 * around the text. Merges that contain a space or a newline are left out of
 * `merges.txt`; they can never apply, because every space is `▁` by then and
 * every newline is an added token.
 * @param dir - the model directory.
 * @returns the encode function.
 */
async function loadTokenizer(dir: string): Promise<(text: string) => Promise<TokenEncoding>> {
  const tokenizers = await importOptional<typeof import('tokenizers')>('tokenizers')
  const model = await tokenizers.BPE.fromFile(join(dir, 'vocab.json'), join(dir, 'merges.txt'), {
    byteFallback: true,
    fuseUnk: true,
    unkToken: '<unk>',
  })
  const tokenizer = new tokenizers.Tokenizer(model)
  tokenizer.setNormalizer(tokenizers.replace(' ', '▁'))
  tokenizer.setPreTokenizer(tokenizers.metaspacePreTokenizer('▁', 'always', true))
  const added = JSON.parse(await readFile(join(dir, 'added_tokens.json'), 'utf8')) as AddedTokenEntry[]
  tokenizer.addAddedTokens(added.map(token => new tokenizers.AddedToken(token.content, token.special, {
    normalized: token.normalized,
    singleWord: token.single_word,
    leftStrip: token.lstrip,
    rightStrip: token.rstrip,
  })))
  const idOf = (content: string): number => {
    const id = tokenizer.tokenToId(content)
    if (id === null) throw new Error(`nameModel: added_tokens.json has no ${content}`)
    return id
  }
  tokenizer.setPostProcessor(tokenizers.templateProcessing('<bos> $A <eos>', null, [['<bos>', idOf('<bos>')], ['<eos>', idOf('<eos>')]]))
  return async text => {
    const encoding = await tokenizer.encode(text)
    const toUtf16 = utf16Offsets(text)
    return {
      ids: encoding.getIds(),
      offsets: encoding.getOffsets().map(([start, end]) => [toUtf16[start as number] as number, toUtf16[end as number] as number]),
    }
  }
}

/**
 * Read the class labels from the model's `config.json`.
 * @param dir - the model directory.
 * @returns `id2label` by class index.
 */
async function loadClassLabels(dir: string): Promise<string[]> {
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { id2label?: Record<string, string> }
  const labels = Object.entries(config.id2label ?? {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, label]) => label)
  if (labels.length === 0) throw new Error(`nameModel: ${join(dir, 'config.json')} has no id2label`)
  return labels
}

/**
 * Load the nym runtime from a model directory.
 * @param dir - directory holding {@link NAME_MODEL_FILES}.
 * @returns the loaded runtime.
 * @throws {Error} naming a missing file, a missing optional dependency, or a model that does not load.
 */
export async function loadNymRuntime(dir: string): Promise<NameModelRuntime> {
  requireFiles(dir)
  const ort = await importOptional<typeof import('onnxruntime-node')>('onnxruntime-node')
  const [encode, classLabels, fingerprint] = await Promise.all([loadTokenizer(dir), loadClassLabels(dir), fingerprintFiles(dir)])
  const session = await ort.InferenceSession.create(join(dir, 'model_int8.onnx'), { graphOptimizationLevel: 'all' })
  const int64 = (values: readonly number[] | BigInt64Array): InstanceType<typeof ort.Tensor> =>
    new ort.Tensor('int64', values instanceof BigInt64Array ? values : BigInt64Array.from(values, BigInt), [1, values.length])
  return {
    classLabels,
    fingerprint,
    encode,
    async logits(ids) {
      const outputs = await session.run({ input_ids: int64(ids), attention_mask: int64(new BigInt64Array(ids.length).fill(1n)) })
      return outputs.logits?.data as Float32Array
    },
    release: () => session.release(),
  }
}
