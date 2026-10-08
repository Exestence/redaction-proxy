/**
 * Opt-in rules that widen or tighten the default ones without changing them:
 * host names under further private suffixes, credential formats the `api-key`
 * rule does not know, credentials named in prose, stricter variants of the
 * `card` and `entropy` rules, looser spellings of Taiwan identification and
 * mobile numbers, passport and health-insurance card numbers after a keyword,
 * escaped email addresses, and shared and unique local network addresses. Hosts that persist a policy digest keep the
 * default rules; the proxy, which persists none, enables these.
 *
 * @module redaction-proxy/core/rules/extended
 */

import { isIPv6 } from 'node:net'
import type { PushCandidate } from './candidate.ts'
import { PRIORITY_PII, PRIORITY_SECRET } from './candidate.ts'
import { isTaiwanNationalId } from './checksum.ts'
import type { OffsetProjection } from './normalize.ts'
import { shannon } from './normalize.ts'
import { KEYWORD_GAP, collectEmailCandidates, collectHostCandidates, runAll } from './rules.ts'
import { CJK_SECRET_WORDS, collectCjkSecretValue, isCodeShape, trimValueEnd } from './secret.ts'

/** Names of the opt-in extended rules. */
export type ExtendedRuleName =
  | 'card-strict'
  | 'entropy-strict'
  | 'private-host'
  | 'token-format'
  | 'credential-phrase'
  | 'tw-national-id-loose'
  | 'tw-passport-nhi'
  | 'tw-mobile-loose'
  | 'email-escaped'
  | 'ip-cgnat-ula'

/** Every extended rule name, in declaration order. */
export const EXTENDED_RULE_NAMES: readonly ExtendedRuleName[] = [
  'card-strict', 'entropy-strict', 'private-host', 'token-format', 'credential-phrase',
  'tw-national-id-loose', 'tw-passport-nhi', 'tw-mobile-loose', 'email-escaped', 'ip-cgnat-ula',
]

/**
 * Version of the extended rules, appended to the detector version while any of
 * them is enabled; changes whenever one of their matches changes.
 * Unreleased: changes before the first release keep this version; after it,
 * every change to a match bumps it.
 */
export const EXTENDED_RULES_VERSION = 'ext-1'

/** Categories each extended rule can report, in the order `categories` lists them. */
export const EXTENDED_RULE_CATEGORIES: Readonly<Record<ExtendedRuleName, readonly string[]>> = {
  'card-strict': ['CARD'],
  'entropy-strict': ['ENTROPY', 'KEY'],
  'private-host': ['HOST'],
  'token-format': ['KEY'],
  'credential-phrase': ['KEY'],
  'tw-national-id-loose': ['TWID'],
  'tw-passport-nhi': ['TWID'],
  'tw-mobile-loose': ['PHONE'],
  'email-escaped': ['EMAIL'],
  'ip-cgnat-ula': ['IP'],
}

/**
 * Whether a rule name names an extended rule.
 * @param rule - a built-in rule name.
 * @returns whether it is one of {@link EXTENDED_RULE_NAMES}.
 */
export function isExtendedRule(rule: string): rule is ExtendedRuleName {
  return (EXTENDED_RULE_NAMES as readonly string[]).includes(rule)
}

/**
 * Suffixes that are private by convention or reservation (RFC 8375
 * `home.arpa`), with the labels a name carries after one (`git.corp.example.com`).
 * Lower case only: `Contoso.Corp.Billing` is a namespace. `.home` and
 * `.private` are left out because `user.home` and `this.private` are code.
 */
const PRIVATE_HOST_SUFFIX = /\.(?:corp|intra|intranet|localdomain|home\.arpa)(?:\.[a-z0-9-]+)*(?![a-z0-9-])/g
/** First labels of a reverse-domain package name (`com.acme.intra.Billing`), which no host name starts with. */
const PACKAGE_ROOTS = new Set(['com', 'org', 'net', 'io', 'dev', 'edu', 'gov', 'de', 'fr', 'uk', 'jp', 'cn', 'tw'])
/** Last labels that make a dotted name a file name (`settings.corp.yaml`). */
const FILE_EXTENSION = /\.(?:json|ya?ml|toml|xml|ini|conf|cfg|env|properties|ts|js|mjs|py|go|rs|java|kt|md|txt|sh|html|css|lock)$/

