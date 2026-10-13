/**
 * The redaction proxy: an HTTP server, on 127.0.0.1 by default, that masks the text of
 * OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages requests,
 * forwards them to the configured upstream with the client's own credentials,
 * and restores placeholders in the JSON or SSE response.
 *
 * Placeholder numbering is re-derived from the whole request on every call.
 * Clients resend the full history, and allocation follows text order, so an
 * append-only conversation keeps its identities across turns without any
 * server-side state. Two things are kept in memory per client credential:
 * the original input texts of each Responses response, for requests that
 * continue with `previous_response_id` and do not resend history, and the
 * originals the client's requests bound, so a later request whose history no
 * longer holds the context that detected a value (`password: …`) still masks it.
 *
 * @module redaction-proxy/proxy/server
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { RedactionError, RulesDetector, createStreamRestorer, emptyRedactionIndex, mask, screenText } from '../core/index.ts'
import type { PlaceholderEvent, PlaceholderOutcome, RedactionDetector, RedactionId, RedactionRegistry, StreamRestoreOptions, StreamRestorer } from '../core/index.ts'
import { NameModelDetector, NameModelError, containsStandingAlone, isSearchedValue } from '../core/model/detector.ts'
import { isProtocolFieldName } from '../core/rules/secret.ts'
import type { NameModel } from '../core/model/name-model.ts'
import { NAME_MODEL_CATEGORIES } from '../core/model/config.ts'
import { isLoopbackHost, toolKey } from './config.ts'
import type { ProxyConfig, ToolRestorePolicy } from './config.ts'

/** Which wire API a route speaks. */
type Api = 'chat' | 'responses' | 'messages'

const ROUTES: Readonly<Record<string, Api>> = {
  '/v1/chat/completions': 'chat',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages',
  '/v1/messages/count_tokens': 'messages',
}

/**
 * Request keys whose string values are never masked: identifiers, enums,
 * names the API matches exactly, binary payloads, and signed or encrypted
 * model state that must be resent byte for byte. An object or array under
 * one of them is searched like any other.
 */
const SKIP_MASK = new Set([
  'model', 'role', 'type', 'id', 'call_id', 'tool_call_id', 'tool_use_id', 'name', 'previous_response_id',
  'signature', 'thinking', 'data', 'encrypted_content', 'media_type', 'url', 'image_url', 'file_id', 'file_data',
  'cache_control', 'format', 'status', 'service_tier', 'reasoning_effort', 'tool_choice',
])

/** Request keys whose whole value is forwarded unmasked: caller metadata and exact stop strings. */
const SKIP_SUBTREE = new Set(['metadata', 'stop'])

/** Response keys whose strings stay as the model sent them: signed or encrypted state. */
const SKIP_RESTORE = new Set(['signature', 'thinking', 'data', 'encrypted_content'])

/** Keys whose string value is JSON text, so originals are written JSON-escaped. */
const JSON_TEXT = new Set(['arguments', 'partial_json'])

/** Top-level request keys masked first, so the stable request head keeps its identities. */
const HEAD_FIRST = ['tools', 'functions', 'system', 'instructions']

/** Content-part types that carry user-written text: Chat and Messages `text`, Responses `input_text`. */
const USER_TEXT_PARTS = new Set(['text', 'input_text'])

/**
 * A message's own text: `/messages/N/content` or one of its parts, `/messages/N/content/K/text` (or `/input/...`).
 * Matches the JSON pointers {@link collectSlots} builds; change both together.
 */
const MESSAGE_TEXT_PATH = /^\/(messages|input)\/(\d+)\/content(?:\/(\d+)\/text)?$/

/**
 * Request keys whose string values the API accepts only from a fixed
 * list, so they hold no private data; the leak scan skips an {@link ENUM_VALUE}
 * under one of them outside client data, or a value such as a term
 * `assistant` would refuse every request with an assistant turn.
 */
const ENUM_FIELDS = new Set(['type', 'role', 'object', 'status', 'finish_reason', 'stop_reason', 'service_tier', 'reasoning_effort', 'tool_choice'])

/** What an API enum value looks like: `assistant`, `input_text`, `json_object`, `flex`. */
const ENUM_VALUE = /^[a-z][a-z0-9_.:-]{0,63}$/

/** Categories the name model binds; the leak scan matches their values as whole words. */
const MODEL_CATEGORIES: ReadonlySet<string> = new Set(NAME_MODEL_CATEGORIES)

/** Categories of the configured `terms` and `projectNames`; the leak scan matches their values as whole words in any ASCII case. */
const LITERAL_CATEGORIES: ReadonlySet<string> = new Set(['TERM', 'PROJECT'])

/** Headers that describe one hop or the body encoding, never forwarded. */
const HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'content-length', 'content-encoding', 'accept-encoding',
])

// ponytail: fixed-size FIFO of continuation texts; a restart forgets them (documented).
const CONTINUATIONS_MAX = 256

// ponytail: fixed-size FIFOs of known originals per bucket, besides the configured time to live.
const KNOWN_ORIGINALS_MAX = 4096
const KNOWN_CLIENTS_MAX = 64

// ponytail: fixed cap above Anthropic's 32 MB request limit; make it a setting if a provider accepts more.
const BODY_MAX_BYTES = 64 * 1024 * 1024

/** Header carrying `authToken`; it authenticates the client to the proxy and is never forwarded. */
const TOKEN_HEADER = 'x-redaction-proxy-token'

/** One maskable string inside a request body. */
interface Slot {
  /** Object or array holding the string. */
  parent: Record<string, unknown> | unknown[]
  /** Key or index of the string in `parent`. */
  key: string | number
  /** JSON pointer of the string, keys through {@link pointerSegment}, for diagnostics that never carry text. */
  path: string
}

/** Per-request counters for the log line. */
interface Stats {
  masked: Record<string, number>
  restored: number
  unknown: number
  /** Placeholders left as written: inside a URL, or in tool arguments outside the tool restore policy. */
  kept: number
  nameModelFailed: boolean
}

/** Keys a diagnostic names as written: the lower-case identifiers the three APIs and most tool schemas use. */
const NAMEABLE_KEY = /^[a-z][a-z0-9_]{0,39}$/

/**
 * One JSON pointer segment for a refusal or a log line. Any other key is
 * written `<key>`, since a key is request or model text that may hold
 * personal data or forge a log line.
 * @param key - object key, array index, or `undefined` for a key not yet read.
 * @returns the segment.
 */
function pointerSegment(key: string | number | undefined): string {
  return typeof key === 'number' ? String(key) : key !== undefined && NAMEABLE_KEY.test(key) ? key : '<key>'
}

/** Tool names a log line writes as given; any other is written `<tool>`. */
const NAMEABLE_TOOL = /^[A-Za-z0-9_.:-]{1,64}$/

/** One state of {@link containsAnyOf}: a prefix of some pattern. */
interface TrieNode {
  next: Map<number, TrieNode>
  /** Longest proper suffix of this prefix that is also a prefix. */
  fail: TrieNode
  /** Whether this prefix ends with a whole pattern. */
  terminal: boolean
}

/** How a tool-argument log line describes each placeholder outcome. */
const OUTCOME_LOG: Readonly<Record<PlaceholderOutcome, string>> = {
  restored: 'restored',
  inUrl: 'kept inside a URL',
  refused: 'kept by the tool restore policy',
}

/** A remembered original: its category, and when it is forgotten (epoch milliseconds). */
interface KnownOriginal {
  category: string
  expires: number
}

/** Original texts of one request, kept for a Responses continuation. */
interface RequestTexts {
  texts: string[]
  /** The texts the user wrote, which the name model reads. */
  userTexts: Set<string>
}

/** A request body after masking; `texts` holds a continuation's earlier texts first. */
interface MaskedRequest extends RequestTexts {
  /** The masked body, serialized. */
  outgoing: string
  /** Bindings of the mask call. */
  registry: RedactionRegistry
  /** Why masking failed, naming fields and categories, never values; set only when `sendWhenMaskFails` let the body go out anyway. */
  maskFailed?: string
}

