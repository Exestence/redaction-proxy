/**
 * The pattern rules other than the credential rule: home paths, email
 * addresses, Taiwan identification and business numbers, telephone numbers,
 * payment card numbers, private addresses, internal host names, high-entropy
 * runs, and configured literal terms.
 *
 * @module redaction-proxy/core/rules/rules
 */

import { afterHighEscape, endsHighEscape, isAlnum, isAsciiPrintable, projectNfkc, shannon, unicodeEscapeForms } from './normalize.ts'
import type { PushCandidate } from './candidate.ts'
import { isTaiwanBusinessNumber, isTaiwanNationalId, luhn } from './checksum.ts'
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
// Anchored on the `@` (or a bracketed `at`) and expanded in JavaScript: a
// greedy local part followed by a required `@` would rescan every start
// position of a text that has no `@`. Whitespace around a bracketed `at` is
// walked in JavaScript too, so a long whitespace run is not rescanned per position.
const EMAIL_AT = /[@＠]|[([]at[)\]]/gi
const EMAIL_SPACE = /[ \t\u3000]/
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/
const EMAIL_DOMAIN_CHAR = /[A-Za-z0-9.-]/
const EMAIL_DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
/** A domain whose dots may be spelled `[dot]` or `(dot)`, read from a sticky position. */
const EMAIL_SPELLED_DOMAIN = /[A-Za-z0-9-]+(?:(?:\.|\s*[([]dot[)\]]\s*)[A-Za-z0-9-]+)*/iy
const EMAIL_SPELLED_DOT = /\s*[([]dot[)\]]\s*/gi
const EMAIL_SPELLED_DOT_AT = /\s*[([]dot[)\]]/iy
/**
 * Top-level domains an obfuscated address may end in: any two-letter country
 * code, or one of these. Code and file names (`x(at)self.weight`) end in
 * other words.
 */
const EMAIL_SPELLED_TLD = /^(?:[a-z]{2}|com|net|org|edu|gov|mil|info|biz|dev|app|cloud|tech|site|online|xyz|test|example)$/i
/**
 * Local part of an address spaced from its `(at)` or `[at]`: letter-led words
 * joined by `.`, `_`, or `+`, so a lone English word (`find us (at) shop.tw`)
 * or a version (`v1.2`) is not one.
 */
const EMAIL_WORD_LOCAL = /^[A-Za-z][A-Za-z0-9]*(?:[._+][A-Za-z][A-Za-z0-9]*)+$/
/** Last local-part segments that name a file, not a mailbox (`package.json [at] github.com`). */
const EMAIL_FILE_SUFFIX = /\.(?:json|js|ts|mjs|cjs|md|py|txt|ya?ml|html|css|sh|lock|toml|tar|gz|zip)$/i
/** Longest local part and domain the expansion reads either side of the `@`. */
const EMAIL_LOCAL_MAX = 128
const EMAIL_DOMAIN_MAX = 256

const TWID = /(?<![A-Za-z0-9])[A-Z][1289]\d{8}(?![A-Za-z0-9])/g
/**
 * An identification number with one separator, after the letter
 * (`A 123456789`) or after the fourth character (`A123-456789`), the two
 * places forms and OCR put one. Any other split is not matched.
 */
const TWID_SPLIT = /(?<![A-Za-z0-9-])[A-Z](?:[- \u3000][1289]\d{8}|[1289]\d{2}[- \u3000]\d{6})(?![A-Za-z0-9]|[- \u3000]\d)/g
/** A separator inside a telephone number: a hyphen, an ideographic space, or a space. */
const PHONE_GAP = '[-\\u3000 ]?'
const PHONE_MOBILE = new RegExp(
  `(?<![0-9A-Za-z])(?:09\\d{2}${PHONE_GAP}\\d{3}${PHONE_GAP}\\d{3}`
  + `|\\+886${PHONE_GAP}(?:9\\d{2}${PHONE_GAP}\\d{3}${PHONE_GAP}\\d{3}`
  + `|\\d{1,2}${PHONE_GAP}\\d{3,4}${PHONE_GAP}\\d{3,4}))(?![0-9A-Za-z])`,
  'g',
)
/**
 * A mobile number grouped 2-4-4 with one consistent separator: `09-1234-5678`,
 * `09 1234 5678`. Not a group of a longer run such as a UUID.
 */
