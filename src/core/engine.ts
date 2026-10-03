/**
 * Redaction engine: placeholder identity allocation, span reuse, masking, and
 * strict restoration. A {@link RedactionDetector} supplies detection; this
 * module owns everything that gives a span its meaning.
 *
 * @module redaction-proxy/core/engine
 */

import type {
  RedactionDetection,
  RedactionDetector,
  RedactionId as RedactionIdType,
  RedactionIndex,
  RedactionIndexEntry,
  RedactionLocation,
  RedactionMaskResult,
  RedactionPolicyDigest as RedactionPolicyDigestType,
  RedactionRegistry,
  RedactionRestoreResult,
  RedactionScan,
  RedactionSpan,
  RedactionText,
  RedactionTextSpan,
} from './types.ts'

/** Placeholder identity; see {@link RedactionIdType}. */
export type RedactionId = RedactionIdType
/** Policy digest; see {@link RedactionPolicyDigestType}. */
export type RedactionPolicyDigest = RedactionPolicyDigestType

/** Accepted `CATEGORY_n` form of a placeholder identity. */
export const REDACTION_ID_PATTERN = /^([A-Z][A-Z0-9]*)_([1-9]\d*)$/
const ID_PATTERN = REDACTION_ID_PATTERN

/**
 * Brand one placeholder identity after checking its `CATEGORY_n` form.
 * @param value - candidate identity.
 * @returns the branded identity.
 * @throws {TypeError} when `value` is not `CATEGORY_n`.
 */
export function RedactionId(value: string): RedactionId {
  if (!REDACTION_ID_PATTERN.test(value)) throw new TypeError(`redaction id ${JSON.stringify(value)} must match CATEGORY_n`)
  return value as RedactionId
}

/**
 * Brand one detector policy digest.
 * @param value - opaque digest string.
 * @returns the same string, branded.
 */
export function RedactionPolicyDigest(value: string): RedactionPolicyDigest {
  return value as RedactionPolicyDigest
}

/** Opening delimiter of a placeholder in masked text. */
export const PLACEHOLDER_OPEN = '⟦'
/** Closing delimiter of a placeholder in masked text. */
export const PLACEHOLDER_CLOSE = '⟧'

const CATEGORY_PATTERN = /^[A-Z][A-Z0-9]*$/

/** Failure class of a {@link RedactionError}. */
export type RedactionErrorCode = 'unsupported' | 'conflict' | 'policy'

/**
 * Masking refused its input. `unsupported` means a text already contains a
 * placeholder delimiter; `conflict` means recorded spans do not fit the
 * current text, bind one identity to two originals, or bind an identity whose
 * literal form occurs in original text; `policy` means the index was recorded
 * under another policy, whose category set cannot be extended mid-Session.
 * The message names locations, identities, and digests, never an original.
 */
export class RedactionError extends Error {
  override readonly name = 'RedactionError'

  /**
   * @param code - failure class.
   * @param message - diagnostic without original values.
   */
  constructor(readonly code: RedactionErrorCode, message: string) {
    super(message)
  }
}

/**
 * Render one placeholder.
 * @param id - placeholder identity.
 * @returns `⟦id⟧`.
 */
export function placeholder(id: RedactionId): string {
  return `${PLACEHOLDER_OPEN}${id}${PLACEHOLDER_CLOSE}`
}

/** Split `CATEGORY_n` into its category and number. */
function parseId(id: RedactionId): { category: string; n: number } {
  // RedactionId() admitted the value, so the pattern matches.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const match = ID_PATTERN.exec(id)!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  return { category: match[1]!, n: Number(match[2]) }
}

/**
 * Replace each span's range with its placeholder.
 * @param text - the unmasked string.
 * @param spans - non-overlapping ranges inside `text`, in any order.
 * @returns the masked string.
 */
export function applySpans(text: string, spans: readonly RedactionTextSpan[]): string {
  let out = ''
  let cursor = 0
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, span.start) + placeholder(span.id)
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/** Mutable in-memory placeholder bindings owned by one mask call. */
class Registry implements RedactionRegistry {
  private readonly byId = new Map<RedactionId, string>()
  private readonly byOriginal = new Map<string, RedactionId>()
  private readonly last = new Map<string, number>()
  private readonly reserved: Set<RedactionId>

  constructor(lastIds: Readonly<Record<string, number>>, reserved: readonly RedactionId[]) {
    for (const [category, n] of Object.entries(lastIds)) this.last.set(category, n)
    this.reserved = new Set(reserved)
  }

  /** Whether an identity is reserved; records a new reservation and reports whether it was new. */
  reserve(id: RedactionId): boolean {
    if (this.byId.has(id)) {
      throw new RedactionError('conflict', `redaction id ${id} occurs literally in original text and is also bound`)
    }
    if (this.reserved.has(id)) return false
    this.reserved.add(id)
    return true
  }