/** Bindings of a request whose masking threw: nothing to restore. */
const EMPTY_REGISTRY: RedactionRegistry = {
  original: () => undefined,
  ids: () => [],
  originals: () => [],
  subset: () => EMPTY_REGISTRY,
}

/** Response header set to `1` on a reply to a request sent although its masking failed. */
const MASK_FAILED_HEADER = 'x-redaction-proxy-mask-failed'

/**
 * Category of a placeholder identity: `EMAIL` of `EMAIL_3`.
 * @param id - a placeholder identity.
 * @returns its category.
 */
function categoryOf(id: string): string {
  return id.slice(0, id.lastIndexOf('_'))
}

/**
 * Scope of one client's in-memory state: a digest of the credential the
 * request is forwarded with. Clients without one of their own share the
 * configured key's scope.
 * @param headers - the headers sent upstream.
 * @returns the hex digest; the credential itself is never kept.
 */
function clientScope(headers: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(headers.authorization ?? headers['x-api-key'] ?? '').digest('hex')
}

/**
 * Whether a later request may search for an original: as long as a value the
 * rules propagate by length alone, six printable ASCII characters or two other
 * code points. A shorter credential is masked throughout the request that
 * detected it; remembering it would mask `ab1` inside every later `ab12`. A
 * protocol field name such as `data_store` is masked in its own request only:
 * remembered, it would mask every later request text that names that field.
 * @param original - a bound original.
 * @returns whether it is remembered.
 */
function isRememberable(original: string): boolean {
  if (isProtocolFieldName(original)) return false
  // oxlint-disable-next-line typescript/no-misused-spread -- the floor counts code points, not graphemes.
  return /^[\x20-\x7e]*$/.test(original) ? original.length >= 6 : [...original].length >= 2
}

/**
 * Lower-case the ASCII letters of a text, keeping its length, so offsets into it hold for the text.
 * @param text - any text.
 * @returns the folded text.
 */
function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]+/g, run => run.toLowerCase())
}

/**
 * Add the originals one client has bound before to a detector's propagation,
 * so each of their occurrences is masked as if this request had detected it.
 * A remembered credential is also found in any ASCII case: `TR0UB4DOR&3X`
 * repeats `Tr0ub4dor&3x`, and is masked under its own identity. Every value
 * is also found JSON-escaped, as a resent tool call's `arguments` writes it
 * (`p@ss\\word`), under the identity of its plain spelling, unless that
 * spelling is itself a bound or remembered value.
 * @param detector - the request's detector.
 * @param known - the client's known originals, mapped to their categories.
 * @param escaped - receives each JSON-escaped spelling searched for, mapped to its plain spelling; no other value binds these.
 * @param detected - receives the originals this request's detector found, before any remembered value is added.
 * @returns the detector to mask with.
 */
function withKnownOriginals(detector: RedactionDetector, known: ReadonlyMap<string, string> | undefined, escaped: Map<string, string>, detected: Set<string>): RedactionDetector {
  const keys = new Map([...known ?? []].filter(([, category]) => category === 'KEY').map(([original]) => [foldAsciiCase(original), 'KEY']))
  return {
    policyDigest: detector.policyDigest,
    detectorVersion: detector.detectorVersion,
    categories: detector.categories,
    detect: text => detector.detect(text),
    propagate: async (texts, values) => {
      for (const original of values.keys()) detected.add(original)
      const all = new Map([...known ?? [], ...values])
      const spellings = new Map<string, string>()
      for (const [original, category] of all) {
        const spelling = JSON.stringify(original).slice(1, -1)
        // A spelling that is itself bound or remembered is a value of its own: `ab\\cd` typed beside `ab\cd`.
        if (spelling === original || all.has(spelling)) continue
        escaped.set(spelling, original)
        spellings.set(spelling, category)
      }
      return [
        ...await detector.propagate?.(texts, all) ?? [],
        ...keys.size === 0 ? [] : await detector.propagate?.(texts.map(foldAsciiCase), keys) ?? [],
        ...spellings.size === 0 ? [] : await detector.propagate?.(texts, spellings) ?? [],
      ]
    },
    identityKey: (value, category) => {
      const plain = escaped.get(value) ?? value
      return detector.identityKey?.(plain, category) ?? plain
    },
  }
}

/**
 * Restore each identity as its plain spelling when a JSON-escaped spelling was
 * bound first, so restoring into `arguments` escapes it once, not twice.
 * @param registry - bindings of a mask call.
 * @param escaped - JSON-escaped spellings mapped to their plain spellings.
 * @returns the registry to restore and remember from.
 */
function unescaping(registry: RedactionRegistry, escaped: ReadonlyMap<string, string>): RedactionRegistry {
  return {
    original: id => {
      const original = registry.original(id)
      return original === undefined ? undefined : escaped.get(original) ?? original
    },
    ids: () => registry.ids(),
    originals: () => registry.originals(),
    subset: ids => unescaping(registry.subset(ids), escaped),
  }
}

/**
 * Move a key to the newest end of a FIFO map and drop the oldest entries beyond a cap.
 * @param map - the map, oldest entry first.
 * @param key - the key to add or refresh.
 * @param value - its value.
 * @param max - most entries kept.
 */
function setNewest<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  for (const oldest of map.keys()) {
    if (map.size <= max) return
    map.delete(oldest)
  }
}

/** A request the proxy refuses before anything is forwarded. */
class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Collect every maskable string of a request body in a stable order. Inside
 * tool input ({@link isToolInput}) every string is masked whatever its key,
 * since restore writes originals into every string of a reply's tool input
 * and no signed state lives there.
 * @param value - parsed JSON value.
 * @param path - JSON pointer of `value`.
 * @param out - slot sink.
 * @param tool - whether `value` is tool input or inside it.
 */
function collectSlots(value: unknown, path: string, out: Slot[], tool = false): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') out.push({ parent: value, key: index, path: `${path}/${index}` })
      else collectSlots(item, `${path}/${index}`, out, tool)
    })
    return
  }
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const ordered = path === '' ? [...HEAD_FIRST.filter(key => key in record), ...keys.filter(key => !HEAD_FIRST.includes(key))] : keys
  for (const key of ordered) {
    if (!tool && SKIP_SUBTREE.has(key)) continue
    const item = record[key]
    const at = `${path}/${pointerSegment(key)}`
    if (typeof item !== 'string') collectSlots(item, at, out, tool || isToolInput(record, key))
    else if (tool || !SKIP_MASK.has(key) || isTextSource(record, key)) out.push({ parent: record, key, path: at })
  }
}

/**
 * Whether `record[key]` is the text of a plain-text document source, such as
 * Anthropic's `{ type: 'text', media_type: 'text/plain', data }`, rather than
 * base64 bytes.
 * @param record - a request object.
 * @param key - one of its keys.
 * @returns whether the value is document text.
 */
function isTextSource(record: Record<string, unknown>, key: string): boolean {
  return key === 'data' && record.type === 'text'
}

/**
 * Whether `record[key]` is a resent tool call's input, whose keys and values
 * the tool defines: an Anthropic `*tool_use` block's `input`, or an object
 * under a Responses `*_call` item's own fields, such as `local_shell_call`'s
 * `action`. The item's identifiers, name, type, and status are not.
 * @param record - a request object.
 * @param key - one of its keys.
 * @returns whether the value is tool input.
 */
function isToolInput(record: Record<string, unknown>, key: string): boolean {
  const type = String(record.type)
  return /tool_use$/.test(type) ? key === 'input' : /_call$/.test(type) && !SKIP_MASK.has(key)
}

