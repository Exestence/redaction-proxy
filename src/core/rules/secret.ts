/**
 * The credential rule: literal token formats, header and URL credentials, and
 * the assignment rule that reads a value out of `key = value` once the key name
 * names a credential and the value does not read as source code.
 *
 * @module redaction-proxy/core/rules/secret
 */

import { afterHighEscape, isAsciiPrintable, shannon } from './normalize.ts'
import type { PushCandidate } from './candidate.ts'
import { PRIORITY_SECRET } from './candidate.ts'

/** Longest assignment value the reader accepts. */
const VALUE_MAX = 256
/**
 * Longest identifier run either side of a keyword hit. An unbounded walk
 * rescans the whole text once per hit, which cost two minutes on 200KB of `key`.
 */
const KEY_SCAN_MAX = 128

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
const GITHUB_TOKEN = /\b(?:(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g
const SLACK_TOKEN = /\bxox[abposr]-[A-Za-z0-9-]{10,}/g
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
/** The literal token formats, each opening on a word boundary. */
const PREFIX_TOKENS = [AWS_KEY, GITHUB_TOKEN, SK_KEY, SLACK_TOKEN, GOOGLE_KEY, JWT]
/** The same formats opening right after a high escape (`%E6sk-…`), where `\b` does not hold. */
const PREFIX_TOKENS_AFTER_ESCAPE = PREFIX_TOKENS.map(pattern => afterHighEscape(pattern, '\\b'))
// A Slack incoming-webhook URL is itself the credential.
const SLACK_WEBHOOK = /hooks\.slack\.com\/services\/[A-Za-z0-9][A-Za-z0-9/_-]{9,120}/g
const BEARER = /(?<![a-z0-9])bearer[ \t]+([a-z0-9._~+/=-]{8,256})/gi
const AUTHORIZATION = /(?<![a-z0-9])authorization[ \t]*[:=][ \t]*([^\r\n]{4,256})/gi
const COOKIE = /^[ \t]*(?:set-)?cookie[ \t]*:[ \t]*([^\r\n]{1,256})/gim
const COOKIE_PAIR = /^[^=\s;]+=[^;]+/
/** Credential words that do not survive the Latin identifier scan. */
const CJK_SECRET = /(?:密碼|密码|口令|金鑰|金钥|密鑰|密钥|憑證|凭证|權杖|权杖|令牌)[ \t]*[:=][ \t]*/g
// Anchored on `://`: a greedy scheme run followed by a required `:` rescans
// every start position of a text that has no colon at all.
const URL_AUTHORITY = /:\/\//g
const CLI_USERINFO = /(?<![A-Za-z0-9-])(?:-u|--user)[ \t=]+([^\s:]{1,64}:[^\s]{1,128})/g
const UID_GID = /^\d+:\d+$/
const SECRET_KEYWORD = new RegExp([
  'api[_-]?key', 'apikey', 'client[_-]?secret', 'refresh[_-]?token', 'access[_-]?token',
  'auth[_-]?token', 'private[_-]?key', 'passphrase', 'password', 'passwd', 'secret',
  'session[_-]?id', 'session', 'token', 'sid', 'pwd', 'pass', 'key',
].join('|'), 'gi')

const IDENTIFIER_CHAR = /[A-Za-z0-9_.-]/
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/

/**
 * Whether only blanks and an optional `export ` stand between the start of
 * the line and `at`, as in an env file. It reads back over that run only, not
 * to the previous newline, so a long line of keys stays linear.
 * @param text - the whole text.
 * @param at - start of the key.
 * @returns whether the key opens an env line.
 */
function startsEnvLine(text: string, at: number): boolean {
  const blank = (i: number): boolean => text[i] === ' ' || text[i] === '\t'
  let i = at
  while (i > 0 && blank(i - 1)) i -= 1
  if (i < at && i >= 6 && text.startsWith('export', i - 6)) {
    i -= 6
    while (i > 0 && blank(i - 1)) i -= 1
  }
  return i === 0 || text[i - 1] === '\n'
}

const STRONG_KEYS = new Set([
  'apikey', 'clientsecret', 'refreshtoken', 'accesstoken', 'authtoken', 'privatekey',
  'passphrase', 'password', 'passwd', 'pass', 'secret',
])

const WEAK_KEYS = new Set(['token', 'session', 'sessionid', 'sid', 'pwd'])

/**
 * Words that make a hyphenated `pass` compound English prose. Any other
 * hyphenated compound is a key name: `db-pass` and `ldap-bind-pass` are how
 * Kubernetes Secret keys and Helm values spell a password field.
 */
const PROSE_PREFIX = new Set([
  'pre', 'post', 're', 'first', 'second', 'third', 'last', 'final', 'initial', 'single',
  'one', 'two', 'three', 'multi', 'dual', 'double', 'early', 'late', 'full', 'quick', 'fast',
  'slow',
])

/** Key names whose upper-case form alone justifies looking at the value. */
const UPPER_NAME_WORDS = new Set(['key', 'token', 'secret'])

const TYPE_WORDS = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'null', 'undefined',
  'object', 'symbol', 'bigint', 'true', 'false', 'Buffer', 'Date', 'RegExp', 'Promise',
  'Error', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet',
])

