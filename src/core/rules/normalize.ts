/**
 * Projections and character predicates shared by the rule passes. The NFKC
 * projection folds one base code point plus its combining marks at a time, and
 * the percent projection decodes `%XX` escapes; both keep a map back to the
 * original offsets, so a span found on a projection names a range of the text
 * the caller submitted.
 *
 * @module redaction-proxy/core/rules/normalize
 */

// Invisible characters the NFKC projection removes: zero-width characters and the soft hyphen.
const ZERO_WIDTH = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff])
const ZERO_WIDTH_PATTERN = /[\u00ad\u200b-\u200d\u2060\ufeff]/g
const COMBINING_MARK = /\p{M}/u
const ALNUM = /[A-Za-z0-9]/
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/

/** A projected text with a map from each projected code unit back to its source range. */
export interface OffsetProjection {
  /** The projected text. */
  norm: string
  /** Original start offset of the source range each `norm` code unit came from. */
  startMap: number[]
  /** Original end offset of the source range each `norm` code unit came from. */
  endMap: number[]
}

/** NFKC projection of one text; `norm` equals the input when nothing folded. */
export interface NfkcProjection extends OffsetProjection {
  /** `norm` lower-cased without changing any character's length. */
  lower: string
}

/**
 * Lower-case a text without changing any character's length, so offsets into
 * the result still name the same characters.
 * @param text - text to lower-case.
 * @returns the text with every length-preserving lower-case mapping applied.
 */
export function lowerPreserving(text: string): string {
  let out = ''
  for (const char of text) {
    const lower = char.toLowerCase()
    out += lower.length === char.length ? lower : char
  }
  return out
}

/**
 * Project a text through NFKC with zero-width characters removed.
 * Whole-string normalization would lose the offsets a span needs, and folding
 * single code points would miss `e` followed by U+0301.
 * @param text - text to project.
 * @returns the projection and its offset maps.
 */
export function projectNfkc(text: string): NfkcProjection {
  const parts: string[] = []
  const startMap: number[] = []
  const endMap: number[] = []
  let i = 0
  while (i < text.length) {
    const start = i
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `i` is below `text.length`.
    let code = text.codePointAt(i)!
    i += code > 0xffff ? 2 : 1
    if (ZERO_WIDTH.has(code)) continue
    for (;;) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- `i` is below `text.length`.
      while (i < text.length && ZERO_WIDTH.has(text.codePointAt(i)!)) i += 1
      if (i >= text.length) break
      // oxlint-disable-next-line typescript/no-non-null-assertion -- `i` is below `text.length`.
      code = text.codePointAt(i)!
      if (!COMBINING_MARK.test(String.fromCodePoint(code))) break
      i += code > 0xffff ? 2 : 1
    }
    const folded = text.slice(start, i).replaceAll(ZERO_WIDTH_PATTERN, '').normalize('NFKC')
    for (let k = 0; k < folded.length; k += 1) {
      startMap.push(start)
      endMap.push(i)
    }
    parts.push(folded)
  }
  const norm = parts.join('')
  return { norm, lower: lowerPreserving(norm), startMap, endMap }
}

const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Byte length of the UTF-8 sequence a lead byte opens.
 * @param lead - one byte.
 * @returns 1 to 4, or 0 when the byte cannot open a sequence.
 */
function utf8Length(lead: number): number {
  if (lead < 0x80) return 1
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 0
}

/**
 * Project a text through one level of percent-decoding. Each run of
 * consecutive `%XX` escapes is decoded one UTF-8 sequence at a time: a valid
 * sequence becomes its character, mapped to the whole escape range its bytes
 * came from, and an escape that cannot start or complete a valid sequence (a
 * truncated `%E6`, a stray `%FF`) is copied as written, mapped 1:1, so the
 * rest of the run still decodes. Literal text and `+` stay as written.
 * @param text - text to project.
 * @returns the projection, or `undefined` when no sequence decodes.
 */