const PHONE_MOBILE_SPLIT = /(?<![A-Za-z0-9-])09([- \u3000])(\d{4})\1\d{4}(?![A-Za-z0-9]|\1\d|-[A-Za-z0-9])/g
/** A middle group that reads as a year, which makes `09-2026-1005` a date. */
const PHONE_YEAR = /^(?:19|20)\d\d$/
/** Characters between a keyword and its value: a colon, a space, a short word such as `is`. */
export const KEYWORD_GAP = '[^\\n]{0,8}?'
const PHONE_KEYWORD = new RegExp(
  '(?:電話|电话|手機|手机|傳真|传真|聯絡|联络|phone|tel|fax|mobile)'
  + `${KEYWORD_GAP}(\\(?(?<!\\d)0\\d{1,2}\\)?[-\\s]{0,2}\\d{3,4}[-\\s]?\\d{3,4}(?!\\d))`,
  'gi',
)
const TAX_ID = new RegExp(
  `(?:統一編號|統編|營利事業|tax[ _-]?id|taxid|vat)${KEYWORD_GAP}`
  + '((?<!\\d)(?:\\d{8}(?!\\d)|\\d{1,7}[- \\u3000]\\d{1,7}(?!\\d|[- \\u3000]\\d)))',
  'gi',
)
const CARD_RUN = /(?<!\d)\d{4,}(?:[ -]\d{3,})*/g
/**
 * Digit groups of any length joined by a space, a `-` or `.` with at most one
 * space on each side, or a line break with its indentation: a card number as
 * a person regroups, dots, mixes, or wraps it.
 */
const CARD_SPELLED_RUN = /(?<!\d)\d+(?:(?: ?[-.] ?| |[ \t]*\r?\n[ \t]*)\d+)+/g
/** Most digit groups a regrouped card is read from; `hexdump` rows and IPv4 pairs have eight. */
const CARD_SPELLED_GROUPS_MAX = 6
const PRIVATE_IP = new RegExp(
  '(?<![\\d.])(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}'
  + '|192\\.168\\.\\d{1,3}\\.\\d{1,3}'
  + '|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})(?![\\d.])',
  'g',
)
/**
 * Variants of the rules with an ASCII left boundary that match right after a
 * high escape: `%E6` or `%FF` before a value is a stray byte, not a letter or
 * digit of a longer token. Only digit-initial values get a variant: in Big5
 * and Shift-JIS an ASCII letter after a lead byte is the character's trail
 * byte (`%A4A` is 乙), so a letter-initial identification number has none.
 */
const PHONE_MOBILE_AFTER_ESCAPE = afterHighEscape(PHONE_MOBILE, '(?<![0-9A-Za-z])')
const TAX_ID_AFTER_ESCAPE = afterHighEscape(TAX_ID, '(?<!\\d)')
const CARD_RUN_AFTER_ESCAPE = afterHighEscape(CARD_RUN, '(?<!\\d)')
const CARD_SPELLED_RUN_AFTER_ESCAPE = afterHighEscape(CARD_SPELLED_RUN, '(?<!\\d)')
const PHONE_MOBILE_SPLIT_AFTER_ESCAPE = afterHighEscape(PHONE_MOBILE_SPLIT, '(?<![A-Za-z0-9-])')
const PHONE_KEYWORD_AFTER_ESCAPE = afterHighEscape(PHONE_KEYWORD, '(?<!\\d)')
const PRIVATE_IP_AFTER_ESCAPE = afterHighEscape(PRIVATE_IP, '(?<![\\d.])')
/**
 * Group lengths of a printed card number, joined by commas: fours with an
 * optional short last group, or the 4-6-5 and 4-6-4 groupings of American
 * Express and Diners Club.
 */