/** No letter, digit, or `_` before a credential, so it is not the tail of a longer identifier. */
const TOKEN_LEFT_EDGE = '(?<![A-Za-z0-9_])'
/**
 * A credential format that starts at {@link TOKEN_LEFT_EDGE}.
 * @param body - the format's pattern.
 * @returns a global pattern.
 */
const token = (body: string): RegExp => new RegExp(`${TOKEN_LEFT_EDGE}${body}`, 'g')

/** Credential formats with a vendor prefix that the `api-key` rule does not list. */
const TOKEN_FORMATS: readonly RegExp[] = [
  // GitLab personal, project, and group access tokens.
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
  // Stripe secret and restricted keys; publishable `pk_` keys are public by design.
  token('[rs]k_(?:live|test)_[A-Za-z0-9]{16,}'),
  // Stripe webhook signing secrets.
  token('whsec_[A-Za-z0-9+/]{16,}'),
  // SendGrid API keys.
  token('SG\\.[A-Za-z0-9_-]{16,32}\\.[A-Za-z0-9_-]{16,64}'),
  // Hugging Face access tokens.
  token('hf_[A-Za-z0-9]{30,}'),
  // npm access tokens.
  token('npm_[A-Za-z0-9]{36}'),
  // Slack app-level tokens.
  /(?<![A-Za-z0-9_-])xapp-\d-[A-Za-z0-9-]{10,}/g,
  // Shopify access tokens and shared secrets.
  token('shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}'),
  // DigitalOcean personal, OAuth, and refresh tokens.
  token('do[opr]_v1_[a-f0-9]{64}'),
  // Atlassian API tokens.
  token('ATATT3[A-Za-z0-9_=-]{20,}'),
  // Twilio API keys.
  token('SK[0-9a-fA-F]{32}(?![A-Za-z0-9])'),
  // Square access tokens.
  token('(?:EAAA|sq0atp-)[\\w-]{22,60}(?![\\w-])'),
  // Grafana service account tokens and Grafana Cloud API tokens.
  token('glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?![A-Za-z0-9])'),
  token('glc_[A-Za-z0-9+/]{32,400}={0,3}'),
  // Databricks personal access tokens.
  token('dapi[a-f0-9]{32}(?:-\\d)?(?![A-Za-z0-9])'),
  // Telegram bot tokens.
  /(?<![A-Za-z0-9_:])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g,
  // JSON Web Tokens with a short payload or no signature (`alg: none`), which the `api-key` rule's JWT pattern needs ten characters in.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g,
]
/** Azure storage and Service Bus keys and SAS signatures: the value after the field name is the credential. */
const AZURE_KEY = /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey|sig)=([A-Za-z0-9%+/]{16,}={0,2})/g

/**
 * Words that name a password, in English, German, French, Spanish,
 * Portuguese, Chinese, Japanese, and Korean; their value may be short and
 * need not look random.
 */
const PASSWORD_WORD = 'password|passphrase|passcode|passwd|pwd|pw|passwort|mot de passe|contraseña|senha'
  + '|密碼|密码|パスワード|비밀번호'
/**
 * A credential word in prose, an optional `is`, `was`, or `:` (or the same
 * word in the password word's language: `ist`, `est`, `es`, `é`, `是`, `は`,
 * `는`), and the word after it, quoted or not: `the secret is X`,
 * `here is my key: X`, `use token 'X'`, `密码是 X`, and a quoted JSON key
 * such as `"jwt": "X"`. `key = X` assignments are
 * the `api-key` rule's. Not a shell variable (`$PWD`), a
 * member (`this.key`), or a flag (`--password`), and the value ends at a
 * list separator, a placeholder, or the next query parameter (`&next=`).
 */