/**
 * Whether a request string is message text of one of the given roles: a
 * message's string content or one of its text parts, or a Responses string
 * `input`, which is the user's. Tool results are not.
 * @param body - the parsed request body.
 * @param path - JSON pointer of the string.
 * @param roles - the message roles that count.
 * @returns whether the string is such text.
 */
function isRoleText(body: Json, path: string, roles: ReadonlySet<string>): boolean {
  if (path === '/input') return true
  const match = MESSAGE_TEXT_PATH.exec(path)
  if (match === null) return false
  const [, list, message, part] = match
  const item = (body[list as string] as Json[] | undefined)?.[Number(message)]
  if (item === undefined || !roles.has(item.role)) return false
  return part === undefined || USER_TEXT_PARTS.has((item.content as Json[])[Number(part)]?.type)
}

/** The role whose text the name model reads. */
const USER_ROLE: ReadonlySet<string> = new Set(['user'])

/** Roles whose text the client itself wrote: the user's messages and the system or developer prompt. */
const CLIENT_ROLES: ReadonlySet<string> = new Set(['user', 'system', 'developer'])

/** The top-level system prompt: Anthropic `system` as a string or text blocks, Responses `instructions`. */
const SYSTEM_PATH = /^\/(system(\/\d+\/text)?|instructions)$/

/**
 * Whether a request string is text the client itself wrote rather than tool
 * output or a model turn: user text ({@link isRoleText}) or a system or developer prompt.
 * @param body - the parsed request body.
 * @param path - JSON pointer of the string.
 * @returns whether a value bound in it is remembered apart from tool output.
 */
function isClientText(body: Json, path: string): boolean {
  return SYSTEM_PATH.test(path) || isRoleText(body, path, CLIENT_ROLES)
}

/**
 * Lower-case one ASCII letter's code unit; any other code unit is returned as is.
 * @param code - a UTF-16 code unit.
 * @returns the folded code unit.
 */
function foldAscii(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code
}

/**
 * Build a test for whether a text contains any of the patterns, ignoring
 * ASCII case, in one pass over the text (Aho-Corasick): checking each
 * pattern against each string took seconds once a request carried thousands
 * of distinct values.
 * @param patterns - non-empty strings to look for.
 * @returns a function telling whether a text contains at least one pattern.
 */
function containsAnyOf(patterns: readonly string[]): (text: string) => boolean {
  const root = { next: new Map(), terminal: false } as TrieNode
  root.fail = root
  for (const pattern of patterns) {
    let node = root
    for (let i = 0; i < pattern.length; i += 1) {
      const char = foldAscii(pattern.charCodeAt(i))
      let child = node.next.get(char)
      if (child === undefined) {
        child = { next: new Map(), fail: root, terminal: false }
        node.next.set(char, child)
      }
      node = child
    }
    node.terminal = true
  }
  const step = (from: TrieNode, char: number): TrieNode => {
    let state = from
    while (state !== root && !state.next.has(char)) state = state.fail
    return state.next.get(char) ?? root
  }
  const queue = [root]
  for (const node of queue) {
    for (const [char, child] of node.next) {
      child.fail = node === root ? root : step(node.fail, char)
      child.terminal ||= child.fail.terminal
      queue.push(child)
    }
  }
  return text => {
    let state = root
    for (let i = 0; i < text.length; i += 1) {
      state = step(state, foldAscii(text.charCodeAt(i)))
      if (state.terminal) return true
    }
    return false
  }
}

/**
 * Find where a masked body still holds a value this request detected: in a
 * field the proxy does not rewrite (metadata, an image URL), or an occurrence
 * masking could not cover. A name-model value or configured literal is
 * matched as its propagation matches it, as a whole word for spaced scripts
 * (`Lee` inside `Leeds`, a term `Hsin` inside `Hsinchu` is no leak): a model
 * value as written and only from two code points, a literal in any ASCII
 * case. Every other value counts anywhere, at any length and in any ASCII
 * case, so a rules value glued to other characters (`tel0912345678`) or
 * upper-cased still fails closed. A value
 * only remembered from an earlier request is not checked: memory adds
 * masking, never a refusal. Keys are checked too; an {@link ENUM_VALUE} under
 * one of the {@link ENUM_FIELDS} is not, except in client data: `metadata`,
 * `stop`, and tool input.
 * @param body - the masked request body.
 * @param bound - every spelling of a detected value the mask call bound, mapped to its category.
 * @param modelValues - the originals the name model bound.
 * @returns up to five JSON pointers, each with the category of what it holds, never the value; `undefined` when nothing leaks.
 */
function findLeaks(body: Json, bound: ReadonlyMap<string, string>, modelValues: ReadonlySet<string>): string | undefined {
  // A value inside a JSON-text string (`arguments`) is written JSON-escaped.
  const forms = (original: string): string[] => [original, JSON.stringify(original).slice(1, -1)]
  const isWord = (original: string, category: string): boolean => modelValues.has(original) || LITERAL_CATEGORIES.has(category)
  const words = [...bound].filter(([original, category]) => isWord(original, category) && (!modelValues.has(original) || isSearchedValue(original)))
  const holdsWord = containsAnyOf(words.flatMap(([original]) => forms(original)))
  const holdsSubstring = containsAnyOf([...bound].filter(([original, category]) => !isWord(original, category)).flatMap(([original]) => forms(original)))
  const standsIn = (text: string, folded: string, original: string): boolean => modelValues.has(original)
    ? forms(original).some(form => containsStandingAlone(text, form))
    : forms(original).some(form => containsStandingAlone(folded, foldAsciiCase(form)))
  const leaks = (text: string): boolean => {
    if (holdsSubstring(text)) return true
    if (!holdsWord(text)) return false
    const folded = foldAsciiCase(text)
    return words.some(([original]) => standsIn(text, folded, original))
  }
  const where: Array<[path: string, text: string]> = []
  const walk = (value: unknown, path: string, key: string, data: boolean): void => {
    if (typeof value === 'string') {
      const isEnum = !data && ENUM_FIELDS.has(key) && ENUM_VALUE.test(value)
      if (!isEnum && leaks(value)) where.push([path, value])
    } else if (value !== null && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        const leakyKey = leaks(name)
        const at = `${path}/${leakyKey ? '<key>' : pointerSegment(Array.isArray(value) ? Number(name) : name)}`
        if (leakyKey) where.push([at, name])
        walk(item, at, name, data || SKIP_SUBTREE.has(name) || isToolInput(value as Record<string, unknown>, name))
      }
    }
  }
  walk(body, '', '', false)
  if (where.length === 0) return undefined
  // The leak path alone looks up which value each text holds, the way `leaks` matches it.
  const holds = (text: string, original: string, category: string): boolean => isWord(original, category)
    ? words.some(([word]) => word === original) && standsIn(text, foldAsciiCase(text), original)
    : forms(original).some(form => foldAsciiCase(text).includes(foldAsciiCase(form)))
  const describe = ([path, text]: [string, string]): string => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `leaks` found some bound original in the text.
    const [, category] = [...bound].find(([original, of]) => holds(text, original, of))!
    return `${path} (${category})`
  }
  return where.slice(0, 5).map(describe).join(', ')
}

/**
 * Make one request string maskable: the rules refuse control characters,
 * U+FFFD, lone surrogates, and placeholder delimiters, which tool output
 * (terminal escapes, binary noise) and resent unrestorable placeholders carry.
 * @param text - one request string.
 * @returns the text with each such character replaced by a visible stand-in.
 */
function replaceUnscreenable(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, char => String.fromCharCode(char === '\u007f' ? 0x2421 : 0x2400 + char.charCodeAt(0)))
    .replace(/[\u0080-\u009f�]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '␦')
    .replaceAll('⟦', '⟪')
    .replaceAll('⟧', '⟫')
}

