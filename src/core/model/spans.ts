/**
 * From model scores to spans: per-token category choice, span assembly, the
 * Japanese name-tail cut, and the filters that drop identifier-shaped,
 * allowlisted, and inline-code spans.
 * Pure functions; offsets are UTF-16 code units, end exclusive.
 *
 * @module redaction-proxy/core/model/spans
 */

import type { NameModelCategory } from './config.ts'
import type { TextRange } from './prose.ts'

/** One span the model reports. */
export interface ModelSpan extends TextRange {
  category: NameModelCategory
}

/** One text token with the category it was assigned, if any. */
export interface ScoredToken extends TextRange {
  category: NameModelCategory | undefined
}

/**
 * Which reported category each model class feeds. nym labels are BIO tags
 * over 40 entity types (`B-GIVEN_NAME`, `I-CITY`, ...); only these types are
 * kept. E-mail, phone, key, and card types belong to the rules.
 */
const ENTITY_TYPES: Readonly<Record<NameModelCategory, readonly string[]>> = {
  NAME: ['GIVEN_NAME', 'SURNAME'],
  ORG: ['COMPANY_NAME'],
  LOC: ['CITY', 'STATE', 'COUNTRY'],
  ADDR: ['STREET_ADDRESS', 'STREET_NAME', 'SECONDARY_ADDRESS', 'ZIP_CODE', 'BUILDING_NUMBER'],
}

const BIO_PREFIX_LENGTH = 'B-'.length

/**
 * Map every model class to the category it feeds.
 * @param classLabels - the model's `id2label`, by class index.
 * @param categories - categories to report.
 * @returns per class, its category, or `undefined` for `O` and dropped types.
 */
export function classCategories(
  classLabels: readonly string[],
  categories: readonly NameModelCategory[],
): (NameModelCategory | undefined)[] {
  return classLabels.map(label => {
    const type = label.slice(BIO_PREFIX_LENGTH)
    return categories.find(category => ENTITY_TYPES[category].includes(type))
  })
}

/**
 * Choose one token's category: softmax over its logits, probabilities summed
 * per category (B and I tags of every type the category covers), and the
 * largest sum wins when it reaches the threshold.
 * @param logits - the token's row of class logits.
 * @param classCategory - per class, the category it feeds.
 * @param threshold - minimum summed probability.
 * @returns the winning category, or `undefined`.
 */
export function chooseCategory(
  logits: ArrayLike<number>,
  classCategory: readonly (NameModelCategory | undefined)[],
  threshold: number,
): NameModelCategory | undefined {
  let max = -Infinity
  for (let c = 0; c < logits.length; c += 1) max = Math.max(max, logits[c] as number)
  let total = 0
  const sums = new Map<NameModelCategory, number>()
  for (let c = 0; c < logits.length; c += 1) {
    const weight = Math.exp((logits[c] as number) - max)
    total += weight
    const category = classCategory[c]
    if (category !== undefined) sums.set(category, (sums.get(category) ?? 0) + weight)
  }
  let best: NameModelCategory | undefined
  let bestSum = threshold * total
  for (const [category, sum] of sums) {
    if (sum >= bestSum) [best, bestSum] = [category, sum]
  }
  return best
}

/**
 * Shrink a range to exclude surrounding whitespace.
 * @param text - the text the range indexes.
 * @param span - the span.
 * @returns the trimmed span; empty when it held only whitespace.
 */
function trimWhitespace(text: string, span: ModelSpan): ModelSpan {
  let { start, end } = span
  while (start < end && /\s/.test(text.charAt(start))) start += 1
  while (end > start && /\s/.test(text.charAt(end - 1))) end -= 1
  return { ...span, start, end }
}

/**
 * Join same-category spans that overlap or are separated only by spaces or
 * tabs, never across a newline, so `Jane` + `Doe` becomes one name.
 * @param spans - spans of one text.
 * @param text - the text.
 * @returns joined spans in start order.
 */
function joinAdjacent(spans: readonly ModelSpan[], text: string): ModelSpan[] {
  const joined: ModelSpan[] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = joined.at(-1)
    const touches = last !== undefined && last.category === span.category
      && (span.start <= last.end || /^[ \t]*$/.test(text.slice(last.end, span.start)))
    if (touches) last.end = Math.max(last.end, span.end)
    else joined.push({ ...span })
  }
  return joined
}

/**
 * Assemble spans from scored tokens: a run of tokens of one category whose
 * ranges touch is one span; spans are trimmed and then joined.
 * @param tokens - text tokens in order, with their chosen categories.
 * @param text - the text the token offsets index.
 * @returns spans in start order.
 */