const CREDENTIAL_PHRASE = new RegExp(
  '(?<![A-Za-z0-9_$.-])(?<word>api[ _-]?key|access[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token'
  + `|token|secret|key|jwt|${PASSWORD_WORD})(?![A-Za-z0-9_])`
  + '(?:[ \\t]{1,4}(?:is|was|ist|est|es|é)[ \\t]{1,4}|[\'"]?[ \\t]{0,4}:[ \\t]{0,4}|[ \\t]{0,4}(?:是|為|为|は|는|은)[ \\t]{0,4}|[ \\t]{1,4})'
  + '[\'"`]?(?<value>[^\\s\'"`<>()[\\]{},;⟦]{6,128})',
  'gi',
)
/** A quoted CJK credential key (`"密碼": "x"`): the closing quote keeps the `api-key` rule's `密碼: x` pattern from matching. */
const QUOTED_CJK_SECRET_KEY = new RegExp(`["'](?:${CJK_SECRET_WORDS})["'][ \\t]*[:=][ \\t]*`, 'g')
/** A member chain such as `process.env.TOKEN_2`, which names a value rather than being one. */
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
/** The next parameter of a query string, which ends a value read out of a URL. */
const NEXT_QUERY_PARAMETER = /&[A-Za-z_][\w-]*=/
/** Whether a matched credential word is one of {@link PASSWORD_WORD}. */
const PASSWORD_WORDS = new RegExp(`^(?:${PASSWORD_WORD})$`, 'i')
/** Shortest value a general credential word (`key`, `token`, `secret`) is read with. */
const GENERAL_VALUE_MIN = 16
/** Lowest Shannon entropy, in bits per character, of a value after a general credential word. */
const GENERAL_ENTROPY_MIN = 3.5
/** A value of printable ASCII only; a password word followed by prose in another script has no value. */
const PRINTABLE_ASCII = /^[!-~]+$/
/** Shortest value a password word is read with. */
const PASSWORD_VALUE_MIN = 6

/** A no-break or narrow space (U+00A0, U+2007, U+2009, U+202F); NFKC folds each to a plain space. */
const NARROW_SPACE = '[\\u00a0\\u2007\\u2009\\u202f]'
const NARROW_SPACES = new RegExp(NARROW_SPACE, 'g')
/**
 * A Taiwan identification number with a lower-case letter, or with no-break
 * or narrow spaces among its digits (`a123456789`, `A1234\u00a056789`),
 * neither of which the `tw-national-id` rule reads. Matched on the submitted
 * text only: on the NFKC projection those spaces are plain spaces.
 */
const TWID_LOOSE = new RegExp(`(?<![A-Za-z0-9])[A-Za-z](?:${NARROW_SPACE}?\\d){9}(?![A-Za-z0-9])`, 'g')
/**
 * A Taiwan passport number (nine digits) or National Health Insurance card
 * number (twelve digits, optionally grouped 4-4-4) right after its keyword.
 * Neither has a check digit, so neither is read without the keyword. The
 * English keyword may carry `number`, `no.`, or `#`, as `號碼` follows `護照`.
 * A passport number may be grouped 3-3-3 by hyphens: `312-345-678`.
 */
const TW_PASSPORT = new RegExp(
  `(?:護照|护照|passport(?:[ _-]?(?:number|no\\.?|#))?)${KEYWORD_GAP}(?<![A-Za-z0-9])(?<value>\\d{3}(-?)\\d{3}\\2\\d{3})(?![A-Za-z0-9]|-\\d)`,
  'gid',
)
const TW_NHI_CARD = new RegExp(
  `(?:健保卡|nhi card)${KEYWORD_GAP}(?<![A-Za-z0-9])(?<value>\\d{4}([- ]?)\\d{4}\\2\\d{4})(?![A-Za-z0-9]|[- ]\\d)`,
  'gid',
)
/**
 * A Taiwan mobile number grouped 4-3-3 by one `.`, `/`, or `_` (a full-width
 * `／` folds to `/`), or with its prefix in brackets: `0912.345.678`,
 * `0912_345_678`, `(0912)345678`. Not a part of a longer dotted, slashed, or
 * underscored run such as a version, a date, or an identifier.
 */
const TW_MOBILE_LOOSE = /(?<![A-Za-z0-9./_])(?:09\d{2}([./_])\d{3}\1\d{3}|\(09\d{2}\)[ -]?\d{3}[ -]?\d{3})(?![A-Za-z0-9_]|[./_]\d)/g
/** An `@` escaped as an HTML character reference or a JSON escape: `&#64;`, `&#x40;`, `&commat;`, `\u0040`. */
const ESCAPED_AT = /&#0*64;|&#x0*40;|&commat;|\\u0040/gi
/** An address in the shared address space 100.64.0.0/10 (RFC 6598), used by carrier-grade NAT and Tailscale. */
const SHARED_IPV4 = /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.])/g
/** A unique local IPv6 address (fc00::/7, RFC 4193) such as `fd12:3456:789a::1`; `isIPv6` checks the groups. */
const ULA_IPV6 = /(?<![A-Za-z0-9:])f[cd][0-9a-f]{2}(?::[0-9a-f]{0,4}){2,7}(?![A-Za-z0-9:])/gi