const CARD_GROUPING = /^4(?:,4){2,3}(?:,[34])?$|^4,6,[45]$/
/** A character that glues a digit run to a longer token: a letter or `_`. */
const TOKEN_CHAR = /[A-Za-z_]/
/** The two characters before a digit run that opens a revision range (`a1b2..`) or is the fraction of a decimal number. */
const RANGE_OR_DECIMAL_POINT = /^[.\d]\.$/
const HOST_SUFFIX = /\.(?:local|lan|internal)(?![a-z0-9-])/gi
const HOST_CHAR = /[A-Za-z0-9.-]/
const HOST_FIRST_WORD = /^[A-Za-z0-9_$]+/
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g
const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g
const SUBRESOURCE_PREFIX = /sha\d{3}-$/
/** Hexadecimal lengths of SHA-1 and SHA-256 digests, which git object ids and content hashes have. */
const DIGEST_HEX_LENGTHS = [40, 64]
/** Hexadecimal length of a SHA-1 commit id, which pins a dependency after `@` (`actions/checkout@<sha>`). */
const GIT_COMMIT_HEX_LENGTH = 40
/**
 * Line text before a value keyed by a file name, as translation catalogs
 * record source hashes: `README.md: `, `  docs/x.zh.md: "`, and the same
 * line behind a diff's `+` or `-` marker.
 */