  bind(id: RedactionId, original: string): void {
    const bound = this.byId.get(id)
    const known = this.byOriginal.get(original)
    if ((bound !== undefined && bound !== original) || (known !== undefined && known !== id)) {
      throw new RedactionError('conflict', `redaction id ${id} is recorded for two different values`)
    }
    if (this.reserved.has(id)) {
      throw new RedactionError('conflict', `redaction id ${id} occurs literally in original text and is also bound`)
    }
    this.byId.set(id, original)
    this.byOriginal.set(original, id)
    const { category, n } = parseId(id)
    this.last.set(category, Math.max(this.last.get(category) ?? 0, n))
  }

  allocate(original: string, category: string): RedactionId {
    const known = this.byOriginal.get(original)
    if (known !== undefined) return known
    let n = (this.last.get(category) ?? 0) + 1
    while (this.reserved.has(RedactionId(`${category}_${n}`))) n += 1
    const id = RedactionId(`${category}_${n}`)
    this.bind(id, original)
    return id
  }

  original(id: RedactionId): string | undefined {
    return this.byId.get(id)
  }

  ids(): RedactionId[] {
    return [...this.byId.keys()]
  }

  originals(): string[] {
    return [...this.byId.values()]
  }

  subset(ids: Iterable<RedactionId>): RedactionRegistry {
    const subset = new Registry({}, [])
    for (const id of ids) {
      const original = this.byId.get(id)
      if (original !== undefined) subset.bind(id, original)
    }
    return subset
  }
}

/** Key one location for map lookups. */
function locationKey(location: RedactionLocation<unknown>): string {
  return `${String(location.seq)}\u0000${location.path}`
}

/** Whether a range overlaps any span in the list. */
function overlaps(range: { start: number; end: number }, spans: readonly RedactionTextSpan[]): boolean {
  return spans.some(span => range.start < span.end && span.start < range.end)
}

/**
 * Locate where a range belongs in a list of non-overlapping spans kept in
 * start order. The list is bisected rather than scanned, because one text can
 * carry tens of thousands of spans.
 * @param spans - non-overlapping spans in start order.
 * @param range - the range to place.
 * @returns the insertion index, or -1 when the range overlaps a span already there.
 */
function placeSpan(spans: readonly RedactionTextSpan[], range: { start: number; end: number }): number {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `mid` is below `spans.length`.
    if (spans[mid]!.start < range.start) lo = mid + 1
    else hi = mid
  }
  const before = spans[lo - 1]
  const after = spans[lo]
  if (before !== undefined && range.start < before.end) return -1
  if (after !== undefined && after.start < range.end) return -1
  return lo
}

/**
 * Split a range into the parts no span in a list already covers. The list is
 * bisected to the first span that can reach the range, so the walk costs the
 * number of spans the range meets, not the length of the list.
 * @param spans - non-overlapping spans in start order.
 * @param range - the range to cover.
 * @returns the uncovered parts in start order; empty when the range is covered.
 */
function freeSegments(
  spans: readonly RedactionTextSpan[],
  range: { start: number; end: number },
): { start: number; end: number }[] {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `mid` is below `spans.length`.
    if (spans[mid]!.end <= range.start) lo = mid + 1
    else hi = mid
  }
  const free: { start: number; end: number }[] = []
  let cursor = range.start
  for (let i = lo; i < spans.length && cursor < range.end; i += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `i` is below `spans.length`.
    const span = spans[i]!
    if (span.start >= range.end) break
    if (span.start > cursor) free.push({ start: cursor, end: span.start })
    cursor = Math.max(cursor, span.end)
  }
  if (cursor < range.end) free.push({ start: cursor, end: range.end })
  return free
}

/**
 * The empty span index.
 * @returns an index with no entries and no allocated identities.
 */
export function emptyRedactionIndex<S = number>(): RedactionIndex<S> {
  return { entries: [], lastIds: {}, reserved: [] }
}

/**
 * Fold one recorded scan into an index. Spans and reserved identities are only
 * added, never removed: a span overlapping one already indexed at the same
 * location is ignored, a later detector version replaces only the entry's
 * recorded version, and the first scan's policy digest stays the index policy.
 * Rebuilding an index from the same scans in log order yields the same index.
 * @param index - index covering earlier scans; not mutated.
 * @param scan - the next recorded scan.
 * @returns a new index covering `scan`.
 */
