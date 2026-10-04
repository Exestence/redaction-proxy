/**
 * Projections and character predicates shared by the rule passes. The NFKC
 * projection folds one base code point plus its combining marks at a time, and
 * the percent projection decodes `%XX` escapes; both keep a map back to the
 * original offsets, so a span found on a projection names a range of the text
 * the caller submitted.
 *
 * @module redaction-proxy/core/rules/normalize
 */

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff])
const ZERO_WIDTH_PATTERN = /[\u200b-\u200d\u2060\ufeff]/g
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
 * Project a text through one level of percent-decoding. Every run of
 * consecutive `%XX` escapes is decoded as UTF-8; a run that is not valid UTF-8
 * stays as written, and `+` stays literal. Each decoded character maps to the
 * whole escape range its bytes came from, so a span found on the projection
 * names the encoded text.
 * @param text - text to project.
 * @returns the projection, or `undefined` when no run decodes.
 */
export function projectPercent(text: string): OffsetProjection | undefined {
  let norm = ''
  const startMap: number[] = []
  const endMap: number[] = []
  let copied = 0
  let decodedAny = false
  PERCENT_RUN.lastIndex = 0
  for (let match = PERCENT_RUN.exec(text); match !== null; match = PERCENT_RUN.exec(text)) {
    const run = match[0]
    const bytes = new Uint8Array(run.length / 3)
    for (let k = 0; k < bytes.length; k += 1) bytes[k] = Number.parseInt(run.slice(k * 3 + 1, k * 3 + 3), 16)
    let decoded: string
    try {
      decoded = UTF8.decode(bytes)
    } catch {
      // Invalid UTF-8 (a truncated or stray byte): the run is kept as written,
      // and the literal pass already covers it.
      continue
    }
    for (let k = copied; k < match.index; k += 1) {
      startMap.push(k)
      endMap.push(k + 1)
    }
    norm += text.slice(copied, match.index)
    let at = match.index
    for (const char of decoded) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- `char` is one code point.
      const code = char.codePointAt(0)!
      const end = at + 3 * (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4)
      for (let k = 0; k < char.length; k += 1) {
        startMap.push(at)
        endMap.push(end)
      }
      at = end
    }
    norm += decoded
    copied = match.index + run.length
    decodedAny = true
  }
  if (!decodedAny) return undefined
  for (let k = copied; k < text.length; k += 1) {
    startMap.push(k)
    endMap.push(k + 1)
  }
  norm += text.slice(copied)
  return { norm, startMap, endMap }
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
