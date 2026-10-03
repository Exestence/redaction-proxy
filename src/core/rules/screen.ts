/**
 * Input screening: the character classes the rules cannot reason about. A text
 * carrying one is refused whole rather than masked in part, because the part
 * the rules cannot read is exactly the part that may carry a value.
 *
 * @module redaction-proxy/core/rules/screen
 */

/** Why one text cannot be masked, and where the offending character sits. */
export interface ScreenFailure {
  /** The class of character, for a diagnostic that never names the text. */
  reason: 'NUL character' | 'replacement character' | 'lone surrogate' | 'control character'
  /** UTF-16 offset of the first offending character. */
  at: number
}

/**
 * Screen one text for characters the rules cannot reason about.
 * @param text - one submitted string.
 * @returns the first failure, or `undefined` when the text is maskable.
 */
export function screenText(text: string): ScreenFailure | undefined {
  const nul = text.indexOf('\u0000')
  if (nul >= 0) return { reason: 'NUL character', at: nul }
  const replacement = text.indexOf('\uFFFD')
  if (replacement >= 0) return { reason: 'replacement character', at: replacement }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return { reason: 'lone surrogate', at: i }
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return { reason: 'lone surrogate', at: i }
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return { reason: 'control character', at: i }
  }
  return undefined
}