export function foldRedactionScan<S>(index: RedactionIndex<S>, scan: RedactionScan<S>): RedactionIndex<S> {
  const entries = new Map<string, RedactionIndexEntry<S>>(
    index.entries.map(entry => [locationKey(entry), { ...entry, spans: [...entry.spans] }]),
  )
  const lastIds = { ...index.lastIds }
  const entryAt = (location: RedactionLocation<S>): RedactionIndexEntry<S> => {
    const key = locationKey(location)
    const existing = entries.get(key)
    if (existing !== undefined) {
      existing.detectorVersion = scan.detectorVersion
      return existing
    }
    const created = { seq: location.seq, path: location.path, detectorVersion: scan.detectorVersion, spans: [] }
    entries.set(key, created)
    return created
  }
  for (const location of scan.scanned) entryAt(location)
  for (const span of [...scan.spans, ...scan.checkpointSpans]) {
    const entry = entryAt(span)
    const { category, n } = parseId(span.id)
    lastIds[category] = Math.max(lastIds[category] ?? 0, n)
    if (overlaps(span, entry.spans)) continue
    entry.spans.push({ start: span.start, end: span.end, id: span.id })
    entry.spans.sort((a, b) => a.start - b.start)
  }
  return {
    entries: [...entries.values()],
    lastIds,
    reserved: [...new Set([...index.reserved, ...scan.reserved])],
    policyDigest: index.policyDigest ?? scan.policyDigest,
  }
}

/**
 * Mask logged strings. Spans already in `index` for a location scanned by
 * the current detector version are applied without calling the detector;
 * other locations are detected, and spans recorded by an older detector
 * version are kept while new non-overlapping detections are added. Once
 * every value of the call is bound, {@link RedactionDetector.propagate} runs over every text,
 * including the ones whose spans were reused, and the parts of its ranges
 * that no located span covers become new spans of those locations. An
 * original that already has an identity keeps it; a new original receives
 * the next number of its category after every identity in `index` and in
 * the reused spans.
 * A bare `CATEGORY_n` literal of a policy category in a submitted text
 * reserves that identity. The registry is rebuilt from `index` and `texts`
 * on every call, so a Session keeps one identity space as long as every
 * call receives original text and the index of every earlier scan.
 * @param detector - the detection policy.
 * @param texts - the original strings to mask with their log locations; never previously masked text.
 * @param index - recorded span index for the Session holding `texts`.
 * @returns masked strings, new scan facts, applied spans, and the in-memory registry.
 * @throws {RedactionError} `unsupported` when a text contains a placeholder
 *   delimiter; `conflict` when a recorded span does not fit its text, two
 *   originals share one identity, or a bound identity occurs literally;
 *   `policy` when `index` was recorded under another policy. A detector
 *   failure propagates unchanged.
 */