const FILE_NAME_KEY = /(?:^[+-]?|\s)[\w./-]*\.[A-Za-z0-9]{1,8}["']?\s*:\s*["']?$/
/** How far back on the line the file-name key is looked for. */
const FILE_NAME_KEY_MAX = 128

const SHA_CONTEXT = /commit|sha|hash|rev|digest|checksum|blob|tree|oid|integrity|etag/i
const SECRET_CONTEXT = /secret|token|password|api[_-]?key|authorization|credential/i

/** Identifiers whose member access reads as code rather than a host name. */
const HOST_CODE_ROOTS = new Set(['this', 'ctx', 'self', 'globalThis', 'window', 'req', 'res', 'opts', 'config'])

/** Separators a configured term's parts may be joined or split by. */
const TERM_SEPARATOR = '[\\s\\-_‧・·]'
const TERM_SEPARATORS = /[\s\-_‧・·]+/g
/** One CJK character, which is a part of its own: CJK text has no word spaces. */
const TERM_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** One configured literal term and the category it is masked under. */
export interface ConfiguredTerm {
  /** The literal text, matched case-insensitively on the NFKC projection. */
  value: string
  /** Placeholder category, such as `TERM` or `PROJECT`. */
  category: string
}

/**
 * Split a projected, lower-cased term into the parts a separator may fall
 * between: at existing separators, at every change between letters, digits,
 * and CJK, and around every CJK character.
 * @param needle - the term's lower-cased NFKC projection.
 * @returns the parts in order, without separators.
 */
function termParts(needle: string): string[] {
  const kind = (char: string): string => (TERM_CJK.test(char) ? 'cjk' : /\p{N}/u.test(char) ? 'digit' : 'other')
  const parts: string[] = []
  for (const word of needle.split(TERM_SEPARATORS)) {
    let part = ''
    let last = ''
    for (const char of word) {
      const now = kind(char)
      if (part.length > 0 && (now === 'cjk' || now !== last)) {
        parts.push(part)
        part = ''
      }
      part += char
      last = now
    }
    if (part.length > 0) parts.push(part)
  }
  return parts
}

/**
 * The pattern one configured term matches on a lower-cased projection: its
 * parts in order, with any run of separators, line breaks and indentation
 * included, or none between two parts.
 * @param value - the configured term.
 * @returns a global pattern, or `undefined` for a term of one part.
 */
function termPattern(value: string): RegExp | undefined {
  const parts = termParts(projectNfkc(value).lower)
  if (parts.length < 2) return undefined
  const escape = (part: string): string => part.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(parts.map(escape).join(`${TERM_SEPARATOR}*`), 'gu')
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
export function runAll(pattern: RegExp, text: string, handler: (match: RegExpExecArray) => void): void {
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
 * Expand every `@` into an address and keep the ones with a valid domain. An
 * obfuscated spelling (`＠`, `(at)`, `[at]`, and `[dot]` or `(dot)` in the
 * domain) also needs a known top-level domain. `@` and `＠` must touch both
 * parts: `a.b @ c.de` is as often a matrix product as an address, and a bare
 * ` at ` as often prose. A bracketed `at` may have spaces around it (never a
 * line break) when the TLD is lower-case and the local part is joined words
 * that do not start with a code root (`self.`, `this.`).
 * @param text - text to scan.
 * @param push - candidate sink.
 */
export function collectEmailCandidates(text: string, push: PushCandidate): void {
  runAll(EMAIL_AT, text, (match) => {
    const spelledAt = match[0].length > 1
    let localEnd = match.index
    let from = match.index + match[0].length
    if (spelledAt) {
      while (localEnd > 0 && EMAIL_SPACE.test(text.charAt(localEnd - 1))) localEnd -= 1
      while (from < text.length && EMAIL_SPACE.test(text.charAt(from))) from += 1
    }
    let start = localEnd
    while (start > 0 && start > localEnd - EMAIL_LOCAL_MAX && EMAIL_LOCAL.test(text.charAt(start - 1))) start -= 1
    if (start === localEnd) return
    let end = from
    while (end < text.length && end < from + EMAIL_DOMAIN_MAX && EMAIL_DOMAIN_CHAR.test(text.charAt(end))) end += 1
    EMAIL_SPELLED_DOT_AT.lastIndex = end
    const spelledDot = EMAIL_SPELLED_DOT_AT.test(text)
    if (spelledDot) {
      EMAIL_SPELLED_DOMAIN.lastIndex = from
      // The walk above already matched at `from`, so the spelled pattern does too.
      // oxlint-disable-next-line typescript/no-non-null-assertion -- see above.
      end = Math.min(from + EMAIL_SPELLED_DOMAIN.exec(text)![0].length, from + EMAIL_DOMAIN_MAX)
    }
    while (end > from && (text.charAt(end - 1) === '.' || text.charAt(end - 1) === '-')) end -= 1
    const domain = text.slice(from, end).replaceAll(EMAIL_SPELLED_DOT, '.')
    if (!EMAIL_DOMAIN.test(domain)) return
    const obfuscated = spelledAt || spelledDot || match[0] !== '@' || localEnd !== match.index || from !== match.index + 1
    if (obfuscated && !EMAIL_SPELLED_TLD.test(domain.slice(domain.lastIndexOf('.') + 1))) return
    if (localEnd !== match.index || from !== match.index + match[0].length) {
      const local = text.slice(start, localEnd)
      if (!EMAIL_WORD_LOCAL.test(local) || EMAIL_FILE_SUFFIX.test(local)) return
      // `a.T (at) b.mT` and `self.q (at) self.k` read as code: a mixed-case TLD or a code root before the dot.
      if (!/^[a-z]+$/.test(domain.slice(domain.lastIndexOf('.') + 1))) return
      if (HOST_CODE_ROOTS.has(local.slice(0, local.search(/[._+]/)))) return
    }
    push(start, end, 'EMAIL', PRIORITY_PII)
  })
}

/**
 * Collect checksum-valid identification numbers, telephone numbers, and
 * business numbers.
 * @param text - text to scan.
 * @param rules - which of `tw-national-id`, `phone`, and `tax-id` are enabled.
 * @param push - candidate sink.
 * @param afterEscape - whether `text` holds a high escape, which then also counts as a left boundary.
 */
export function collectNumberCandidates(
  text: string,
  rules: ReadonlySet<string>,
  push: PushCandidate,
  afterEscape = false,
): void {
  if (rules.has('tw-national-id')) {
    runAll(TWID, text, (match) => {
      if (!isTaiwanNationalId(match[0])) return
      push(match.index, match.index + match[0].length, 'TWID', PRIORITY_PII)
    })
    runAll(TWID_SPLIT, text, (match) => {
      if (!isTaiwanNationalId(match[0].replace(/[- \u3000]/, ''))) return
      push(match.index, match.index + match[0].length, 'TWID', PRIORITY_PII)
    })
  }
  // Business numbers are proposed before telephone numbers: a number after both
  // `聯絡` and `統編` yields two candidates with equal offsets and priority, and
  // the merge keeps the first proposed of those.
  if (rules.has('tax-id')) {
    for (const pattern of afterEscape ? [TAX_ID, TAX_ID_AFTER_ESCAPE] : [TAX_ID]) {
      runAll(pattern, text, (match) => {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has one group.
        const value = match[1]!
        if (value.length !== 8 && !isTaiwanBusinessNumber(value.replace(/[- \u3000]/, ''))) return
        const at = match.index + match[0].lastIndexOf(value)
        push(at, at + value.length, 'TAXID', PRIORITY_PII)
      })
    }
  }
  if (rules.has('phone')) {
    for (const pattern of afterEscape ? [PHONE_MOBILE, PHONE_MOBILE_AFTER_ESCAPE] : [PHONE_MOBILE]) {
      runAll(pattern, text, (match) => {
        push(match.index, match.index + match[0].length, 'PHONE', PRIORITY_PII)
      })
    }
    for (const pattern of afterEscape ? [PHONE_MOBILE_SPLIT, PHONE_MOBILE_SPLIT_AFTER_ESCAPE] : [PHONE_MOBILE_SPLIT]) {
      runAll(pattern, text, (match) => {
        // ponytail: a year-shaped middle group drops 2% of real 2-4-4 numbers (09-19xx, 09-20xx); a date-word context check is the upgrade.
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has two groups.
        if (PHONE_YEAR.test(match[2]!)) return
        push(match.index, match.index + match[0].length, 'PHONE', PRIORITY_PII)
      })
    }
    for (const pattern of afterEscape ? [PHONE_KEYWORD, PHONE_KEYWORD_AFTER_ESCAPE] : [PHONE_KEYWORD]) {
      runAll(pattern, text, (match) => {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has one group.
        const value = match[1]!
        const at = match.index + match[0].lastIndexOf(value)
        push(at, at + value.length, 'PHONE', PRIORITY_PII)
      })
    }
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
 * @param afterEscape - whether `text` holds a high escape, which then also counts as a left boundary.
 */
export function collectCardCandidates(text: string, push: PushCandidate, afterEscape = false): void {
  for (const pattern of afterEscape ? [CARD_RUN, CARD_RUN_AFTER_ESCAPE] : [CARD_RUN]) {
    runAll(pattern, text, (match) => {
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
}

/**
 * Collect payment card numbers only in the forms cards are printed in, for the
 * opt-in `card-strict` rule: one whole digit group of 13 to 19 digits (after a
 * single leading `0` when the run is one group), or whole groups in a card
 * grouping joined by one separator that no further group with that separator
 * extends. A mask therefore never ends inside a digit group, and
 * `8000 5259-6589 0921-9030` or a numeric UUID is not cut into a card. A run
 * glued to a letter or `_`, opened by a `..` revision range, or the fraction of
 * a decimal number (`1432.4982166290283`) is not read. A whole run of two or
 * more groups of at least two digits in any other grouping, joined by spaces,
 * `-`, or one line break, or by `.` alone in three to six groups, is read as one
 * number: `41 1111 111 1111 111`, `4111.1111.1111.1111`, `4111 1111-1111 111`,
 * and a card wrapped after its second group. A run of more than six groups, or
 * one mixing `.` with another separator, is not read.
 * @param text - text to scan.
 * @param push - candidate sink.
 * @param afterEscape - whether `text` holds a high escape, which then also counts as a left boundary.
 */
export function collectStrictCardCandidates(text: string, push: PushCandidate, afterEscape = false): void {
  const pushCard = (digits: string, start: number, end: number): void => {
    if (digits.length < 13 || digits.length > 19 || !validCardPrefix(digits) || !luhn(digits)) return
    push(start, end, 'CARD', PRIORITY_PII)
  }
  for (const pattern of afterEscape ? [CARD_RUN, CARD_RUN_AFTER_ESCAPE] : [CARD_RUN]) {
    runAll(pattern, text, (match) => {
      const end = match.index + match[0].length
      if (TOKEN_CHAR.test(text.charAt(match.index - 1)) && !endsHighEscape(text, match.index)) return
      if (TOKEN_CHAR.test(text.charAt(end)) || RANGE_OR_DECIMAL_POINT.test(text.slice(match.index - 2, match.index))) return
      // Each group with its offset in `text` and the separator before it (`''` for the first).
      const groups = [...match[0].matchAll(/\d+/g)].map(group => ({
        digits: group[0],
        start: match.index + group.index,
        separator: match[0].charAt(group.index - 1),
      }))
      for (const group of groups) pushCard(group.digits, group.start, group.start + group.digits.length)
      if (groups.length === 1 && match[0].startsWith('0')) pushCard(match[0].slice(1), match.index + 1, end)
      // Each maximal chain of groups joined by one separator is one printed number or none;
      // neighbouring chains share the group between them.
      let chain: typeof groups = []
      let separator = ''
      const pushChain = (): void => {
        const [head] = chain
        const tail = chain.at(-1)
        if (chain.length < 2 || head === undefined || tail === undefined) return
        if (!CARD_GROUPING.test(chain.map(group => group.digits.length).join(','))) return
        pushCard(chain.map(group => group.digits).join(''), head.start, tail.start + tail.digits.length)
      }
      for (const group of groups) {
        if (chain.length > 1 && group.separator !== separator) {
          pushChain()
          chain = chain.slice(-1)
        }
        if (chain.length === 1) separator = group.separator
        chain.push(group)
      }
      pushChain()
    })
  }
  // A whole run in any other grouping is one card or none, so no mask ends inside it.
  for (const pattern of afterEscape ? [CARD_SPELLED_RUN, CARD_SPELLED_RUN_AFTER_ESCAPE] : [CARD_SPELLED_RUN]) {
    runAll(pattern, text, (match) => {
      const end = match.index + match[0].length
      if (TOKEN_CHAR.test(text.charAt(match.index - 1)) && !endsHighEscape(text, match.index)) return
      if (TOKEN_CHAR.test(text.charAt(end)) || RANGE_OR_DECIMAL_POINT.test(text.slice(match.index - 2, match.index))) return
      const groups = match[0].match(/\d+/g) ?? []
      const separators = match[0].split(/\d+/).join('')
      // A one-digit group is a list item or a version part; two dotted groups are a decimal number.
      if (groups.some(group => group.length < 2) || separators.split('\n').length > 2) return
      // Dots mixed with other separators are coordinates, IPs, money, or dates; more than six groups are a byte dump.
      if (separators.includes('.') && (groups.length < 3 || /[^.]/.test(separators))) return
      if (groups.length > CARD_SPELLED_GROUPS_MAX) return
      pushCard(groups.join(''), match.index, end)
    })
  }
}

/**
 * Collect private addresses, and internal host names anchored on their suffix.
 * @param text - text to scan.
 * @param rules - which of `ip` and `host` are enabled.
 * @param push - candidate sink.
 * @param originalAt - the submitted character an offset of `text` came from;
 *   on a projection, the call guard reads `（` there rather than its fold `(`.
 * @param afterEscape - whether `text` holds a high escape, which then also counts as a left boundary.
 */
export function collectNetworkCandidates(
  text: string,
  rules: ReadonlySet<string>,
  push: PushCandidate,
  originalAt: (offset: number) => string = offset => text.charAt(offset),
  afterEscape = false,
): void {
  if (rules.has('ip')) {
    for (const pattern of afterEscape ? [PRIVATE_IP, PRIVATE_IP_AFTER_ESCAPE] : [PRIVATE_IP]) {
      runAll(pattern, text, (match) => {
        if (match[0].split('.').some(octet => Number(octet) > 255)) return
        push(match.index, match.index + match[0].length, 'IP', PRIORITY_PII)
      })
    }
  }
  if (rules.has('host')) collectHostCandidates(text, HOST_SUFFIX, push, originalAt)
}

/**
 * Collect host names anchored on a private suffix: the name is walked back
 * from the suffix match and ends where the match ends.
 * @param text - text to scan.
 * @param suffix - global pattern matching a suffix from its leading `.`, plus any labels after it that belong to the name.
 * @param push - candidate sink.
 * @param originalAt - the submitted character an offset of `text` came from; `(` right after the name marks a call.
 */
export function collectHostCandidates(
  text: string,
  suffix: RegExp,
  push: PushCandidate,
  originalAt: (offset: number) => string = offset => text.charAt(offset),
): void {
  // Anchor on the suffix and walk back, so a long dotted run stays linear.
  runAll(suffix, text, (match) => {
    const floor = Math.max(0, match.index - HOST_NAME_MAX)
    let start = match.index
    while (start > floor && HOST_CHAR.test(text.charAt(start - 1))) start -= 1
    const end = match.index + match[0].length
    if (start === match.index) return
    if (text.charAt(start - 1) === '.') return
    if (originalAt(end) === '(') return
    const first = HOST_FIRST_WORD.exec(text.slice(start))
    if (first !== null && HOST_CODE_ROOTS.has(first[0])) return
    push(start, end, 'HOST', PRIORITY_PII)
  })
}

/**
 * Whether the value at an offset is keyed by a file name on its line.
 * @param text - text holding the value.
 * @param at - the value's start offset.
 * @returns whether the line text before the value ends in a file-name key.
 */
function isFileNameKeyed(text: string, at: number): boolean {
  const lineStart = Math.max(text.lastIndexOf('\n', at - 1) + 1, at - FILE_NAME_KEY_MAX)
  return FILE_NAME_KEY.test(text.slice(lineStart, at))
}

/**
 * Collect high-entropy runs. A run beside credential words is a credential; a
 * 32, 40, or 64 digit hexadecimal run beside revision words is a digest.
 * @param text - text to scan.
 * @param push - candidate sink.
 * @param fileDigests - whether a 40 or 64 digit hexadecimal run keyed by a file
 *   name (`README.md: <sha>`, as translation catalogs record source hashes),
 *   and a 40 digit run right after `@` (`actions/checkout@<sha>`), is a digest
 *   too; the opt-in `entropy-strict` rule sets it.
 */
export function collectEntropyCandidates(text: string, push: PushCandidate, fileDigests = false): void {
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
    if (fileDigests && DIGEST_HEX_LENGTHS.includes(match[0].length) && isFileNameKeyed(text, match.index)) return
    if (fileDigests && match[0].length === GIT_COMMIT_HEX_LENGTH && text.charAt(match.index - 1) === '@') return
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
 * matches its `\uXXXX` escape spelling. A term edge that is an ASCII letter or
 * digit matches only where the projection's neighbouring character is not one
 * (see {@link hasFreeEdges}), so `Lin` skips `online` and `Linux`; a CJK edge
 * matches inside text. The escape spelling matches without this check.
 * @param text - text to scan.
 * @param terms - configured terms with their categories.
 * @param push - candidate sink.
 */
export function collectTermCandidates(text: string, terms: readonly ConfiguredTerm[], push: PushCandidate): void {
  if (terms.length === 0) return
  const projection = projectNfkc(text)
  let lowerText: string | undefined
  for (const term of terms) {
    const pattern = termPattern(term.value)
    if (pattern === undefined) {
      // Configuration refuses a term that projects to nothing, so the needle is never empty.
      const needle = projectNfkc(term.value).lower
      for (let at = projection.lower.indexOf(needle); at >= 0; at = projection.lower.indexOf(needle, at + 1)) {
        if (!hasFreeEdges(projection.lower, at, at + needle.length, needle)) continue
        // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
        push(projection.startMap[at]!, projection.endMap[at + needle.length - 1]!, term.category, PRIORITY_TERM)
      }
    } else {
      for (let match = pattern.exec(projection.lower); match !== null; match = pattern.exec(projection.lower)) {
        const end = match.index + match[0].length
        if (hasFreeEdges(projection.lower, match.index, end, match[0])) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
          push(projection.startMap[match.index]!, projection.endMap[end - 1]!, term.category, PRIORITY_TERM)
        }
        // Overlapping occurrences are found too, as the single-part search finds
        // them. A `u` pattern backs a lastIndex inside a surrogate pair up to the
        // pair's start, so the step is one whole code point.
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the match is not empty.
        pattern.lastIndex = match.index + (projection.lower.codePointAt(match.index)! > 0xffff ? 2 : 1)
      }
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
 * would not cut a longer token in half. A high escape (`%E6`, `%FF`) right
 * before the value leaves its left edge free.
 * @param text - text holding the occurrence.
 * @param start - inclusive start offset of the occurrence.
 * @param end - exclusive end offset of the occurrence.
 * @param value - the value itself.
 * @returns whether the occurrence stands on its own.
 */
export function hasFreeEdges(text: string, start: number, end: number, value: string): boolean {
  if (isAlnum(value.charAt(0)) && isAlnum(text.charAt(start - 1)) && !endsHighEscape(text, start)) return false
  if (isAlnum(value.charAt(value.length - 1)) && isAlnum(text.charAt(end))) return false
  return true
}