export function assembleSpans(tokens: readonly ScoredToken[], text: string): ModelSpan[] {
  const runs: ModelSpan[] = []
  let current: ModelSpan | undefined
  for (const token of tokens) {
    if (token.category === undefined || token.end <= token.start) {
      current = undefined
    } else if (current !== undefined && current.category === token.category && token.start <= current.end) {
      current.end = Math.max(current.end, token.end)
    } else {
      runs.push(current = { start: token.start, end: token.end, category: token.category })
    }
  }
  const trimmed = runs.map(span => trimWhitespace(text, span)).filter(span => span.end > span.start)
  return joinAdjacent(trimmed, text)
}

/** Honorifics and particles Japanese writes right after a name, which a name span can run over (`佐藤美咲さんに`). */
const JAPANESE_NAME_TAIL = /(?:さん|さま|様|くん|君|ちゃん|氏|先生)?[にはがをのへともで]*$/u

/**
 * Cut honorifics and particles off the end of NAME spans in Japanese text, so
 * `佐藤美咲さんに` becomes `佐藤美咲` and a reply writing `⟦NAME_1⟧さん`
 * restores correctly. Only text holding hiragana is Japanese here: in Chinese,
 * `君`, `氏`, and `先生` can end a name. A cut is kept only when the rest ends
 * in Han or katakana, so a name written in hiragana keeps its last character.
 * @param spans - spans of one text.
 * @param text - the text.
 * @returns the spans with NAME tails cut.
 */
export function trimJapaneseNameTails(spans: readonly ModelSpan[], text: string): ModelSpan[] {
  if (!/\p{Script=Hiragana}/u.test(text)) return [...spans]
  return spans.map(span => {
    if (span.category !== 'NAME') return span
    const value = text.slice(span.start, span.end)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern also matches the empty tail.
    const end = span.end - JAPANESE_NAME_TAIL.exec(value)![0].length
    return /[\p{Script=Han}\p{Script=Katakana}]$/u.test(text.slice(span.start, end)) ? { ...span, end } : span
  })
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/

/**
 * Whether a span is part of, or shaped like, a code identifier: it touches an
 * identifier character on either side (`WangService`), or it is camelCase,
 * snake_case, or dotted.
 * @param span - the span.
 * @param text - the text.
 * @returns whether it looks like an identifier.
 */
function isIdentifierShaped(span: TextRange, text: string): boolean {
  const value = text.slice(span.start, span.end)
  if (IDENTIFIER_CHAR.test(text.charAt(span.start - 1)) && /^[A-Za-z0-9]/.test(value)) return true
  if (IDENTIFIER_CHAR.test(text.charAt(span.end)) && /[A-Za-z0-9]$/.test(value)) return true
  return /^[A-Za-z_$][\w$.]*$/.test(value) && /[a-z][A-Z]|_|\w\.\w/.test(value)
}

/** Distance in characters within which another span makes a digit run part of an address. */
const NEIGHBOUR_REACH = 3

/**
 * Whether a span is code-shaped rather than a name: all lower-case ASCII,
 * holding a slash, or only digits and punctuation with no other span within
 * reach (`8` goes; the `100` of `世紀大道100號` stays).
 * @param span - the span.
 * @param text - the text.
 * @param others - the other spans of the text.
 * @returns whether it is code-shaped.
 */
function isCodeShaped(span: TextRange, text: string, others: readonly TextRange[]): boolean {
  const value = text.slice(span.start, span.end)
  if (/^[a-z]+$/.test(value) || /[/\\]/.test(value)) return true
  const lone = !others.some(other => other !== span
    && other.start <= span.end + NEIGHBOUR_REACH && other.end >= span.start - NEIGHBOUR_REACH)
  return lone && /^[\p{N}\p{P}\p{S}\s]+$/u.test(value)
}

/**
 * Drop identifier-shaped and code-shaped spans.
 * @param spans - spans of one text.
 * @param text - the text.
 * @returns the spans that read as names, organizations, or places.
 */
export function dropCodeShaped(spans: readonly ModelSpan[], text: string): ModelSpan[] {
  const kept = spans.filter(span => !isIdentifierShaped(span, text))
  return kept.filter(span => !isCodeShaped(span, text, kept))
}

/**
 * Drop spans whose whole text is allowlisted.
 * @param spans - spans of one text.
 * @param text - the text.
 * @param allowlist - lower-cased literals.
 * @returns the spans not allowlisted.
 */
export function dropAllowlisted(spans: readonly ModelSpan[], text: string, allowlist: ReadonlySet<string>): ModelSpan[] {
  return spans.filter(span => !allowlist.has(text.slice(span.start, span.end).toLowerCase()))
}

/**
 * Whether two ranges overlap.
 * @param a - one range.
 * @param b - another range.
 * @returns whether they share a code unit.
 */
function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Drop spans that overlap any of the given ranges.
 * @param spans - candidate spans.
 * @param ranges - ranges that win, such as inline code or rules detections.
 * @returns the spans clear of every range.
 */
export function dropOverlapping<T extends TextRange>(spans: readonly T[], ranges: readonly TextRange[]): T[] {
  return spans.filter(span => !ranges.some(range => rangesOverlap(span, range)))
}