export async function mask<S>(
  detector: RedactionDetector,
  texts: readonly RedactionText<S>[],
  index: RedactionIndex<S>,
): Promise<RedactionMaskResult<S>> {
  if (index.policyDigest !== undefined && index.policyDigest !== detector.policyDigest) {
    throw new RedactionError('policy', `redaction index was recorded under policy ${index.policyDigest}, not ${detector.policyDigest}`)
  }
  const entries = new Map(index.entries.map(entry => [locationKey(entry), entry]))
  const registry = new Registry(index.lastIds, index.reserved)
  const reserved: RedactionId[] = []
  const categories = new Set(detector.categories)
  for (const text of texts) {
    if (text.text.includes(PLACEHOLDER_OPEN) || text.text.includes(PLACEHOLDER_CLOSE)) {
      throw new RedactionError('unsupported', `text at seq ${String(text.seq)} ${text.path} contains a placeholder delimiter`)
    }
    for (const span of entries.get(locationKey(text))?.spans ?? []) {
      if (span.end > text.text.length || span.start < 0 || span.start >= span.end) {
        throw new RedactionError('conflict', `recorded span ${span.id} does not fit the text at seq ${String(text.seq)} ${text.path}`)
      }
      registry.bind(span.id, text.text.slice(span.start, span.end))
    }
  }
  for (const text of texts) {
    for (const match of text.text.matchAll(/(?<![A-Za-z0-9_])([A-Z][A-Z0-9]*)_([1-9]\d*)(?![A-Za-z0-9_])/g)) {
      const id = RedactionId(match[0])
      if (categories.has(match[1] as string) && registry.reserve(id)) reserved.push(id)
    }
  }

  const located: RedactionTextSpan[][] = texts.map(
    text => [...entries.get(locationKey(text))?.spans ?? []].sort((a, b) => a.start - b.start),
  )
  const found: RedactionTextSpan[][] = texts.map(() => [])
  const rescanned: boolean[] = []
  const check = (at: number, detection: RedactionDetection): string => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `at` indexes `texts`.
    const text = texts[at]!.text
    if (!CATEGORY_PATTERN.test(detection.category)) {
      throw new TypeError(`redaction category ${JSON.stringify(detection.category)} must be upper-case`)
    }
    if (detection.start < 0 || detection.end > text.length || detection.start >= detection.end) {
      throw new RangeError(`redaction detection ${detection.start}-${detection.end} is outside its text`)
    }
    return text
  }
  const add = (at: number, range: { start: number; end: number }, category: string, text: string): void => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `at` indexes `texts`.
    const here = located[at]!
    const slot = placeSpan(here, range)
    if (slot < 0) return
    const id = registry.allocate(text.slice(range.start, range.end), category)
    const span = { start: range.start, end: range.end, id }
    here.splice(slot, 0, span)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `at` indexes `texts`.
    found[at]!.push(span)
  }
  const record = (at: number, detection: RedactionDetection): void => {
    add(at, detection, detection.category, check(at, detection))
  }

  for (const [at, text] of texts.entries()) {
    const entry = entries.get(locationKey(text))
    const scan = entry === undefined || entry.detectorVersion !== detector.detectorVersion
    rescanned.push(scan)
    if (!scan) continue
    const detections = [...await detector.detect(text.text)].sort((a, b) => a.start - b.start || b.end - a.end)
    for (const detection of detections) record(at, detection)
  }
  const values = new Map<string, string>()
  for (const id of registry.ids()) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `id` came from the registry.
    values.set(registry.original(id)!, parseId(id).category)
  }
  for (const propagation of await detector.propagate?.(texts.map(text => text.text), values) ?? []) {
    if (!Number.isInteger(propagation.text) || propagation.text < 0 || propagation.text >= texts.length) {
      throw new RangeError(`redaction propagation names text ${String(propagation.text)}, which was not submitted`)
    }
    const at = propagation.text
    const text = check(at, propagation)
    // A propagated range says these bytes repeat a value already known to be
    // sensitive, so the part no span covers is still sensitive. Dropping the
    // whole range would send that part verbatim.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `at` indexes `texts`.
    for (const free of freeSegments(located[at]!, propagation)) add(at, free, propagation.category, text)
  }

  const masked: string[] = []
  const spans: RedactionSpan<S>[] = []
  const scanned: RedactionLocation<S>[] = []
  const applied: RedactionSpan<S>[] = []
  for (const [at, text] of texts.entries()) {
    const location = { seq: text.seq, path: text.path }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- both arrays index `texts`.
    const [these, all] = [found[at]!, located[at]!]
    if (these.length === 0 && rescanned[at] === true) scanned.push(location)
    spans.push(...these.map(span => ({ ...location, ...span })))
    masked.push(applySpans(text.text, all))
    applied.push(...all.map(span => ({ ...location, ...span })))
  }
  return { masked, spans, scanned, reserved, applied, detected: rescanned.filter(Boolean).length, registry }
}

/**
 * Replace every placeholder in a model output with its original. Restoration
 * is strict: an identity outside `registry` or a delimiter that does not form
 * a placeholder rejects the whole output.
 * @param output - masked model output.
 * @param registry - the bindings the output may reference.
 * @returns the restored text with restored ranges and unused identities, or the failure class.
 */
export function restore(output: string, registry: RedactionRegistry): RedactionRestoreResult {
  const pattern = new RegExp(`${PLACEHOLDER_OPEN}([^${PLACEHOLDER_OPEN}${PLACEHOLDER_CLOSE}]*)${PLACEHOLDER_CLOSE}`, 'g')
  const malformed = { ok: false, reason: 'malformed-placeholder', detail: 'output contains a placeholder delimiter outside a placeholder' } as const
  const stray = (segment: string): boolean => segment.includes(PLACEHOLDER_OPEN) || segment.includes(PLACEHOLDER_CLOSE)
  let text = ''
  let cursor = 0
  const spans: RedactionTextSpan[] = []
  const seen = new Set<string>()
  for (const match of output.matchAll(pattern)) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has one capture group.
    const candidate = match[1]!
    const original = ID_PATTERN.test(candidate) ? registry.original(candidate as RedactionId) : undefined
    if (original === undefined) {
      return { ok: false, reason: 'unknown-placeholder', detail: `placeholder identity ${JSON.stringify(candidate)} is not bound` }
    }
    const between = output.slice(cursor, match.index)
    if (stray(between)) return malformed
    text += between
    spans.push({ start: text.length, end: text.length + original.length, id: candidate as RedactionId })
    text += original
    seen.add(candidate)
    cursor = match.index + match[0].length
  }
  const rest = output.slice(cursor)
  if (stray(rest)) return malformed
  return { ok: true, text: text + rest, spans, missing: registry.ids().filter(id => !seen.has(id)) }
}