/** One rule pass over one text. */
export type ExtendedCollector = (text: string, push: PushCandidate, originalAt?: (offset: number) => string) => void

/**
 * Collect host names under the further private suffixes. A reverse-domain
 * package name and a file name are not hosts.
 * @param text - text to scan.
 * @param push - candidate sink.
 * @param originalAt - the submitted character an offset of `text` came from.
 */
function collectPrivateHostCandidates(text: string, push: PushCandidate, originalAt?: (offset: number) => string): void {
  collectHostCandidates(text, PRIVATE_HOST_SUFFIX, (start, end, category, priority) => {
    const name = text.slice(start, end)
    if (PACKAGE_ROOTS.has(name.slice(0, name.indexOf('.'))) || FILE_EXTENSION.test(name)) return
    push(start, end, category, priority)
  }, originalAt)
}

/**
 * Collect credentials in the vendor formats of {@link TOKEN_FORMATS} and Azure key fields.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
function collectTokenFormatCandidates(text: string, push: PushCandidate): void {
  for (const pattern of TOKEN_FORMATS) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      push(match.index, match.index + match[0].length, 'KEY', PRIORITY_SECRET)
    }
  }
  AZURE_KEY.lastIndex = 0
  for (let match = AZURE_KEY.exec(text); match !== null; match = AZURE_KEY.exec(text)) {
    const [whole, value = ''] = match
    const at = match.index + whole.length - value.length
    push(at, at + value.length, 'KEY', PRIORITY_SECRET)
  }
}

/**
 * Whether a value after a credential word reads as a credential. After a
 * password word any printable ASCII value with a letter and a digit or symbol
 * does, and so does an all-digit passcode; after a general word only a long random-looking
 * one does: mixed case and digits, or hexadecimal with letters and digits,
 * and high entropy.
 * A URL, a path, an identifier, and code are never credentials here.
 * @param value - the value without trailing punctuation.
 * @param password - whether the word names a password.
 * @returns whether to mask the value.
 */