export function projectPercent(text: string): OffsetProjection | undefined {
  let norm = ''
  const startMap: number[] = []
  const endMap: number[] = []
  const copy = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) {
      startMap.push(k)
      endMap.push(k + 1)
    }
    norm += text.slice(from, to)
  }
  let copied = 0
  let decodedAny = false
  PERCENT_RUN.lastIndex = 0
  for (let match = PERCENT_RUN.exec(text); match !== null; match = PERCENT_RUN.exec(text)) {
    copy(copied, match.index)
    const bytes = new Uint8Array(match[0].length / 3)
    for (let k = 0; k < bytes.length; k += 1) bytes[k] = Number.parseInt(match[0].slice(k * 3 + 1, k * 3 + 3), 16)
    for (let k = 0; k < bytes.length;) {
      const at = match.index + 3 * k
      // oxlint-disable-next-line typescript/no-non-null-assertion -- `k` is below `bytes.length`.
      const length = utf8Length(bytes[k]!)
      let char: string | undefined
      if (length > 0 && k + length <= bytes.length) {
        try {
          char = UTF8.decode(bytes.subarray(k, k + length))
        } catch {
          // A bad continuation byte, an overlong form, or a surrogate: the lead
          // escape is copied as written below.
        }
      }
      if (char === undefined) {
        copy(at, at + 3)
        k += 1
        continue
      }
      for (let u = 0; u < char.length; u += 1) {
        startMap.push(at)
        endMap.push(at + 3 * length)
      }
      norm += char
      k += length
      decodedAny = true
    }
    copied = match.index + match[0].length
  }
  if (!decodedAny) return undefined
  copy(copied, text.length)
  return { norm, startMap, endMap }
}

/**
 * Compose two projections: `inner` is a projection of `outer.norm`, and the
 * result maps each code unit of `inner.norm` to the text `outer` projects.
 * @param outer - projection of the submitted text.
 * @param inner - projection of `outer.norm`.
 * @returns `inner.norm` with offsets into the submitted text.
 */
export function composeProjections(outer: OffsetProjection, inner: OffsetProjection): OffsetProjection {
  return {
    norm: inner.norm,
    // oxlint-disable-next-line typescript/no-non-null-assertion -- inner offsets lie inside `outer.norm`.
    startMap: inner.startMap.map(at => outer.startMap[at]!),
    // oxlint-disable-next-line typescript/no-non-null-assertion -- an inner range is never empty.
    endMap: inner.endMap.map(at => outer.endMap[at - 1]!),
  }
}

/**
 * Whether a character is an ASCII letter or digit.
 * @param char - one character, or the empty string past either end of a text.
 * @returns whether the character is `[A-Za-z0-9]`.
 */
export function isAlnum(char: string): boolean {
  return char.length > 0 && ALNUM.test(char)
}

/**
 * Whether every character of a text is printable ASCII.
 * @param text - text to classify.
 * @returns whether the text holds only U+0020 through U+007E.
 */
export function isAsciiPrintable(text: string): boolean {
  return ASCII_PRINTABLE.test(text)
}

/**
 * Shannon entropy of a text over its code points.
 * @param text - text to measure.
 * @returns bits per code point; zero for the empty text.
 */
export function shannon(text: string): number {
  // oxlint-disable-next-line typescript/no-misused-spread -- entropy is measured over code points.
  const chars = [...text]
  const freq = new Map<string, number>()
  for (const char of chars) freq.set(char, (freq.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of freq.values()) {
    const p = count / chars.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * The `\uXXXX` escape spellings of a text, as a JSON or source literal writes it.
 * @param value - text to escape.
 * @returns the lower-case form, and the upper-case hex form when it differs.
 */
export function unicodeEscapeForms(value: string): string[] {
  let lower = ''
  let upper = ''
  for (let i = 0; i < value.length; i += 1) {
    const hex = value.charCodeAt(i).toString(16).padStart(4, '0')
    lower += `\\u${hex}`
    upper += `\\u${hex.toUpperCase()}`
  }
  return lower === upper ? [lower] : [lower, upper]
}
