/**
 * The pattern rules other than the credential rule: home paths, email
 * addresses, Taiwan identification and business numbers, telephone numbers,
 * payment card numbers, private addresses, internal host names, high-entropy
 * runs, and configured literal terms.
 *
 * @module redaction-proxy/core/rules/rules
 */

import { isAlnum, isAsciiPrintable, projectNfkc, shannon, unicodeEscapeForms } from './normalize.ts'
import type { PushCandidate } from './candidate.ts'
import { PRIORITY_ENTROPY, PRIORITY_PII, PRIORITY_SECRET, PRIORITY_TERM } from './candidate.ts'

/**
 * Longest digit run a card window may be cut out of when it is not aligned to
 * the run's group separators.
 */
const CARD_SLIDE_MAX = 23
/** Longest host name, which bounds the walk back from a matched suffix. */
const HOST_NAME_MAX = 253

const HOME = /(?<![.\-])(?:[a-z]:)?(?:\\\/|\\{1,2}|\/)(?:users|home)(?:\\\/|\\{1,2}|\/)[^/\\\s"'`,;()[\]{}<>|*?:]+/gi
const HOME_TILDE = /(?<![.\-\w])~[A-Za-z][^/\\\s"'`,;()[\]{}<>|*?:~]*(?=\/)/g
// Anchored on `@` and expanded in JavaScript: a greedy local part followed by a
// required `@` would rescan every start position of a text that has no `@`.
const EMAIL_AT = /@/g
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/
const EMAIL_DOMAIN_CHAR = /[A-Za-z0-9.-]/
const EMAIL_DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
/** Longest local part and domain the expansion reads either side of the `@`. */
const EMAIL_LOCAL_MAX = 128
const EMAIL_DOMAIN_MAX = 256

const TWID = /(?<![A-Za-z0-9])[A-Z][1289]\d{8}(?![A-Za-z0-9])/g
/** A separator inside a telephone number: a hyphen, an ideographic space, or a space. */
const PHONE_GAP = '[-\\u3000 ]?'
const PHONE_MOBILE = new RegExp(
  `(?<!\\d)(?:09\\d{2}${PHONE_GAP}\\d{3}${PHONE_GAP}\\d{3}`
  + `|\\+886${PHONE_GAP}(?:9\\d{2}${PHONE_GAP}\\d{3}${PHONE_GAP}\\d{3}`
  + `|\\d{1,2}${PHONE_GAP}\\d{3,4}${PHONE_GAP}\\d{3,4}))(?!\\d)`,
  'g',
)
const PHONE_KEYWORD = new RegExp(
  '(?:電話|电话|手機|手机|傳真|传真|聯絡|联络|phone|tel|fax|mobile)'
  + '[^\\n]{0,8}?(\\(?(?<!\\d)0\\d{1,2}\\)?[-\\s]{0,2}\\d{3,4}[-\\s]?\\d{3,4}(?!\\d))',
  'gi',
)
const TAX_ID = /(?:統一編號|統編|營利事業|tax[ _-]?id|taxid|vat)[^\n]{0,8}?((?<!\d)\d{8}(?!\d))/gi
const CARD_RUN = /(?<!\d)\d{4,}(?:[ -]\d{3,})*/g
const PRIVATE_IP = new RegExp(
  '(?<![\\d.])(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}'
  + '|192\\.168\\.\\d{1,3}\\.\\d{1,3}'
  + '|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})(?![\\d.])',
  'g',
)
const HOST_SUFFIX = /\.(?:local|lan|internal)(?![a-z0-9-])/gi
const HOST_CHAR = /[A-Za-z0-9.-]/
const HOST_FIRST_WORD = /^[A-Za-z0-9_$]+/
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g
const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g
const SUBRESOURCE_PREFIX = /sha\d{3}-$/

const SHA_CONTEXT = /commit|sha|hash|rev|digest|checksum|blob|tree|oid|integrity|etag/i
const SECRET_CONTEXT = /secret|token|password|api[_-]?key|authorization|credential/i

/** Identifiers whose member access reads as code rather than a host name. */
const HOST_CODE_ROOTS = new Set(['this', 'ctx', 'self', 'globalThis', 'window', 'req', 'res', 'opts', 'config'])

/** Letter values of the Taiwan identification-number checksum. */
const TW_LETTER_VALUES = 'ABCDEFGHJKLMNPQRSTUVXYWZIO'

/** One configured literal term and the category it is masked under. */
export interface ConfiguredTerm {
  /** The literal text, matched case-insensitively on the NFKC projection. */
  value: string
  /** Placeholder category, `TERM` or `PROJECT`. */
  category: string
}

/**
 * Whether a ten-character candidate passes the Taiwan identification-number
 * checksum. National numbers carry `1` or `2`; resident certificate numbers
 * issued since 2021 carry `8` or `9`.
 * @param candidate - one upper-case letter, `1`, `2`, `8`, or `9`, and eight digits.
 * @returns whether the weighted checksum is divisible by ten.
 */
export function isTaiwanNationalId(candidate: string): boolean {
  if (!/^[A-Z][1289]\d{8}$/.test(candidate)) return false
  const code = TW_LETTER_VALUES.indexOf(candidate.charAt(0)) + 10
  const digits = `${Math.floor(code / 10)}${code % 10}${candidate.slice(1)}`
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1]
  let sum = 0
  for (const [i, weight] of weights.entries()) sum += (digits.charCodeAt(i) - 48) * weight
  return sum % 10 === 0
}

/**
 * Whether a digit run passes the Luhn checksum.
 * @param digits - decimal digits only.
 * @returns whether the checksum is divisible by ten.
 */
function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Whether a digit run opens with an issuer prefix a payment card uses.
 * @param digits - decimal digits only.
 * @returns whether the run starts with 3 to 6, or with 2221 through 2720.
 */
function validCardPrefix(digits: string): boolean {
  if ('3456'.includes(digits.charAt(0))) return true
  const four = Number(digits.slice(0, 4))
  return four >= 2221 && four <= 2720
}

/**
 * Run one global pattern over a text and hand every match to a handler.
 * @param pattern - a global pattern; its `lastIndex` is reset first.
 * @param text - text to scan.
 * @param handler - called once per match in source order.
 */
function runAll(pattern: RegExp, text: string, handler: (match: RegExpExecArray) => void): void {
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) handler(match)
}