const CODE_ROOTS = new Set([
  'process', 'config', 'this', 'self', 'opts', 'options', 'globalThis', 'window', 'args',
  'argv', 'ctx', 'context', 'settings', 'props', 'state', 'data', 'params', 'req', 'res',
  'request', 'response', 'result', 'input', 'payload',
])

const CHAIN_KEY_WORDS = new Set([
  'password', 'passwd', 'secret', 'token', 'session', 'sessionid', 'sid', 'pwd', 'key',
  'apikey', 'credentials', 'auth',
])

/**
 * Language keywords and the identifiers an assignment most often carries in
 * source code. A value made only of these letters is a declaration, not a credential.
 */
const RESERVED_VALUE_WORDS = new Set([
  'await', 'async', 'keyof', 'readonly', 'typeof', 'instanceof', 'new', 'function', 'return',
  'const', 'let', 'var', 'class', 'extends', 'implements', 'interface', 'type', 'enum',
  'export', 'import', 'yield', 'delete', 'infer', 'satisfies', 'as', 'is', 'in',
  'of', 'this', 'super', 'throw', 'try', 'catch', 'finally', 'switch', 'case', 'break',
  'continue', 'do', 'while', 'for', 'if', 'else', 'public', 'private', 'protected', 'static',
  'abstract', 'declare', 'namespace', 'module', 'require', 'from', 'with', 'struct', 'func',
  'request', 'response', 'session', 'context', 'options', 'config', 'params', 'result',
  'value', 'values', 'data', 'input', 'output', 'error', 'event', 'message', 'payload',
  'buffer', 'stream', 'handler', 'callback', 'next', 'done', 'name', 'url', 'path',
  'file', 'entry', 'entries', 'item', 'items', 'record', 'schema', 'state',
])

/**
 * Words that describe an attribute of a credential rather than the credential:
 * `password_reset_url`, `access_token_ttl`, `private_key_path`, `SECRET-READ`,
 * `apiKeyEnv`. `id` and `text` are deliberately absent: Vault's `secret_id`
 * and Jenkins' `secret_text` are the credential itself.
 */