/** Characters JSON writes with a short escape (`\"`, `\\`, `\n`, …). */
const SHORT_ESCAPED = /^["\\\b\f\n\r\t]$/

/**
 * Write the `\uXXXX` and `\/` escapes of a JSON text as `JSON.stringify`
 * writes them, so masking finds a value whose characters a client's encoder
 * escaped (Go writes `&` as `\u0026`, PHP `/` as `\/`, Python `🔑` as
 * `\ud83d\udd11`): a surrogate pair or other character as itself, and a quote,
 * backslash, or control character with a short escape as that escape
 * (`\u0022` as `\"`), which the JSON-escaped spelling of a value matches. Any
 * other control character, U+FFFD, a lone surrogate, and an invalid escape
 * stay as written. The text need not parse.
 * @param text - JSON text, such as a resent tool call's `arguments`.
 * @returns the text with those escapes rewritten.
 */
function decodeJsonEscapes(text: string): string {
  return text.replace(/\\(u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/gs, (escape, code: string) => {
    if (code === '/') return '/'
    if (code.length === 1) return escape
    const char = String.fromCharCode(...code.slice(1).split('\\u').map(unit => Number.parseInt(unit, 16)))
    if (SHORT_ESCAPED.test(char)) return JSON.stringify(char).slice(1, -1)
    return /^[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffd]$/.test(char) ? escape : char
  })
}

/** What restoring one response needs. */
interface Restoring {
  registry: RedactionRegistry
  stats: Stats
  /** Tool names by Responses item id, or by Chat `choice:tool:index` or `choice:function_call` key, as the stream announces them. */
  toolNames: Map<string, string>
  /**
   * Restorer options for one tool call's arguments: only the tool's restored categories
   * are restored, and every bound placeholder is logged.
   * @param tool - the tool's name, if known.
   * @param json - whether the arguments are JSON text.
   * @param base - JSON pointer segments of the string inside parsed arguments.
   */
  toolOptions(tool: unknown, json: boolean, base?: ReadonlyArray<string | number>): StreamRestoreOptions
}

/**
 * Which placeholders the policy restores into one tool's arguments. A tool
 * whose name is unknown or not a string gets the default categories.
 * @param policy - the tool restore policy.
 * @param tool - the tool's name, if known.
 * @returns a test of one placeholder identity.
 */
function restoresInto(policy: ToolRestorePolicy, tool: unknown): (id: RedactionId) => boolean {
  const allowed = (typeof tool === 'string' ? policy.tools.get(toolKey(tool)) : undefined) ?? policy.categories
  return id => allowed === '*' || allowed.includes(categoryOf(id))
}

/**
 * Build the restoring context of one request.
 * @param registry - bindings of the request's mask call.
 * @param stats - counters.
 * @param policy - which categories are restored into tool arguments.
 * @param log - receives one line per placeholder met in tool arguments, written once per distinct line.
 * @returns the context.
 */
function restoring(registry: RedactionRegistry, stats: Stats, policy: ToolRestorePolicy, log: (line: string) => void): Restoring {
  const logged = new Set<string>()
  return {
    registry,
    stats,
    toolNames: new Map(),
    toolOptions(tool, json, base = []) {
      const name = typeof tool === 'string' && NAMEABLE_TOOL.test(tool) ? tool : '<tool>'
      return {
        json,
        restores: restoresInto(policy, tool),
        onPlaceholder: (event: PlaceholderEvent) => {
          const pointer = [...base, ...event.path].map(segment => `/${pointerSegment(segment)}`).join('')
          const line = `tool arguments: ${OUTCOME_LOG[event.outcome]} ${event.id} in ${name}${pointer === '' ? '' : ` at ${pointer}`}`
          if (logged.has(line)) return
          logged.add(line)
          log(line)
        },
      }
    },
  }
}

/**
 * Add a finished restorer's counts to the request's counters.
 * @param restorer - a restorer whose stream has ended.
 * @param stats - counters.
 */
function count(restorer: StreamRestorer, stats: Stats): void {
  stats.restored += restorer.restored
  stats.unknown += restorer.unknown
  stats.kept += restorer.kept
}

/**
 * Start a restorer for one response field. A placeholder inside a URL stays as
 * written everywhere, not only in tool arguments: a client that renders
 * `![](https://host/?q=…)` or follows a link would send the original to that host.
 * @param ctx - the request's restoring context.
 * @param options - restorer options of the field.
 * @returns the restorer.
 */
function startRestorer(ctx: Restoring, options: StreamRestoreOptions): StreamRestorer {
  return createStreamRestorer(ctx.registry, { ...options, keepInUrls: true })
}

/**
 * Restore one response string and count what happened.
 * @param text - masked string from the upstream.
 * @param ctx - the request's restoring context.
 * @param options - restorer options.
 * @returns the restored string.
 */
function restoreString(text: string, ctx: Restoring, options: StreamRestoreOptions): string {
  const restorer = startRestorer(ctx, options)
  const out = restorer.push(text) + restorer.end()
  count(restorer, ctx.stats)
  return out
}

/** Chat stream delta fields restored as reply text. */
const CHAT_TEXT = ['content', 'reasoning_content', 'refusal']

/** Keys holding a tool call's own input, whose JSON pointers are logged relative to it. */
const TOOL_INPUT = new Set(['arguments', 'input'])

/** Responses events about a tool call's input: `response.function_call_arguments.delta`, `response.custom_tool_call_input.done`, and the like. */
const TOOL_CALL_EVENT = /^response\..*_call_/

/**
 * The tool call a response object holds, with its tool's name: a Responses
 * output item whose type ends in `_call` (function, custom, shell, computer,
 * patch, MCP, and any later kind), named by its type when it has no name; a
 * Responses event about one ({@link TOOL_CALL_EVENT}); an
 * Anthropic `*tool_use` block; or a Chat custom call's `custom` object.
 * @param record - a response object.
 * @param ctx - the request's restoring context, for tool names a stream announced.
 * @returns the object every string of which is tool input, or `undefined`.
 */
function toolCallOf(record: Json, ctx: Restoring): { call: Json; tool: unknown } | undefined {
  const type = String(record.type ?? '')
  if (/_call$|tool_use$/.test(type)) return { call: record, tool: record.name ?? type }
  if (TOOL_CALL_EVENT.test(type)) return { call: record, tool: ctx.toolNames.get(record.item_id) }
  if (type === 'custom' && record.custom !== null && typeof record.custom === 'object') return { call: record.custom, tool: record.custom.name }
  return undefined
}

/**
 * Restore tool-call arguments: JSON text, plain text, or a parsed object.
 * @param value - the arguments.
 * @param ctx - the request's restoring context.
 * @param tool - the tool's name, if known.
 * @param json - whether a string value is JSON text.
 * @param base - JSON pointer segments of `value` inside parsed arguments.
 * @returns the restored arguments.
 */
function restoreToolArguments(value: unknown, ctx: Restoring, tool: unknown, json: boolean, base: Array<string | number> = []): unknown {
  if (typeof value === 'string') return restoreString(value, ctx, ctx.toolOptions(tool, json, base))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const [key, item] of Object.entries(record)) {
      record[key] = restoreToolArguments(item, ctx, tool, json, [...base, Array.isArray(value) ? Number(key) : key])
    }
  }
  return value
}

/**
 * Restore every string of a parsed response value in place.
 * @param value - parsed JSON value.
 * @param ctx - the request's restoring context.
 * @param key - the key holding `value`.
 * @returns the restored value.
 */
function restoreDeep(value: unknown, ctx: Restoring, key = ''): unknown {
  if (typeof value === 'string') return SKIP_RESTORE.has(key) ? value : restoreString(value, ctx, { json: JSON_TEXT.has(key) })
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = restoreDeep(value[i], ctx, key)
    return value
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Json
    const found = toolCallOf(record, ctx)
    if (found !== undefined) {
      restoreToolCall(found.call, ctx, found.tool)
      return value
    }
    for (const [name, item] of Object.entries(record)) {
      if (SKIP_RESTORE.has(name)) continue
      // Chat `function` calls and the legacy `function_call` carry their arguments under this key.
      record[name] = name === 'arguments'
        ? restoreToolArguments(item, ctx, record.name ?? ctx.toolNames.get(record.item_id), true)
        : restoreDeep(item, ctx, name)
    }
  }
  return value
}