/**
 * Mask only a home directory's prefix so the directory structure survives.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
export function collectPathCandidates(text: string, push: PushCandidate): void {
  for (const pattern of [HOME, HOME_TILDE]) {
    runAll(pattern, text, (match) => {
      push(match.index, match.index + match[0].length, 'PATH', PRIORITY_PII)
    })
  }
}

/**
 * Expand every `@` into an address and keep the ones with a valid domain.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
export function collectEmailCandidates(text: string, push: PushCandidate): void {
  runAll(EMAIL_AT, text, (match) => {
    let start = match.index
    while (start > 0 && start > match.index - EMAIL_LOCAL_MAX && EMAIL_LOCAL.test(text.charAt(start - 1))) start -= 1
    let end = match.index + 1
    while (end < text.length && end < match.index + EMAIL_DOMAIN_MAX && EMAIL_DOMAIN_CHAR.test(text.charAt(end))) end += 1
    while (end > match.index + 1 && (text.charAt(end - 1) === '.' || text.charAt(end - 1) === '-')) end -= 1
    if (start === match.index) return
    if (!EMAIL_DOMAIN.test(text.slice(match.index + 1, end))) return
    push(start, end, 'EMAIL', PRIORITY_PII)
  })
}

/**
 * Collect checksum-valid identification numbers, telephone numbers, and
 * business numbers.
 * @param text - text to scan.
 * @param rules - which of `tw-national-id`, `phone`, and `tax-id` are enabled.
 * @param push - candidate sink.
 */