const QUALIFIER_WORDS = new Set([
  'url', 'uri', 'path', 'file', 'filename', 'dir', 'directory', 'name', 'type', 'kind',
  'mode', 'ttl', 'timeout', 'expiry', 'expires', 'length', 'max', 'min', 'size', 'count',
  'limit', 'hint', 'label', 'message', 'error', 'enabled', 'disabled', 'required', 'prompt',
  'placeholder', 'format', 'pattern', 'regex', 'header', 'flag', 'policy', 'rule', 'status',
  'env', 'field', 'param', 'list', 'default',
  'state', 'reason', 'note', 'doc', 'docs', 'example', 'sample', 'read', 'write', 'title',
  'description', 'tooltip', 'locale', 'lang', 'column', 'table', 'index', 'version',
  'algorithm', 'alg', 'method', 'scheme', 'strategy', 'provider', 'source', 'target',
  'prefix', 'suffix', 'separator', 'delimiter', 'encoding', 'charset', 'action', 'event',
  'handler', 'callback', 'selector', 'attribute', 'property', 'option', 'setting',
  'fallback', 'short', 'long', 'invalid', 'valid', 'style', 'icon', 'class', 'row', 'step',
  'stage', 'phase', 'round',
])

/**
 * How far a value extends once trailing sentence punctuation and brackets that
 * close nothing inside the value are dropped.
 * @param value - value text as read from the assignment.
 * @returns the length of the value without its trailing punctuation.
 */
export function trimValueEnd(value: string): number {
  let end = value.length
  while (end > 0) {
    const char = value.charAt(end - 1)
    if ('.,;:'.includes(char)) {
      end -= 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      const open = char === ')' ? '(' : char === ']' ? '[' : '{'
      let depth = 0
      for (let i = 0; i < end; i += 1) {
        if (value.charAt(i) === open) depth += 1
        else if (value.charAt(i) === char) depth -= 1
      }
      if (depth < 0) {
        end -= 1
        continue
      }
    }
    break
  }
  return end
}

/**
 * Whether a value leaves a bracket open, which marks a value the reader cut off
 * at a space inside a call or a generic, such as `Record<string,` or `Array<{`.
 * Any other unbalanced bracket belongs to the value: `hunter2<3you`, `abc(def`,
 * `a[b` and `love{u` are passwords, not code.
 * @param value - value text.
 * @returns whether any opener is still unmatched at the end.
 */
function hasUnclosedBracket(value: string): boolean {
  let round = 0
  let square = 0
  let curly = 0
  let angle = 0
  for (const char of value) {
    if (char === '(') round += 1
    else if (char === ')') round -= 1
    else if (char === '[') square += 1
    else if (char === ']') square -= 1
    else if (char === '{') curly += 1
    else if (char === '}') curly -= 1
    else if (char === '<') angle += 1
    else if (char === '>') angle -= 1
  }
  return round > 0 || square > 0 || curly > 0 || angle > 0
}

/**
 * Whether a value is a source expression the reader truncated.
 * @param value - value text as read, before trailing punctuation is dropped.
 * @param loose - whether any member-chain call counts, as it does under a general key word.
 * @returns whether the value is truncated code.
 */