/**
 * Restore every string of one tool call in place through the tool restore policy.
 * @param call - the tool call, as {@link toolCallOf} finds it.
 * @param ctx - the request's restoring context.
 * @param tool - the tool's name, if known.
 */
function restoreToolCall(call: Json, ctx: Restoring, tool: unknown): void {
  for (const [name, item] of Object.entries(call)) {
    if (!SKIP_RESTORE.has(name)) call[name] = restoreToolArguments(item, ctx, tool, JSON_TEXT.has(name), TOOL_INPUT.has(name) ? [] : [name])
  }
}

/** One parsed SSE event: its raw non-data lines and its data payload. */
interface SseEvent {
  lines: string[]
  data: string | undefined
}

/**
 * Parse one SSE event block.
 * @param block - the lines of one event, without the blank separator line.
 * @returns the non-data lines and the joined data.
 */
function parseEvent(block: string): SseEvent {
  const lines: string[] = []
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
    else lines.push(line)
  }
  return { lines, data: data.length === 0 ? undefined : data.join('\n') }
}

/**
 * Serialize one SSE event.
 * @param lines - non-data lines, such as `event: x`.
 * @param data - JSON payload.
 * @returns the event block with its blank separator line.
 */
function formatEvent(lines: readonly string[], data: unknown): string {
  return `${[...lines, `data: ${JSON.stringify(data)}`].join('\n')}\n\n`
}

/**
 * Per-stream restorers keyed by the text field they restore.
 * @param ctx - the request's restoring context.
 * @returns accessors that push a chunk into a keyed restorer and flush it.
 */
function restorers(ctx: Restoring) {
  const open = new Map<string, StreamRestorer>()
  return {
    /**
     * @param key - the text field.
     * @param chunk - its next chunk.
     * @param options - restorer options, used when this pushes the field's first chunk.
     * @returns restored text that is final.
     */
    push(key: string, chunk: string, options: StreamRestoreOptions = {}): string {
      let restorer = open.get(key)
      if (restorer === undefined) {
        restorer = startRestorer(ctx, options)
        open.set(key, restorer)
      }
      return restorer.push(chunk)
    },
    flush(key: string): string {
      const restorer = open.get(key)
      if (restorer === undefined) return ''
      open.delete(key)
      count(restorer, ctx.stats)
      return restorer.end()
    },
    flushPrefix(prefix: string): Array<[string, string]> {
      const out: Array<[string, string]> = []
      for (const key of [...open.keys()]) {
        if (key.startsWith(prefix)) out.push([key, this.flush(key)])
      }
      return out
    },
  }
}

type Json = Record<string, any>

/**
 * The objects of an upstream array; other entries, which the transformer passes through unchanged, are skipped.
 * @param value - a parsed upstream value.
 * @returns its object entries, or none when it is not an array.
 */
function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => item !== null && typeof item === 'object') : []
}

/**
 * An upstream value as an object to merge a flushed tail into.
 * @param value - a parsed upstream value.
 * @returns the value when it is a non-array object, else an empty object.
 */