export function collectNumberCandidates(text: string, rules: ReadonlySet<string>, push: PushCandidate): void {
  if (rules.has('tw-national-id')) {
    runAll(TWID, text, (match) => {
      if (!isTaiwanNationalId(match[0])) return
      push(match.index, match.index + match[0].length, 'TWID', PRIORITY_PII)
    })
  }
  if (rules.has('phone')) {
    runAll(PHONE_MOBILE, text, (match) => {
      push(match.index, match.index + match[0].length, 'PHONE', PRIORITY_PII)
    })
    runAll(PHONE_KEYWORD, text, (match) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has one group.
      const value = match[1]!
      const at = match.index + match[0].lastIndexOf(value)
      push(at, at + value.length, 'PHONE', PRIORITY_PII)
    })
  }
  if (rules.has('tax-id')) {
    runAll(TAX_ID, text, (match) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has one group.
      const value = match[1]!
      const at = match.index + match[0].lastIndexOf(value)
      push(at, at + value.length, 'TAXID', PRIORITY_PII)
    })
  }
}

/**
 * Collect payment card numbers. Each window is anchored to the digit run's
 * start, a group separator, or a single leading `0`, and ends at the run's end,
 * a separator, or at most four digits before it. Free sliding masked 47% of
 * nanosecond timestamps and 99% of all-digit identifiers, because any 13 to 19
 * digits pass Luhn one time in ten.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
export function collectCardCandidates(text: string, push: PushCandidate): void {
  runAll(CARD_RUN, text, (match) => {
    const run = match[0]
    const digits: string[] = []
    const offsets: number[] = []
    const boundaries = new Set([0])
    for (let i = 0; i < run.length; i += 1) {
      const code = run.charCodeAt(i)
      if (code >= 48 && code <= 57) {
        digits.push(run.charAt(i))
        offsets.push(match.index + i)
      } else boundaries.add(digits.length)
    }
    boundaries.add(digits.length)
    const joined = digits.join('')
    const separated = digits.length < run.length
    for (let start = 0; start + 13 <= joined.length;) {
      let taken = 0
      for (let length = Math.min(19, joined.length - start); length >= 13; length -= 1) {
        const rest = joined.length - start - length
        const aligned = boundaries.has(start) && boundaries.has(start + length)
        if (!aligned && joined.length > CARD_SLIDE_MAX) continue
        const startOk = start === 0 || boundaries.has(start) || (start === 1 && joined.charAt(0) === '0')
        const endOk = rest === 0 || boundaries.has(start + length) || (rest <= 4 && separated)
        if (!startOk || !endOk) continue
        const candidate = joined.slice(start, start + length)
        if (!validCardPrefix(candidate) || !luhn(candidate)) continue
        // oxlint-disable-next-line typescript/no-non-null-assertion -- both indexes are inside the run.
        push(offsets[start]!, offsets[start + length - 1]! + 1, 'CARD', PRIORITY_PII)
        taken = length
        break
      }
      start += taken > 0 ? taken : 1
    }
  })
}

/**
 * Collect private addresses, and internal host names anchored on their suffix.
 * @param text - text to scan.
 * @param rules - which of `ip` and `host` are enabled.
 * @param push - candidate sink.
 */
export function collectNetworkCandidates(text: string, rules: ReadonlySet<string>, push: PushCandidate): void {
  if (rules.has('ip')) {
    runAll(PRIVATE_IP, text, (match) => {
      if (match[0].split('.').some(octet => Number(octet) > 255)) return
      push(match.index, match.index + match[0].length, 'IP', PRIORITY_PII)
    })
  }
  if (!rules.has('host')) return
  // Anchor on the suffix and walk back, so a long dotted run stays linear.
  runAll(HOST_SUFFIX, text, (match) => {
    const floor = Math.max(0, match.index - HOST_NAME_MAX)
    let start = match.index
    while (start > floor && HOST_CHAR.test(text.charAt(start - 1))) start -= 1
    const end = match.index + match[0].length
    if (start === match.index) return
    if (text.charAt(start - 1) === '.') return
    if (text.charAt(end) === '(') return
    const first = HOST_FIRST_WORD.exec(text.slice(start))
    if (first !== null && HOST_CODE_ROOTS.has(first[0])) return
    push(start, end, 'HOST', PRIORITY_PII)
  })
}

