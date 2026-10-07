/**
 * Opt-in rules that widen or tighten the default ones without changing them:
 * host names under further private suffixes, credential formats the `api-key`
 * rule does not know, credentials named in prose, and stricter variants of the
 * `card` and `entropy` rules. Hosts that persist a policy digest keep the
 * default rules; the proxy, which persists none, enables these.
 *
 * @module redaction-proxy/core/rules/extended
 */

import type { PushCandidate } from './candidate.ts'
import { PRIORITY_SECRET } from './candidate.ts'
import { shannon } from './normalize.ts'
import { collectHostCandidates } from './rules.ts'
import { isCodeShape, trimValueEnd } from './secret.ts'

/** Names of the opt-in extended rules. */
export type ExtendedRuleName =
  | 'card-strict'
  | 'entropy-strict'
  | 'private-host'
  | 'token-format'
  | 'credential-phrase'

/** Every extended rule name, in declaration order. */
export const EXTENDED_RULE_NAMES: readonly ExtendedRuleName[] = [
  'card-strict', 'entropy-strict', 'private-host', 'token-format', 'credential-phrase',
]

/**
 * Version of the extended rules, appended to the detector version while any of
 * them is enabled; changes whenever one of their matches changes.
 */
export const EXTENDED_RULES_VERSION = 'ext-1'

/** Categories each extended rule can report, in the order `categories` lists them. */
export const EXTENDED_RULE_CATEGORIES: Readonly<Record<ExtendedRuleName, readonly string[]>> = {
  'card-strict': ['CARD'],
  'entropy-strict': ['ENTROPY', 'KEY'],
  'private-host': ['HOST'],
  'token-format': ['KEY'],
  'credential-phrase': ['KEY'],
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

/** Credential formats with a vendor prefix that the `api-key` rule does not list. */
const TOKEN_FORMATS: readonly RegExp[] = [
  // GitLab personal, project, and group access tokens.
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
  // Stripe secret and restricted keys; publishable `pk_` keys are public by design.
  /(?<![A-Za-z0-9_])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // Stripe webhook signing secrets.
  /(?<![A-Za-z0-9_])whsec_[A-Za-z0-9+/]{16,}/g,
  // SendGrid API keys.
  /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}/g,
  // Hugging Face access tokens.
  /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g,
  // npm access tokens.
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}/g,
  // Slack app-level tokens.
  /(?<![A-Za-z0-9_-])xapp-\d-[A-Za-z0-9-]{10,}/g,
  // Shopify access tokens and shared secrets.
  /(?<![A-Za-z0-9_])shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/g,
  // DigitalOcean personal, OAuth, and refresh tokens.
  /(?<![A-Za-z0-9_])do[opr]_v1_[a-f0-9]{64}/g,
  // Atlassian API tokens.
  /(?<![A-Za-z0-9_])ATATT3[A-Za-z0-9_=-]{20,}/g,
  // Telegram bot tokens.
  /(?<![A-Za-z0-9_:])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g,
  // JSON Web Tokens with a short payload or no signature (`alg: none`), which the `api-key` rule's JWT pattern needs ten characters in.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g,
]
/** Azure storage and Service Bus keys and SAS signatures: the value after the field name is the credential. */
const AZURE_KEY = /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey|sig)=([A-Za-z0-9%+/]{16,}={0,2})/g

/**
 * A credential word in prose, an optional `is`, `was`, or `:`, and the word
 * after it, quoted or not: `the secret is X`, `here is my key: X`, `use token 'X'`. `key = X`
 * assignments are the `api-key` rule's. Not a shell variable (`$PWD`), a
 * member (`this.key`), or a flag (`--password`), and the value ends at a
 * list separator, a placeholder, or the next query parameter (`&next=`).
 */
const CREDENTIAL_PHRASE = new RegExp(
  '(?<![A-Za-z0-9_$.-])(?<word>api[ _-]?key|access[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token'
  + '|token|secret|key|password|passphrase|passcode|passwd|pwd|pw)(?![A-Za-z0-9_])'
  + '(?:[ \\t]{1,4}(?:is|was)[ \\t]{1,4}|[ \\t]{0,4}:[ \\t]{0,4}|[ \\t]{1,4})'
  + '[\'"`]?(?<value>[^\\s\'"`<>()[\\]{},;⟦]{6,128})',
  'gid',
)
/** A member chain such as `process.env.TOKEN_2`, which names a value rather than being one. */
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
/** The next parameter of a query string, which ends a value read out of a URL. */
const NEXT_QUERY_PARAMETER = /&[A-Za-z_][\w-]*=/
/** Words that name a password, whose value may be short and need not look random. */
const PASSWORD_WORDS = /^(?:password|passphrase|passcode|passwd|pwd|pw)$/i
/** Shortest value a general credential word (`key`, `token`, `secret`) is read with. */
const GENERAL_VALUE_MIN = 16
/** Lowest Shannon entropy, in bits per character, of a value after a general credential word. */
const GENERAL_ENTROPY_MIN = 3.5
/** A value of printable ASCII only; a password word followed by prose in another script has no value. */
const PRINTABLE_ASCII = /^[!-~]+$/
/** Shortest value a password word is read with. */
const PASSWORD_VALUE_MIN = 6

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
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has one group.
    const value = match[1]!
    const at = match.index + match[0].length - value.length
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
    const shaped = /[A-Za-z]/.test(value) ? /[^A-Za-z]/.test(value) : /^\d+$/.test(value)
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
    // oxlint-disable-next-line typescript/no-non-null-assertion -- both groups always participate.
    const [start] = match.indices!.groups!.value!
    // oxlint-disable-next-line typescript/no-non-null-assertion -- see above.
    const raw = match.groups!.value!
    const parameter = raw.search(NEXT_QUERY_PARAMETER)
    const read = parameter < 0 ? raw : raw.slice(0, parameter)
    const value = read.slice(0, trimValueEnd(read))
    // oxlint-disable-next-line typescript/no-non-null-assertion -- see above.
    if (isPhraseCredential(value, PASSWORD_WORDS.test(match.groups!.word!))) push(start, start + value.length, 'KEY', PRIORITY_SECRET)
    // The value may itself hold the next credential word (`token: key-…`), so scanning resumes right after the word.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- see above.
    CREDENTIAL_PHRASE.lastIndex = match.indices!.groups!.word![1]
  }
}

/**
 * The pass of every extended rule that adds a collector of its own. `card-strict`
 * and `entropy-strict` reuse the default collectors in `rules.ts` with a flag.
 */
export const EXTENDED_COLLECTORS: Readonly<Partial<Record<ExtendedRuleName, ExtendedCollector>>> = {
  'private-host': collectPrivateHostCandidates,
  'token-format': collectTokenFormatCandidates,
  'credential-phrase': collectCredentialPhraseCandidates,
}