function asRecord(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

/**
 * Build the SSE transformer for one API. It restores text deltas through
 * keyed stream restorers, writes any held tail as a synthetic delta just
 * before the event that closes its field, and restores every other event whole.
 * @param api - wire API of the stream.
 * @param ctx - the request's restoring context.
 * @param onResponseId - receives the id of a completed Responses response.
 * @returns `event`, mapping one parsed event to the blocks to send, and `end`,
 * the synthetic deltas of every tail still held when the stream ends without closing its field.
 */
function sseTransformer(api: Api, ctx: Restoring, onResponseId: (id: string) => void) {
  const r = restorers(ctx)
  const toolBlocks = new Set<string>()
  /** Chat restorer keys of custom tool calls, whose held tail belongs in `custom.input`. */
  const customCalls = new Set<string>()
  /** The identifying fields of the last Chat chunk, repeated on a synthetic one. */
  let chatChunk: Json = {}
  /** The last Responses delta event per restorer key, the template of a synthetic one. */
  const lastDelta = new Map<string, Json>()
  /**
   * Append a flushed Chat tail to its choice's delta.
   * @param delta - the choice's delta.
   * @param at - the choice's key prefix.
   * @param key - the restorer key.
   * @param text - the tail.
   */
  const appendChatTail = (delta: Json, at: string, key: string, text: string): void => {
    const field = key.slice(at.length)
    if (field.startsWith('tool:')) {
      const index = Number(field.slice(5))
      const [kind, input] = customCalls.has(key) ? ['custom', 'input'] : ['function', 'arguments']
      // A malformed `tool_calls` on the finishing chunk cannot carry the tail, so the tail replaces it.
      if (!Array.isArray(delta.tool_calls)) delta.tool_calls = []
      const call = records(delta.tool_calls).find(item => item.index === index)
      if (call === undefined) delta.tool_calls.push({ index, [kind]: { [input]: text } })
      else call[kind] = { ...asRecord(call[kind]), [input]: (asRecord(call[kind])[input] ?? '') + text }
    } else if (field === 'function_call') {
      delta.function_call = { ...asRecord(delta.function_call), arguments: (asRecord(delta.function_call).arguments ?? '') + text }
    } else {
      delta[field] = (delta[field] ?? '') + text
    }
  }
  /**
   * The Anthropic delta event carrying a block's tail.
   * @param at - the block index as a restorer key.
   * @param tail - the tail, possibly empty.
   * @returns the event, or `''` for an empty tail.
   */
  const messagesTail = (at: string, tail: string): string => {
    if (tail === '') return ''
    const delta = toolBlocks.has(at) ? { type: 'input_json_delta', partial_json: tail } : { type: 'text_delta', text: tail }
    return formatEvent(['event: content_block_delta'], { type: 'content_block_delta', index: Number(at), delta })
  }
  const end = (): string => {
    const tails = r.flushPrefix('').filter(([, text]) => text !== '')
    if (api === 'messages') return tails.map(([at, tail]) => messagesTail(at, tail)).join('')
    if (api === 'responses') {
      return tails.map(([key, tail]) => {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- a Responses restorer opens only on a delta event.
        const last = lastDelta.get(key)!
        return formatEvent([`event: ${last.type}`], { ...last, delta: tail })
      }).join('')
    }
    const deltas = new Map<string, Json>()
    for (const [key, text] of tails) {
      const at = key.slice(0, key.indexOf(':') + 1)
      const delta = deltas.get(at) ?? {}
      deltas.set(at, delta)
      appendChatTail(delta, at, key, text)
    }
    if (deltas.size === 0) return ''
    return formatEvent([], { ...chatChunk, choices: [...deltas].map(([at, delta]) => ({ index: Number(at.slice(0, -1)), delta })) })
  }
  const transform = (lines: string[], event: Json): string => {
    let before = ''
    if (api === 'chat') {
      chatChunk = { id: event.id, object: event.object, created: event.created, model: event.model }
      for (const choice of records(event.choices)) {
        const delta = (choice.delta ??= {}) as Json
        if (typeof delta !== 'object') continue
        const at = `${choice.index}:`
        for (const field of CHAT_TEXT) {
          if (typeof delta[field] === 'string') delta[field] = r.push(`${at}${field}`, delta[field])
        }
        // The legacy single `function_call`, keyed apart from `tool_calls` indices.
        const legacy = delta.function_call as Json | undefined
        if (typeof legacy?.name === 'string') ctx.toolNames.set(`${at}function_call`, legacy.name)
        if (typeof legacy?.arguments === 'string') legacy.arguments = r.push(`${at}function_call`, legacy.arguments, ctx.toolOptions(ctx.toolNames.get(`${at}function_call`), true))
        for (const call of records(delta.tool_calls)) {
          const key = `${at}tool:${call.index}`
          const name = call.function?.name ?? call.custom?.name
          if (typeof name === 'string') ctx.toolNames.set(key, name)
          if (typeof call.function?.arguments === 'string') call.function.arguments = r.push(key, call.function.arguments, ctx.toolOptions(ctx.toolNames.get(key), true))
          if (typeof call.custom?.input === 'string') {
            customCalls.add(key)
            call.custom.input = r.push(key, call.custom.input, ctx.toolOptions(ctx.toolNames.get(key), false))
          }
        }
        if (choice.finish_reason == null) continue
        // The finishing chunk may carry text of its own, so a held tail is appended to it, not sent ahead.
        for (const [key, text] of r.flushPrefix(at)) {
          if (text !== '') appendChatTail(delta, at, key, text)
        }
      }
      return before + formatEvent(lines, event)
    }
    if (api === 'messages') {
      const at = `${event.index}`
      const block = event.content_block as Json | undefined
      if (event.type === 'content_block_start' && block?.type === 'text') {
        block.text = r.push(at, block.text ?? '')
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_start' && /tool_use$/.test(String(block?.type))) {
        toolBlocks.add(at)
        r.push(at, '', ctx.toolOptions(block?.name, true))
        event.content_block = restoreDeep(block, ctx)
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        event.delta.text = r.push(at, event.delta.text)
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        toolBlocks.add(at)
        event.delta.partial_json = r.push(at, event.delta.partial_json, ctx.toolOptions(undefined, true))
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta') return formatEvent(lines, event)
      if (event.type === 'content_block_stop') return messagesTail(at, r.flush(at)) + formatEvent(lines, event)
      return formatEvent(lines, restoreDeep(event, ctx))
    }
    // Responses
    const type = String(event.type ?? '')
    if (type === 'response.output_item.added' && typeof event.item?.id === 'string') ctx.toolNames.set(event.item.id, event.item.name ?? event.item.type)
    const deltaKey = `${event.item_id}:${event.content_index ?? event.summary_index ?? ''}:${type.replace(/\.(delta|done)$/, '')}`
    const tool = TOOL_CALL_EVENT.test(type)
    const json = tool && type.includes('_arguments.')
    if (type.endsWith('.delta') && typeof event.delta === 'string') {
      event.delta = r.push(deltaKey, event.delta, tool ? ctx.toolOptions(ctx.toolNames.get(event.item_id), json) : {})
      lastDelta.set(deltaKey, event)
      return formatEvent(lines, event)
    }
    if (type.endsWith('.done')) {
      lastDelta.delete(deltaKey)
      const tail = r.flush(deltaKey)
      if (tail !== '') before = formatEvent([`event: ${type.replace(/\.done$/, '.delta')}`], { ...event, type: type.replace(/\.done$/, '.delta'), delta: tail, text: undefined, arguments: undefined, input: undefined })
    }
    if (type === 'response.completed' && typeof event.response?.id === 'string') onResponseId(event.response.id)
    return before + formatEvent(lines, restoreDeep(event, ctx))
  }
  return { event: transform, end }
}

/**
 * Create the proxy server. The caller listens on it; see {@link listen}.
 * @param config - validated configuration.
 * @param log - receives one line per request; never an original value or a header.
 * @param nameModel - the loaded name model when `config.nameModel` is set; the caller releases it.
 * @returns the HTTP server.
 */
export function createProxyServer(
  config: ProxyConfig,
  log: (line: string) => void = line => console.error(line),
  nameModel?: NameModel,
): Server {
  const rules = new RulesDetector(config.redaction)
  const withModel = nameModel === undefined ? undefined : new NameModelDetector(rules, nameModel)
  const detectorFor = (userTexts: ReadonlySet<string>, stats: Stats): RedactionDetector =>
    withModel?.forRequest(userTexts, () => { stats.nameModelFailed = true }) ?? rules
  /** Continuation texts by client scope and response id. */
  const continuations = new Map<string, RequestTexts>()
  /**
   * Originals each client scope bound, by bucket, each mapped to its category and expiry time, oldest first.
   * One bucket per category, so a bulk tool result of emails cannot evict a remembered credential,
   * and per category one more for values bound in text the client wrote (its user messages and
   * system prompt), so a tool result full of cookies cannot evict the password the user typed.
   */
  const knownOriginals = new Map<string, Map<string, Map<string, KnownOriginal>>>()
  const tokenDigest = config.authToken === undefined ? undefined : createHash('sha256').update(config.authToken).digest()
  const originAllowed = (origin: string): boolean => config.allowedOrigins.includes(origin.toLowerCase()) || isLoopbackOrigin(origin)

  /**
   * Remember every {@link isRememberable} original a request detected, for the client's later requests.
   * A value only memory supplied keeps its time to live, which runs from its last detection; bound in
   * text the client wrote, it also moves into the client's bucket, so tool output cannot evict it.
   * A credential written in another ASCII case keeps the remembered spelling's time to live.
   * @param client - the client scope.
   * @param registry - bindings of the request's mask call.
   * @param clientBound - the identities bound in text the client wrote ({@link isClientText}).
   * @param detected - the originals the request's detector found.
   */
  const rememberOriginals = (client: string, registry: RedactionRegistry, clientBound: ReadonlySet<RedactionId>, detected: ReadonlySet<string>): void => {
    const known = knownOriginals.get(client) ?? new Map<string, Map<string, KnownOriginal>>()
    const expires = Date.now() + config.knownOriginalsTtlSeconds * 1000
    let keys: Map<string, number> | undefined
    const kept = (original: string, category: string): number => {
      if (category !== 'KEY') return Math.max(0, ...[category, `client ${category}`].map(name => known.get(name)?.get(original)?.expires ?? 0))
      if (keys === undefined) {
        keys = new Map()
        for (const [spelling, { expires: until }] of [...known.get('KEY') ?? [], ...known.get('client KEY') ?? []]) {
          const folded = foldAsciiCase(spelling)
          keys.set(folded, Math.max(keys.get(folded) ?? 0, until))
        }
      }
      return keys.get(foldAsciiCase(original)) ?? 0
    }
    for (const id of registry.ids()) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- every listed identity is bound.
      const original = registry.original(id)!
      if (!isRememberable(original)) continue
      const category = categoryOf(id)
      const fromClient = clientBound.has(id)
      const until = detected.has(original) ? expires : fromClient ? kept(original, category) : 0
      if (until === 0) continue
      const name = fromClient ? `client ${category}` : category
      const bucket = known.get(name) ?? new Map<string, KnownOriginal>()
      known.set(name, bucket)
      setNewest(bucket, original, { category, expires: until }, KNOWN_ORIGINALS_MAX)
    }
    setNewest(knownOriginals, client, known, KNOWN_CLIENTS_MAX)
  }

  /**
   * The originals one client's earlier requests bound, forgetting those past their time to live.
   * @param client - the client scope.
   * @returns each original mapped to its category, or `undefined` for a client not seen.
   */
  const knownTo = (client: string): Map<string, string> | undefined => {
    const known = knownOriginals.get(client)
    if (known === undefined) return undefined
    const now = Date.now()
    const originals = new Map<string, string>()
    for (const bucket of known.values()) {
      for (const [original, { category, expires }] of bucket) {
        if (expires <= now) bucket.delete(original)
        else originals.set(original, category)
      }
    }
    return originals
  }

  /**
   * Mask every text of one request body, a continuation's stored texts first.
   * @param body - the raw request body.
   * @param stats - counters; receives masked counts and a tolerated model failure.
   * @param client - the client scope, for continuations and known originals.
   * @returns the masked body and what its response needs.
   * @throws {Refusal} on a body that is not JSON, an unscreenable text, an unknown continuation, a required model's failure, or, unless `sendWhenMaskFails` is set, a mask conflict or a leak.
   */
  const maskBody = async (body: Buffer | undefined, stats: Stats, client: string): Promise<MaskedRequest> => {
    let parsed: Json
    try {
      parsed = JSON.parse(body?.toString('utf8') ?? '') as Json
    } catch {
      throw new Refusal(400, 'request body is not JSON')
    }
    const slots: Slot[] = []
    collectSlots(parsed, '', slots)
    const texts = slots.map(slot => {
      const written = (slot.parent as Record<string | number, string>)[slot.key] as string
      const text = typeof slot.key === 'string' && JSON_TEXT.has(slot.key) ? decodeJsonEscapes(written) : written
      if (config.screen === 'replace') return replaceUnscreenable(text)
      const refusal = screenText(text) ?? (text.includes('⟦') || text.includes('⟧') ? { reason: 'placeholder delimiter' } : undefined)
      if (refusal !== undefined) throw new Refusal(422, `request text at ${slot.path} holds a ${refusal.reason} and cannot be masked (screen: "refuse")`)
      return text
    })
    const prior = typeof parsed.previous_response_id === 'string' ? continuations.get(`${client}:${parsed.previous_response_id}`) : undefined
    // Without the earlier texts, this request's numbering would bind the upstream's old placeholders to other values.
    if (typeof parsed.previous_response_id === 'string' && prior === undefined) {
      throw new Refusal(422, 'previous_response_id is unknown to this proxy for this credential (restarted, evicted, never seen, or another client\'s); start a new conversation or resend the full history')
    }
    const priorTexts = prior?.texts ?? []
    const all = [...priorTexts, ...texts]
    const userTexts = new Set([...prior?.userTexts ?? [], ...texts.filter((_, i) => isRoleText(parsed, (slots[i] as Slot).path, USER_ROLE))])
    const clientTexts = new Set([...userTexts, ...texts.filter((_, i) => isClientText(parsed, (slots[i] as Slot).path))])
    const known = knownTo(client)
    const escaped = new Map<string, string>()
    const detected = new Set<string>()
    let result
    try {
      result = await mask(withKnownOriginals(detectorFor(userTexts, stats), known, escaped, detected), all.map((text, seq) => ({ seq, path: '', text })), emptyRedactionIndex())
    } catch (error) {
      if (error instanceof NameModelError) throw new Refusal(503, 'the name model failed and nameModel.required is set')
      if (!(error instanceof RedactionError)) throw error
      // Screening above leaves only a conflict a continuation's stored texts can raise.
      if (!config.sendWhenMaskFails) throw new Refusal(422, `request text cannot be masked: ${error.code}`)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the body parsed as JSON above.
      return { outgoing: body!.toString('utf8'), registry: EMPTY_REGISTRY, texts: all, userTexts, maskFailed: `request text cannot be masked: ${error.code}; the original body was sent` }
    }
    result.masked.slice(priorTexts.length).forEach((masked, i) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- one masked string per slot.
      const slot = slots[i]!
      ;(slot.parent as Record<string | number, string>)[slot.key] = masked
    })
    // A spelling only memory supplied (as written, JSON-escaped, or a credential in another case) is masked but never refused.
    const rememberedKeys = new Set([...known ?? []].filter(([, category]) => category === 'KEY').map(([original]) => foldAsciiCase(original)))
    const onlyRemembered = (original: string): boolean => {
      const plain = escaped.get(original) ?? original
      return !detected.has(plain) && (known?.has(plain) === true || rememberedKeys.has(foldAsciiCase(plain)))
    }
    // A value repeated where another detection splits it binds each uncovered part on its own (`pw-` of `pw-0912345678`, a phone number inside); such a part is never refused.
    // A remembered credential's part is found in any ASCII case, as the credential itself is.
    const values = [...detected, ...known?.keys() ?? [], ...escaped.keys()]
    const folded = new Map<string, string>()
    const within = (text: string, part: string, start: number, value: string): boolean => {
      if (value.length <= part.length) return false
      for (let at = value.indexOf(part); at >= 0 && at <= start; at = value.indexOf(part, at + 1)) {
        if (text.startsWith(value, start - at)) return true
      }
      return false
    }
    const isPart = (text: string, start: number, end: number): boolean => {
      const part = text.slice(start, end)
      if (detected.has(part)) return false
      if (values.some(value => within(text, part, start, value))) return true
      if (rememberedKeys.size === 0) return false
      let lower = folded.get(text)
      if (lower === undefined) folded.set(text, lower = foldAsciiCase(text))
      const lowerPart = foldAsciiCase(part)
      for (const value of rememberedKeys) if (within(lower, lowerPart, start, value)) return true
      return false
    }
    const modelValues = new Set<string>()
    const bound = new Map<string, string>()
    const clientBound = new Set<RedactionId>()
    for (const span of result.applied) {
      const category = categoryOf(span.id)
      const text = all[span.seq] as string
      const original = text.slice(span.start, span.end)
      if (clientTexts.has(text)) clientBound.add(span.id)
      if (span.seq >= priorTexts.length) stats.masked[category] = (stats.masked[category] ?? 0) + 1
      if (onlyRemembered(original) || isPart(text, span.start, span.end)) continue
      bound.set(original, category)
      if (MODEL_CATEGORIES.has(category)) modelValues.add(original)
    }
    const leaks = findLeaks(parsed, bound, modelValues)
    if (leaks !== undefined && !config.sendWhenMaskFails) throw new Refusal(422, `a detected value is still unmasked at ${leaks}; the request was not forwarded`)
    const registry = unescaping(result.registry, escaped)
    rememberOriginals(client, registry, clientBound, detected)
    const masked: MaskedRequest = { outgoing: JSON.stringify(parsed), registry, texts: all, userTexts }
    if (leaks !== undefined) masked.maskFailed = `a detected value is still unmasked at ${leaks}`
    return masked
  }

  const forward = async (req: IncomingMessage, res: ServerResponse, path: string, api: Api | undefined, body: Buffer | undefined, cors: Record<string, string>): Promise<void> => {
    const started = Date.now()
    const stats: Stats = { masked: {}, restored: 0, unknown: 0, kept: 0, nameModelFailed: false }
    const anthropic = api === 'messages' || (api === undefined && (req.headers['x-api-key'] !== undefined || req.headers['anthropic-version'] !== undefined))
    const target = (anthropic ? config.anthropicUpstream : config.openaiUpstream) + (req.url ?? '/')

    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP.has(name) && name !== TOKEN_HEADER && value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    if (anthropic && config.anthropicApiKey !== undefined && headers['x-api-key'] === undefined && headers.authorization === undefined) headers['x-api-key'] = config.anthropicApiKey
    if (!anthropic && config.openaiApiKey !== undefined && headers.authorization === undefined) headers.authorization = `Bearer ${config.openaiApiKey}`
    const client = clientScope(headers)

    const masked = api === undefined ? undefined : await maskBody(body, stats, client).catch((error: unknown) => {
      // The body's recursive walks overflow the call stack on nesting that deep.
      throw error instanceof RangeError ? new Refusal(400, 'request body is nested too deeply to mask; it was not forwarded') : error
    })
    const outgoing = masked?.outgoing
    const maskFailed = masked?.maskFailed
    // A body sent although masking failed holds originals, which the log never receives.
    if (outgoing !== undefined && config.debugMasked && maskFailed === undefined) log(`masked ${path}: ${outgoing}`)
    if (maskFailed !== undefined) log(`${req.method} ${path} warning: masking failed and the request was sent anyway (sendWhenMaskFails): ${maskFailed}`)

    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const upstream = await fetch(target, {
      method: req.method ?? 'GET',
      headers,
      // Only masked routes carry a body; everything else relayed is a GET.
      ...(outgoing === undefined ? {} : { body: outgoing }),
      // Following a redirect would send the client's credential to the host the upstream names, over any scheme.
      redirect: 'manual',
      signal: abort.signal,
    })
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
      await upstream.body?.cancel()
      throw new Refusal(502, `the upstream answered ${upstream.status} with a redirect; the proxy does not follow redirects`)
    }
    // The proxy, not the upstream, decides which browser origins may read the reply.
    const out: Record<string, string> = { ...cors }
    upstream.headers.forEach((value, name) => {
      if (!HOP.has(name) && !name.startsWith('access-control-')) out[name] = value
    })
    if (maskFailed !== undefined) out[MASK_FAILED_HEADER] = '1'
    const remember = (id: string): void => {
      if (masked === undefined) return
      setNewest(continuations, `${client}:${id}`, { texts: masked.texts, userTexts: masked.userTexts }, CONTINUATIONS_MAX)
    }
    const done = (): void => {
      const counts = Object.entries(stats.masked).map(([category, n]) => `${category} ${n}`).join(', ')
      log(`${req.method} ${path} -> ${upstream.status} masked ${Object.values(stats.masked).reduce((a, b) => a + b, 0)}${counts === '' ? '' : ` (${counts})`} restored ${stats.restored}${stats.kept === 0 ? '' : ` kept ${stats.kept}`} unknown ${stats.unknown}${stats.nameModelFailed ? ' nameModel failed' : ''} ${Date.now() - started}ms`)
    }

    const registry = masked?.registry
    if (registry === undefined || upstream.body === null) {
      res.writeHead(upstream.status, out)
      res.end(Buffer.from(await upstream.arrayBuffer()))
      done()
      return
    }
    const ctx = restoring(registry, stats, config.toolRestore, line => log(`${req.method} ${path} ${line}`))
    if (!(upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const text = await upstream.text()
      let payload = text
      try {
        const parsed = restoreDeep(JSON.parse(text), ctx) as Json
        if (api === 'responses' && typeof parsed.id === 'string' && upstream.ok) remember(parsed.id)
        payload = JSON.stringify(parsed)
      } catch {
        // Not JSON (an HTML error page, say): relayed unchanged; it can hold no placeholder the client could act on.
      }
      res.writeHead(upstream.status, out)
      res.end(payload)
      done()
      return
    }

    res.writeHead(upstream.status, out)
    const transform = sseTransformer(api!, ctx, remember)
    const decoder = new TextDecoder()
    let buffer = ''
    const drain = (final: boolean): void => {
      // A last event without its blank line is still restored.
      if (final && buffer.trim() !== '') buffer += '\n\n'
      buffer = buffer.replace(/\r\n|\r(?=.)/gs, '\n')
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const { lines, data } = parseEvent(block)
        let parsed: unknown
        try {
          parsed = data === undefined || data === '[DONE]' ? undefined : JSON.parse(data)
        } catch {
          parsed = undefined
        }
        // A stream that ends without closing a field still gets its held tail, before `[DONE]` if one comes.
        if (parsed !== null && typeof parsed === 'object') res.write(transform.event(lines, parsed as Json))
        else res.write(`${data === '[DONE]' ? transform.end() : ''}${block}\n\n`)
        cut = buffer.indexOf('\n\n')
      }
    }
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      drain(false)
    }
    buffer += decoder.decode()
    drain(true)
    res.write(transform.end())
    res.end()
    done()
  }

  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const api = ROUTES[path]
    const origin = req.headers.origin
    const cors: Record<string, string> = origin === undefined ? {} : { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'x-redaction-proxy-mask-failed', vary: 'origin' }
    const fail = (status: number, message: string, headers: Record<string, string> = {}): void => {
      log(`${req.method} ${path} -> ${status} refused: ${message}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers })
      res.end(JSON.stringify({ error: { type: 'redaction_proxy_error', message } }))
    }
    const refuse = (status: number, message: string): void => {
      fail(status, message)
      req.resume()
    }
    if (origin !== undefined && !originAllowed(origin)) {
      delete cors['access-control-allow-origin']
      return refuse(403, 'browser requests are served only from loopback http(s) origins and allowedOrigins')
    }
    // A preflight carries no custom header, so it cannot carry the token; it forwards nothing.
    if (req.method === 'OPTIONS' && origin !== undefined && req.headers['access-control-request-method'] !== undefined) {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '',
        'access-control-max-age': '600',
      })
      res.end()
      return
    }
    if (tokenDigest !== undefined) {
      const presented = req.headers[TOKEN_HEADER]
      if (typeof presented !== 'string' || !timingSafeEqual(createHash('sha256').update(presented).digest(), tokenDigest)) {
        return refuse(401, `missing or wrong ${TOKEN_HEADER} header`)
      }
    } else if (!hostIsLoopback(req.headers.host)) {
      // Without a token, a non-loopback Host is a DNS-rebinding page; a token holder may use any name.
      return refuse(403, 'the proxy only serves requests addressed to a loopback host unless authToken is set')
    }
    if (req.method === 'POST' ? api === undefined : req.method !== 'GET') {
      return refuse(404, `the proxy does not forward ${req.method} ${path}; only masked routes and GET are relayed`)
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      if (size > BODY_MAX_BYTES) return
      size += chunk.length
      if (size <= BODY_MAX_BYTES) return void chunks.push(chunk)
      chunks.length = 0
      fail(413, `request body exceeds ${BODY_MAX_BYTES} bytes; it was not forwarded`, { connection: 'close' })
      res.once('finish', () => req.destroy())
    })
    req.on('end', () => {
      if (size > BODY_MAX_BYTES) return
      forward(req, res, path, api, Buffer.concat(chunks), cors).catch((error: unknown) => {
        if (error instanceof Refusal) fail(error.status, error.message)
        else if (abortedByClient(error)) {
          log(`${req.method} ${path}${res.headersSent ? ` -> ${res.statusCode}` : ''} aborted by the client`)
          res.destroy()
        } else fail(502, `upstream request failed: ${error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.name : 'error'}`)
      })
    })
  })
}

/**
 * Whether a `Host` header names a loopback host. A web page can reach
 * 127.0.0.1 through DNS rebinding, but its `Host` then carries the rebound name.
 * @param host - the `Host` header.
 * @returns whether it is loopback; a missing or malformed header is not.
 */
function hostIsLoopback(host: string | undefined): boolean {
  try {
    return isLoopbackHost(new URL(`http://${host ?? ''}`).hostname)
  } catch {
    // A malformed Host is refused like a foreign one.
    return false
  }
}