/**
 * Collect high-entropy runs. A run beside credential words is a credential; a
 * 32, 40, or 64 digit hexadecimal run beside revision words is a digest.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
export function collectEntropyCandidates(text: string, push: PushCandidate): void {
  const contextAround = (start: number, end: number): string =>
    text.slice(Math.max(0, start - 32), start) + text.slice(end, Math.min(text.length, end + 32))

  runAll(HEX_RUN, text, (match) => {
    const end = match.index + match[0].length
    if (text.charAt(match.index - 1) === '/') return
    const context = contextAround(match.index, end)
    if (SECRET_CONTEXT.test(context)) {
      push(match.index, end, 'KEY', PRIORITY_SECRET)
      return
    }
    if ([32, 40, 64].includes(match[0].length) && SHA_CONTEXT.test(context)) return
    push(match.index, end, 'ENTROPY', PRIORITY_ENTROPY)
  })

  runAll(BASE64_RUN, text, (match) => {
    const end = match.index + match[0].length
    const body = match[0]
    // No leading-slash test: `/` is inside the run's character class, so a run
    // preceded by one would have started at the slash.
    if (SUBRESOURCE_PREFIX.test(text.slice(Math.max(0, match.index - 8), match.index))) return
    if (!/[a-z]/.test(body) || !/[A-Z]/.test(body) || !/[0-9]/.test(body)) return
    if (shannon(body) < 4.2) return
    const context = contextAround(match.index, end)
    if (SECRET_CONTEXT.test(context)) {
      push(match.index, end, 'KEY', PRIORITY_SECRET)
      return
    }
    if (SHA_CONTEXT.test(context)) return
    push(match.index, end, 'ENTROPY', PRIORITY_ENTROPY)
  })
}

/**
 * Collect configured literal terms. Terms match on the NFKC projection so a
 * full-width or zero-width spelling still matches, and a non-ASCII term also
 * matches its `\uXXXX` escape spelling.
 * @param text - text to scan.
 * @param terms - configured terms with their categories.
 * @param push - candidate sink.
 */
export function collectTermCandidates(text: string, terms: readonly ConfiguredTerm[], push: PushCandidate): void {
  if (terms.length === 0) return
  const projection = projectNfkc(text)
  let lowerText: string | undefined
  for (const term of terms) {
    // Configuration refuses a term that projects to nothing, so the needle is never empty.
    const needle = projectNfkc(term.value).lower
    for (let at = projection.lower.indexOf(needle); at >= 0; at = projection.lower.indexOf(needle, at + 1)) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
      push(projection.startMap[at]!, projection.endMap[at + needle.length - 1]!, term.category, PRIORITY_TERM)
    }
    if (isAsciiPrintable(term.value)) continue
    lowerText ??= text.toLowerCase()
    for (const form of unicodeEscapeForms(term.value)) {
      const target = form.toLowerCase()
      for (let at = lowerText.indexOf(target); at >= 0; at = lowerText.indexOf(target, at + 1)) {
        push(at, at + target.length, term.category, PRIORITY_TERM)
      }
    }
  }
}

/**
 * Whether a value's alphanumeric edges are free, so masking it at this position
 * would not cut a longer token in half.
 * @param text - text holding the occurrence.
 * @param start - inclusive start offset of the occurrence.
 * @param end - exclusive end offset of the occurrence.
 * @param value - the value itself.
 * @returns whether the occurrence stands on its own.
 */
export function hasFreeEdges(text: string, start: number, end: number, value: string): boolean {
  if (isAlnum(value.charAt(0)) && isAlnum(text.charAt(start - 1))) return false
  if (isAlnum(value.charAt(value.length - 1)) && isAlnum(text.charAt(end))) return false
  return true
}