function isPhraseCredential(value: string, password: boolean): boolean {
  if (value.includes('://') || /^[/~.$%]/.test(value) || /^0x/i.test(value)) return false
  if (DOTTED_IDENTIFIER.test(value)) return false
  if ((value.match(/\//g)?.length ?? 0) > 1) return false
  if (isCodeShape(value, { loose: true })) return false
  if (password) {
    // A value without a letter is a passcode only when it is all digits; `2026-10-07` and `1.2.3` are not.
    // A closing `?` or `!` is sentence punctuation (`Passwort vergessen?`), not the value's symbol.
    const shaped = /[A-Za-z]/.test(value) ? /[^A-Za-z]/.test(value.replace(/[?!]+$/, '')) : /^\d+$/.test(value)
    return value.length >= PASSWORD_VALUE_MIN && PRINTABLE_ASCII.test(value) && shaped
  }
  if (!/[A-Za-z]/.test(value) || value.length < GENERAL_VALUE_MIN || value.includes(':') || shannon(value) < GENERAL_ENTROPY_MIN) return false
  const mixed = /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)
  const hexadecimal = /^[0-9a-f]+$/i.test(value) && /\d/.test(value)
  return mixed || hexadecimal
}

/**
 * Collect credentials named by a credential word in prose.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
function collectCredentialPhraseCandidates(text: string, push: PushCandidate): void {
  CREDENTIAL_PHRASE.lastIndex = 0
  for (let match = CREDENTIAL_PHRASE.exec(text); match !== null; match = CREDENTIAL_PHRASE.exec(text)) {
    const { word = '', value: raw = '' } = match.groups ?? {}
    // The value closes the match, and the word opens it: the lookbehind before it takes no characters.
    const start = match.index + match[0].length - raw.length
    const parameter = raw.search(NEXT_QUERY_PARAMETER)
    const read = parameter < 0 ? raw : raw.slice(0, parameter)
    const value = read.slice(0, trimValueEnd(read))
    if (isPhraseCredential(value, PASSWORD_WORDS.test(word))) push(start, start + value.length, 'KEY', PRIORITY_SECRET)
    // The value may itself hold the next credential word (`token: key-…`), so scanning resumes right after the word.
    CREDENTIAL_PHRASE.lastIndex = match.index + word.length
  }
  QUOTED_CJK_SECRET_KEY.lastIndex = 0
  for (let match = QUOTED_CJK_SECRET_KEY.exec(text); match !== null; match = QUOTED_CJK_SECRET_KEY.exec(text)) {
    collectCjkSecretValue(text, match.index + match[0].length, push)
  }
}

/**
 * Collect checksum-valid identification numbers in the spellings of {@link TWID_LOOSE}.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
function collectLooseTaiwanIdCandidates(text: string, push: PushCandidate): void {
  runAll(TWID_LOOSE, text, (match) => {
    if (!isTaiwanNationalId(match[0].replaceAll(NARROW_SPACES, '').toUpperCase())) return
    push(match.index, match.index + match[0].length, 'TWID', PRIORITY_PII)
  })
}

/**
 * Collect passport and health-insurance card numbers after their keywords.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
function collectPassportAndNhiCandidates(text: string, push: PushCandidate): void {
  for (const pattern of [TW_PASSPORT, TW_NHI_CARD]) {
    runAll(pattern, text, (match) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- both patterns have a `value` group and the `d` flag.
      const [start, end] = match.indices!.groups!.value!
      push(start, end, 'TWID', PRIORITY_PII)
    })
  }
}

/**
 * Collect mobile numbers grouped by `.` or `/`.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
function collectLooseMobileCandidates(text: string, push: PushCandidate): void {
  runAll(TW_MOBILE_LOOSE, text, (match) => {
    push(match.index, match.index + match[0].length, 'PHONE', PRIORITY_PII)
  })
}

/**
 * Project a text with every escaped `@` decoded, each mapped to its whole escape.
 * @param text - text holding at least one escape.
 * @returns the projection.
 */
function projectEscapedAt(text: string): OffsetProjection {
  let norm = ''
  const startMap: number[] = []
  const endMap: number[] = []
  let copied = 0
  const append = (chars: string, start: number, end: number): void => {
    norm += chars
    startMap.push(start)
    endMap.push(end)
  }
  runAll(ESCAPED_AT, text, (match) => {
    for (let at = copied; at < match.index; at += 1) append(text.charAt(at), at, at + 1)
    append('@', match.index, match.index + match[0].length)
    copied = match.index + match[0].length
  })
  for (let at = copied; at < text.length; at += 1) append(text.charAt(at), at, at + 1)
  return { norm, startMap, endMap }
}

/**
 * Collect email addresses whose `@` is escaped as in {@link ESCAPED_AT}.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
function collectEscapedEmailCandidates(text: string, push: PushCandidate): void {
  ESCAPED_AT.lastIndex = 0
  if (!ESCAPED_AT.test(text)) return
  const projection = projectEscapedAt(text)
  collectEmailCandidates(projection.norm, (start, end, category, priority) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
    push(projection.startMap[start]!, projection.endMap[end - 1]!, category, priority)
  })
}

/**
 * Collect shared IPv4 and unique local IPv6 addresses.
 * @param text - text to scan.
 * @param push - candidate sink.
 */
function collectSharedAndUniqueLocalCandidates(text: string, push: PushCandidate): void {
  runAll(SHARED_IPV4, text, (match) => {
    if (match[0].split('.').some(octet => Number(octet) > 255)) return
    push(match.index, match.index + match[0].length, 'IP', PRIORITY_PII)
  })
  runAll(ULA_IPV6, text, (match) => {
    const end = match.index + match[0].length
    // `fc00::/7` and `fd12:3456::/48` name a network prefix, not an address.
    if (match[0].endsWith('::') && text.charAt(end) === '/') return
    if (isIPv6(match[0])) push(match.index, end, 'IP', PRIORITY_PII)
  })
}

/**
 * The pass of every extended rule that adds a collector of its own. `card-strict`
 * and `entropy-strict` reuse the default collectors in `rules.ts` with a flag.
 */
export const EXTENDED_COLLECTORS: Readonly<Partial<Record<ExtendedRuleName, ExtendedCollector>>> = {
  'private-host': collectPrivateHostCandidates,
  'token-format': collectTokenFormatCandidates,
  'credential-phrase': collectCredentialPhraseCandidates,
  'tw-national-id-loose': collectLooseTaiwanIdCandidates,
  'tw-passport-nhi': collectPassportAndNhiCandidates,
  'tw-mobile-loose': collectLooseMobileCandidates,
  'email-escaped': collectEscapedEmailCandidates,
  'ip-cgnat-ula': collectSharedAndUniqueLocalCandidates,
}