/**
 * Whether an `Origin` is a loopback `http(s)` page. Clients that are not
 * browsers send no `Origin`; a web page always sends its own.
 * @param origin - the `Origin` header.
 * @returns whether it is loopback http(s); `null` and custom schemes are not.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname)
  } catch {
    // `null` and other unparsable origins are refused.
    return false
  }
}

/**
 * Whether an error is the abort the proxy raised when its client went away.
 * @param error - caught value.
 * @returns whether it is an `AbortError`.
 */
function abortedByClient(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Listen on `host`, 127.0.0.1 unless the caller names another address.
 * `loadConfig` refuses an address that is not loopback without `authToken`.
 * @param server - the proxy server.
 * @param port - TCP port; 0 picks a free one.
 * @param host - address to bind.
 * @returns the bound port.
 */
export function listen(server: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}

/**
 * Stop the proxy: stop accepting connections, end open ones, and release the
 * name model once its running inferences finish. Exiting with the session
 * still open aborted with `recursive_mutex lock failed` in 2 of 29 measured
 * edge-int8 runs; releasing it first aborted in none of 24.
 * @param server - the proxy server.
 * @param nameModel - the name model passed to {@link createProxyServer}, if any.
 */
export async function closeProxy(server: Server, nameModel?: NameModel): Promise<void> {
  const closed = new Promise<void>(resolve => server.close(() => resolve()))
  server.closeAllConnections()
  await Promise.all([closed, nameModel?.release()])
}