function isTruncatedCode(value: string, loose: boolean): boolean {
  // A general key takes any member-chain call as code. A strong key only takes one
  // that was cut off, so `vi.fn(()` and `os.environ.get(` are code while
  // `auth.getToken(x)` is a value.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[([<]/.test(value)) return loose || hasUnclosedBracket(value)
  if (!/^[A-Za-z_$][\w$]*[([<]/.test(value)) return false
  // For a bare identifier, truncation shows at the end: `Record<string,` and
  // `Array<{` were cut at a space, while `fn(a,b)`, `abc(def` and `hunter2<3you`
  // are whole values.
  return /[,([{<]$/.test(value)
}

/**
 * Whether a value reads as code under the relaxed test a general key word uses.
 * A word such as `session`, `sid`, `token` or `key` names a variable far more
 * often than a credential, so its value is only a secret when it does not read
 * as code at all. Digits are the discriminator: identifiers carry none.
 * @param value - trimmed value text.
 * @returns whether the value is an identifier, a constant name, or a call.
 */
function isLooseCodeValue(value: string): boolean {
  if (/^[({[<]/.test(value)) return true
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*[([<]/.test(value)) return true
  // An upper-snake name needs no separate test: it also matches the identifier
  // pattern above.
  if (/^[A-Za-z_$][\w$.-]*$/.test(value) && !/\d/.test(value)) return true
  return false
}

/** How an assignment value was read, which changes which code shapes apply. */
export interface CodeShapeOptions {
  /** Whether the assignment is a `.env` line, where an upper-snake value is a real value. */
  envLine?: boolean
  /** Whether the key was a general word, which widens what counts as code. */
  loose?: boolean
  /** Whether the value was quoted, which means it was never truncated. */
  quoted?: boolean
}

/**
 * Whether an assignment value is source code rather than a credential. Only a
 * whole value qualifies: containing brackets, a leading `$`, or a dot is never
 * on its own a reason to skip masking.
 * @param raw - value text as read from the assignment.
 * @param options - how the value was read.
 * @returns whether the value must not be masked.
 */
export function isCodeShape(raw: string, options: CodeShapeOptions = {}): boolean {
  const value = raw.slice(0, trimValueEnd(raw))
  if (value.length === 0) return true
  if (TYPE_WORDS.has(value)) return true
  if (RESERVED_VALUE_WORDS.has(value.toLowerCase()) && /^[A-Za-z]+$/.test(value)) return true
  if (/^\$\{[^{}]*\}$/.test(value)) return true
  // A call with arguments can carry a literal secret, so only an empty argument list counts.
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\(\s*\)$/.test(value)) return true
  const generic = /^[A-Za-z_$][\w$]*<([^<>]*)>$/.exec(value)
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern has one group.
  const parts = generic === null ? [] : generic[1]!.split(',')
  if (generic !== null && parts.every(part => TYPE_WORDS.has(part.trim()) || /^[A-Z][A-Za-z0-9]*$/.test(part.trim()))) {
    return true
  }
  // Checked before trimming: the comma that marks the truncation sits at the end.
  // A quoted value is a literal, so `password="a.b("` was never cut off.
  if (options.quoted !== true && isTruncatedCode(raw, options.loose === true)) return true
  if (options.loose === true && isLooseCodeValue(value)) return true
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(value)) {
    const segments = value.split(/\??\./)
    // A digit in a segment marks a concrete value such as `config.prod2026`, not a code path.
    if (!segments.some(segment => /\d/.test(segment))) {
      if (value.includes('?.')) return true
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a split yields at least one part.
      if (CODE_ROOTS.has(segments[0]!)) return true
      if (segments.some(segment => /^[a-z][A-Za-z0-9]*[A-Z]/.test(segment))) return true
      if (segments.some(segment => CHAIN_KEY_WORDS.has(segment.toLowerCase()))) return true
    }
  }
  // `.env` lines carry real values, so an upper-snake value there is never a constant name.
  if (options.envLine !== true && UPPER_SNAKE.test(value)) {
    const segments = value.split('_')
    const named = segments.length > 1 && !segments.some(segment => segment.length <= 1)
    if (named && !/\d{4,}/.test(value)) return true
  }
  return false
}

/** Where an assignment's value sits, and whether quotes delimited it. */
interface ValueRead {
  start: number
  end: number
  quoted: boolean
}

/**
 * Read the value an assignment gives, starting after the assignment operator.
 * @param text - text being scanned.
 * @param from - offset just past the operator.
 * @param weak - whether `&` ends the value, as it does in a query string under a general key.
 * @returns the value's range, or `undefined` when a quote never closes.
 */
function readAssignmentValue(text: string, from: number, weak: boolean): ValueRead | undefined {
  let i = from
  while (text.charAt(i) === ' ' || text.charAt(i) === '\t') i += 1
  const quote = text.charAt(i)
  if (quote === '"' || quote === "'" || quote === '`') {
    let close = i + 1
    while (close < text.length && close - i <= VALUE_MAX) {
      if (text.charAt(close) === '\\') {
        close += 2
        continue
      }
      if (text.charAt(close) === quote || text.charAt(close) === '\n') break
      close += 1
    }
    if (close >= text.length || text.charAt(close) !== quote) return undefined
    return { start: i + 1, end: close, quoted: true }
  }
  const start = i
  while (i < text.length && i - start < VALUE_MAX) {
    const char = text.charAt(i)
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') break
    if (char === '"' || char === "'" || char === '`' || char === ';') break
    if (weak && char === '&') break
    i += 1
  }
  return { start, end: i, quoted: false }
}

/**
 * Split a key name into words on separators and camel-case transitions, so
 * `sessionId` and `SessionEventType` no longer read as the key `session`.
 * @param keyName - identifier a value is assigned to.
 * @returns the lower-cased words in order.
 */
function splitKeyWords(keyName: string): string[] {
  const words: string[] = []
  for (const part of keyName.split(/[_.\-]+/)) {
    if (part.length === 0) continue
    // A zero-width split never yields an empty piece, because `part` is not empty.
    for (const word of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      words.push(word.toLowerCase())
    }
  }
  return words
}

/** Which credential rule a key name qualifies for. */
export interface KeyClass {
  /** Whether a strong credential word occurs anywhere in the key name. */
  strong: boolean
  /** Whether a general credential word ends the key name. */
  weak: boolean
  /** Whether an upper-case key name ends in `key`, `token`, or `secret`. */
  upper: boolean
  /** Whether the key is the bare English word `pass`, which needs an explicit `=`. */
  passOnly: boolean
}

/**
 * Decide which credential rule a key name qualifies for. A keyword only counts
 * when it spans a whole trailing run of the key's words, so `DB_PASSWORD` and
 * `apiKey` match while `SessionEventType` does not.
 * @param keyName - identifier the value is assigned to.
 * @returns the matched rule, or `undefined` when the key names no credential.
 */
export function classifyKeyName(keyName: string): KeyClass | undefined {
  // Only the last 16 words are read. No keyword spans more than two of them, and
  // joining every combination of a 256-character key name cost 1.5s on 200KB of `KEY_`.
  const all = splitKeyWords(keyName)
  const words = all.slice(Math.max(0, all.length - 16))
  let strong = false
  let passOnly = true
  let weak = false
  let named = false
  // A strong word carries the same weight wherever it sits, so `aws_secret_access_key`,
  // `secretKey` and `password_hash` all count.
  for (let start = 0; start < words.length; start += 1) {
    for (let span = 1; span <= 2 && start + span <= words.length; span += 1) {
      const joined = words.slice(start, start + span).join('')
      if (!STRONG_KEYS.has(joined)) continue
      strong = true
      if (joined !== 'pass') passOnly = false
    }
  }
  // A general word only counts when it ends the key name, so `SessionEventType`
  // and `sessionStore` stay ordinary identifiers.
  for (let span = 1; span <= 2 && span <= words.length; span += 1) {
    const joined = words.slice(words.length - span).join('')
    if (WEAK_KEYS.has(joined)) weak = true
    if (UPPER_NAME_WORDS.has(joined)) named = true
  }
  const upper = named && UPPER_SNAKE.test(keyName)
  if (!strong && !weak && !upper) return undefined
  // `password_reset_url` holds a URL and `SECRET-READ` holds a mode; neither is
  // the secret. A credential word ending the key name wins, so `session_id` and
  // `secret_key` still count.
  let endsWithCredential = false
  for (let span = 1; span <= 2 && span <= words.length; span += 1) {
    const joined = words.slice(words.length - span).join('')
    if (STRONG_KEYS.has(joined) || WEAK_KEYS.has(joined) || UPPER_NAME_WORDS.has(joined)) {
      endsWithCredential = true
    }
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a matched rule needs at least one word.
  if (!endsWithCredential && QUALIFIER_WORDS.has(words[words.length - 1]!)) return undefined
  // `pass` on its own, or behind an ordinal, is English: `--- PASS: TestFoo`,
  // `Pre-pass: package name`, `first-pass`. An underscore, a dot, camel case, a
  // leading `--`, or any other hyphenated prefix marks a key instead: `db_pass`,
  // `db.pass`, `dbPass`, `--pass`, `db-pass`.
  const bare = keyName.toLowerCase().endsWith('pass') &&
    !keyName.startsWith('--') &&
    /^[A-Za-z-]+$/.test(keyName) &&
    !/[a-z][A-Z]/.test(keyName) &&
    // oxlint-disable-next-line typescript/no-non-null-assertion -- two or more words have a second-to-last.
    (words.length === 1 || PROSE_PREFIX.has(words[words.length - 2]!))
  return { strong, weak, upper, passOnly: strong && passOnly && bare }
}

/**
 * Reduce a key or value to the letters and digits that name it.
 * @param value - key name or value text.
 * @returns the lower-case alphanumeric run of the input.
 */
export function normalizeKeyName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
}

/**
 * Whether a value is itself a credential word, such as `password` or `apiKey`.
 * Such a value is masked where the rule found it but never propagated, or every
 * mention of the word in the request would be masked with it.
 * @param value - a detected original.
 * @returns whether the value names a credential instead of being one.
 */
export function isKeywordValue(value: string): boolean {
  const normalized = normalizeKeyName(value)
  return STRONG_KEYS.has(normalized) || WEAK_KEYS.has(normalized) || UPPER_NAME_WORDS.has(normalized)
}

/**
 * Collect every credential candidate of one text.
 * @param text - text to scan.
 * @param push - sink for candidates.
 * @param afterEscape - whether `text` holds a high escape, which then also opens a token.
 * @returns nothing; candidates reach `push`.
 */
export function collectSecretCandidates(text: string, push: PushCandidate, afterEscape = false): void {
  const secret = (start: number, end: number): void => {
    push(start, end, 'KEY', PRIORITY_SECRET)
  }
  const runAll = (pattern: RegExp, handler: (match: RegExpExecArray) => void): void => {
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) handler(match)
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- every pattern below has one group.
  const captured = (match: RegExpExecArray): string => match[1]!

  PEM_BEGIN.lastIndex = 0
  for (let match = PEM_BEGIN.exec(text); match !== null; match = PEM_BEGIN.exec(text)) {
    const closing = PEM_END.exec(text.slice(match.index))
    const end = closing === null ? text.length : match.index + closing.index + closing[0].length
    secret(match.index, end)
    PEM_BEGIN.lastIndex = end
  }

  for (const pattern of [...PREFIX_TOKENS, ...afterEscape ? PREFIX_TOKENS_AFTER_ESCAPE : [], SLACK_WEBHOOK]) {
    runAll(pattern, (match) => {
      secret(match.index, match.index + match[0].length)
    })
  }

  for (const pattern of [BEARER, AUTHORIZATION]) {
    runAll(pattern, (match) => {
      const value = captured(match)
      const at = match.index + match[0].length - value.length
      if (isCodeShape(value)) return
      secret(at, at + trimValueEnd(value))
    })
  }

  runAll(COOKIE, (match) => {
    const at = match.index + match[0].length - captured(match).length
    const value = captured(match).trimEnd()
    if (value.length < 8) return
    if (!COOKIE_PAIR.test(value)) return
    secret(at, at + value.length)
  })

  runAll(URL_AUTHORITY, (match) => {
    const start = match.index + 3
    const limit = Math.min(text.length, start + 256)
    let colon = -1
    for (let i = start; i < limit; i += 1) {
      const char = text.charAt(i)
      if (char === '@') {
        if (colon >= 0) secret(start, i)
        return
      }
      if (char === ':') colon = i
      else if (char === '/' || char === '?' || char === '#' || /\s/.test(char)) return
    }
  })

  runAll(CLI_USERINFO, (match) => {
    // `-u 1000:1000` is a uid and gid pair, not a login.
    if (UID_GID.test(captured(match))) return
    const at = match.index + match[0].length - captured(match).length
    secret(at, at + captured(match).length)
  })

  runAll(CJK_SECRET, (match) => {
    const read = readAssignmentValue(text, match.index + match[0].length, false)
    if (read === undefined) return
    const end = read.start + trimValueEnd(text.slice(read.start, read.end))
    if (end - read.start < 3) return
    if (isCodeShape(text.slice(read.start, read.end))) return
    secret(read.start, end)
  })

  runAll(SECRET_KEYWORD, (match) => {
    // Both walks are capped; see KEY_SCAN_MAX.
    let keyStart = match.index
    const floor = Math.max(0, match.index - KEY_SCAN_MAX)
    while (keyStart > floor && IDENTIFIER_CHAR.test(text.charAt(keyStart - 1))) keyStart -= 1
    let keyEnd = match.index + match[0].length
    const ceiling = Math.min(text.length, keyEnd + KEY_SCAN_MAX)
    while (keyEnd < ceiling && IDENTIFIER_CHAR.test(text.charAt(keyEnd))) keyEnd += 1
    const keyName = text.slice(keyStart, keyEnd)

    const matched = classifyKeyName(keyName)
    if (matched === undefined) return
    const { strong, upper } = matched

    // A quoted key covers JSON, YAML and PHP; `:=` and `=>` cover Go and PHP assignment.
    let at = keyEnd
    const quote = text.charAt(keyStart - 1)
    const quoted = (quote === '"' || quote === "'" || quote === '`') && text.charAt(at) === quote
    if (quoted) at += 1
    while (text.charAt(at) === ' ' || text.charAt(at) === '\t') at += 1
    let after = at + 1
    let assign = text.charAt(at)
    if (assign === ':' && text.charAt(after) === '=') {
      after += 1
      assign = '='
    } else if (assign === '=' && text.charAt(after) === '>') {
      // Only PHP writes `'key' => value`; unquoted, `password => validate(password)`
      // is an arrow function.
      if (!quoted) return
      after += 1
    }
    // `pass` is an ordinary English word, so it only names a credential in an
    // explicit assignment: `First pass: the actual output` is prose.
    if (matched.passOnly && assign !== '=' && !quoted) return
    // A long command-line flag takes its value after a space: `--password hunter2`.
    if (assign !== ':' && assign !== '=' && !(keyName.startsWith('--') && at > keyEnd)) return
    if (assign !== ':' && assign !== '=') {
      after = at
      assign = '='
    }
    // A general word only names a credential under `=`; `session: x` is a field.
    // Under `=` there is nothing left to exclude: `classifyKeyName` returns a
    // rule only when at least one of `strong`, `weak`, and `upper` holds.
    if (assign === ':' && !strong && !upper) return

    const read = readAssignmentValue(text, after, !strong && !upper)
    if (read === undefined) return
    const raw = text.slice(read.start, read.end)
    const end = read.start + trimValueEnd(raw)
    if (end - read.start < 3) return
    const envLine = assign === '=' && UPPER_SNAKE.test(keyName) && startsEnvLine(text, keyStart)
    if (isCodeShape(raw, { envLine, loose: !strong, quoted: read.quoted })) return
    if (!strong && upper && shannon(text.slice(read.start, end)) < 2.5) return
    secret(read.start, end)
  })
}

/**
 * Whether a detected original is long and distinctive enough to propagate.
 * Without this guard `王` masks inside `國王` and `12345678` inside `123456789`.
 * @param value - a detected original.
 * @returns whether the value may be searched for elsewhere.
 */
export function isPropagatableValue(value: string): boolean {
  if (isKeywordValue(value)) return false
  if (isAsciiPrintable(value)) return value.length >= 6
  // oxlint-disable-next-line typescript/no-misused-spread -- the guard counts code points, not graphemes.
  return [...value].length >= 2
}
