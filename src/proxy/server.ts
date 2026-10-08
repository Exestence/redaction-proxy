/**
 * The redaction proxy: an HTTP server, on 127.0.0.1 by default, that masks the text of
 * OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages requests,
 * forwards them to the configured upstream with the client's own credentials,
 * and restores placeholders in the JSON or SSE response.
 *
 * Placeholder numbering is re-derived from the whole request on every call.
 * Clients resend the full history, and allocation follows text order, so an
 * append-only conversation keeps its identities across turns without any
 * server-side state. Responses requests that continue with
 * `previous_response_id` do not resend history; for them the original input
 * texts of each response are kept in memory, keyed by response id.
 *
 * @module redaction-proxy/proxy/server
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { RedactionError, RulesDetector, createStreamRestorer, emptyRedactionIndex, mask, screenText } from '../core/index.ts'
import type { PlaceholderEvent, RedactionDetector, RedactionRegistry, StreamRestoreOptions, StreamRestorer } from '../core/index.ts'
import { NameModelDetector, NameModelError, containsStandingAlone, isSearchedValue } from '../core/model/detector.ts'
import type { NameModel } from '../core/model/name-model.ts'
import { NAME_MODEL_CATEGORIES } from '../core/model/config.ts'
import { isLoopbackHost } from './config.ts'
import type { ProxyConfig } from './config.ts'

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
 * model state that must be resent byte for byte.
 */
const SKIP_MASK = new Set([
  'model', 'role', 'type', 'id', 'call_id', 'tool_call_id', 'tool_use_id', 'name', 'previous_response_id',
  'signature', 'thinking', 'data', 'encrypted_content', 'media_type', 'url', 'image_url', 'file_id', 'file_data',
  'metadata', 'cache_control', 'format', 'status', 'service_tier', 'reasoning_effort', 'tool_choice', 'stop',
])

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

/** Categories the name model binds; the leak scan matches their values as whole words. */
const MODEL_CATEGORIES: ReadonlySet<string> = new Set(NAME_MODEL_CATEGORIES)

/** Headers that describe one hop or the body encoding, never forwarded. */
const HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'content-length', 'content-encoding', 'accept-encoding',
])

// ponytail: fixed-size FIFO of continuation texts; a restart forgets them (documented).
const CONTINUATIONS_MAX = 256

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
  /** Placeholders left as written inside a URL in tool-call arguments. */
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
}

/** A request the proxy refuses before anything is forwarded. */
class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Collect every maskable string of a request body in a stable order.
 * @param value - parsed JSON value.
 * @param path - JSON pointer of `value`.
 * @param out - slot sink.
 */
function collectSlots(value: unknown, path: string, out: Slot[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') out.push({ parent: value, key: index, path: `${path}/${index}` })
      else collectSlots(item, `${path}/${index}`, out)
    })
    return
  }
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const ordered = path === '' ? [...HEAD_FIRST.filter(key => key in record), ...keys.filter(key => !HEAD_FIRST.includes(key))] : keys
  for (const key of ordered) {
    if (SKIP_MASK.has(key)) continue
    const item = record[key]
    const at = `${path}/${pointerSegment(key)}`
    if (typeof item === 'string') out.push({ parent: record, key, path: at })
    else collectSlots(item, at, out)
  }
}

/**
 * Whether a request string is text the user wrote: a user message's string
 * content or one of its text parts, or a Responses string `input`. Tool
 * results, system prompts, and assistant turns are not.
 * @param body - the parsed request body.
 * @param path - JSON pointer of the string.
 * @returns whether the name model reads it.
 */
function isUserText(body: Json, path: string): boolean {
  if (path === '/input') return true
  const match = MESSAGE_TEXT_PATH.exec(path)
  if (match === null) return false
  const [, list, message, part] = match
  const item = (body[list as string] as Json[] | undefined)?.[Number(message)]
  if (item?.role !== 'user') return false
  return part === undefined || USER_TEXT_PARTS.has((item.content as Json[])[Number(part)]?.type)
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
 * Refuse a masked body that still holds a detected value: in a field the
 * proxy does not rewrite (metadata, an image URL), or an occurrence masking
 * could not cover. A name-model value is matched as its propagation matches
 * it, as a whole word for spaced scripts (`Lee` inside `Leeds` is no leak),
 * and only from two code points. Every other value counts anywhere, at any
 * length and in any ASCII case, so a rules value glued to other characters
 * (`tel0912345678`) or upper-cased still fails closed. Keys are checked too.
 * @param body - the masked request body.
 * @param registry - bindings of the mask call.
 * @param modelValues - the originals the name model bound.
 * @throws {Refusal} 422 naming the JSON pointers, never the value.
 */
function refuseLeaks(body: Json, registry: RedactionRegistry, modelValues: ReadonlySet<string>): void {
  // A value inside a JSON-text string (`arguments`) is written JSON-escaped.
  const forms = (original: string): string[] => [original, JSON.stringify(original).slice(1, -1)]
  const words = [...modelValues].filter(isSearchedValue).flatMap(forms)
  const holdsSubstring = containsAnyOf(registry.originals().filter(original => !modelValues.has(original)).flatMap(forms))
  const leaks = (text: string): boolean => holdsSubstring(text) || words.some(form => containsStandingAlone(text, form))
  const where: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string' && leaks(value)) where.push(path)
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const leakyKey = leaks(key)
        const at = `${path}/${leakyKey ? '<key>' : pointerSegment(Array.isArray(value) ? Number(key) : key)}`
        if (leakyKey) where.push(at)
        walk(item, at)
      }
    }
  }
  walk(body, '')
  if (where.length > 0) throw new Refusal(422, `a detected value is still unmasked at ${where.slice(0, 5).join(', ')}; the request was not forwarded`)
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

/** What restoring one response needs. */
interface Restoring {
  registry: RedactionRegistry
  stats: Stats
  /** Tool names by Responses item id, or by Chat `choice:tool:index` key, as the stream announces them. */
  toolNames: Map<string, string>
  /**
   * Restorer options for one tool call's arguments: placeholders inside a URL
   * are kept, and every bound placeholder is logged.
   * @param tool - the tool's name, if known.
   * @param json - whether the arguments are JSON text.
   * @param base - JSON pointer segments of the string inside parsed arguments.
   */
  toolOptions(tool: unknown, json: boolean, base?: ReadonlyArray<string | number>): StreamRestoreOptions
}

/**
 * Build the restoring context of one request.
 * @param registry - bindings of the request's mask call.
 * @param stats - counters.
 * @param log - receives one line per placeholder met in tool arguments, written once per distinct line.
 * @returns the context.
 */
function restoring(registry: RedactionRegistry, stats: Stats, log: (line: string) => void): Restoring {
  const logged = new Set<string>()
  return {
    registry,
    stats,
    toolNames: new Map(),
    toolOptions(tool, json, base = []) {
      const name = typeof tool === 'string' && NAMEABLE_TOOL.test(tool) ? tool : '<tool>'
      return {
        json,
        keepInUrls: true,
        onPlaceholder: (event: PlaceholderEvent) => {
          const pointer = [...base, ...event.path].map(segment => `/${pointerSegment(segment)}`).join('')
          const line = `tool arguments: ${event.restored ? 'restored' : 'kept inside a URL'} ${event.id} in ${name}${pointer === '' ? '' : ` at ${pointer}`}`
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
 * Restore one response string and count what happened.
 * @param text - masked string from the upstream.
 * @param ctx - the request's restoring context.
 * @param options - restorer options.
 * @returns the restored string.
 */
function restoreString(text: string, ctx: Restoring, options: StreamRestoreOptions): string {
  const restorer = createStreamRestorer(ctx.registry, options)
  const out = restorer.push(text) + restorer.end()
  count(restorer, ctx.stats)
  return out
}

/**
 * Whether `record[key]` holds tool-call arguments: `arguments` (Chat, Responses,
 * and their events), or the `input` of an Anthropic `*tool_use` block or a
 * Responses custom tool call.
 * @param record - a response object.
 * @param key - one of its keys.
 * @returns whether the value is tool-call arguments.
 */
function holdsToolArguments(record: Json, key: string): boolean {
  return key === 'arguments' || (key === 'input' && /tool_use$|custom_tool_call/.test(String(record.type ?? '')))
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
    for (const [name, item] of Object.entries(record)) {
      if (SKIP_RESTORE.has(name)) continue
      record[name] = holdsToolArguments(record, name)
        ? restoreToolArguments(item, ctx, record.name ?? ctx.toolNames.get(record.item_id), JSON_TEXT.has(name))
        : restoreDeep(item, ctx, name)
    }
  }
  return value
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
        restorer = createStreamRestorer(ctx.registry, options)
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
 * Build the SSE transformer for one API. It restores text deltas through
 * keyed stream restorers, writes any held tail as a synthetic delta just
 * before the event that closes its field, and restores every other event whole.
 * @param api - wire API of the stream.
 * @param ctx - the request's restoring context.
 * @param onResponseId - receives the id of a completed Responses response.
 * @returns a function mapping one parsed event to the blocks to send.
 */
function sseTransformer(api: Api, ctx: Restoring, onResponseId: (id: string) => void) {
  const r = restorers(ctx)
  const toolBlocks = new Set<string>()
  return (lines: string[], event: Json): string => {
    let before = ''
    if (api === 'chat') {
      for (const choice of (event.choices ?? []) as Json[]) {
        const delta = (choice.delta ??= {}) as Json
        const at = `${choice.index}:`
        if (typeof delta.content === 'string') delta.content = r.push(`${at}content`, delta.content)
        if (typeof delta.reasoning_content === 'string') delta.reasoning_content = r.push(`${at}reasoning`, delta.reasoning_content)
        for (const call of (delta.tool_calls ?? []) as Json[]) {
          const key = `${at}tool:${call.index}`
          if (typeof call.function?.name === 'string') ctx.toolNames.set(key, call.function.name)
          if (typeof call.function?.arguments === 'string') call.function.arguments = r.push(key, call.function.arguments, ctx.toolOptions(ctx.toolNames.get(key), true))
        }
        if (choice.finish_reason == null) continue
        // The finishing chunk may carry text of its own, so a held tail is appended to it, not sent ahead.
        for (const [key, text] of r.flushPrefix(at)) {
          if (text === '') continue
          const field = key.slice(at.length)
          if (field.startsWith('tool:')) {
            const index = Number(field.slice(5))
            const calls = (delta.tool_calls ??= []) as Json[]
            const call = calls.find(item => item.index === index)
            if (call === undefined) calls.push({ index, function: { arguments: text } })
            else call.function = { ...call.function, arguments: (call.function?.arguments ?? '') + text }
          } else {
            const name = field === 'content' ? 'content' : 'reasoning_content'
            delta[name] = (delta[name] ?? '') + text
          }
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
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        event.delta.text = r.push(at, event.delta.text)
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        event.delta.partial_json = r.push(at, event.delta.partial_json, { json: true })
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta') return formatEvent(lines, event)
      if (event.type === 'content_block_stop') {
        const tail = r.flush(at)
        const delta = toolBlocks.has(at) ? { type: 'input_json_delta', partial_json: tail } : { type: 'text_delta', text: tail }
        if (tail !== '') before = formatEvent(['event: content_block_delta'], { type: 'content_block_delta', index: event.index, delta })
        return before + formatEvent(lines, event)
      }
      return formatEvent(lines, restoreDeep(event, ctx))
    }
    // Responses
    const type = String(event.type ?? '')
    if (type === 'response.output_item.added' && typeof event.item?.id === 'string' && typeof event.item.name === 'string') ctx.toolNames.set(event.item.id, event.item.name)
    const deltaKey = `${event.item_id}:${event.content_index ?? event.summary_index ?? ''}:${type.replace(/\.(delta|done)$/, '')}`
    const json = type.startsWith('response.function_call_arguments.')
    const tool = json || type.startsWith('response.custom_tool_call_input.')
    if (type.endsWith('.delta') && typeof event.delta === 'string') {
      event.delta = r.push(deltaKey, event.delta, tool ? ctx.toolOptions(ctx.toolNames.get(event.item_id), json) : {})
      return formatEvent(lines, event)
    }
    if (type.endsWith('.done')) {
      const tail = r.flush(deltaKey)
      if (tail !== '') before = formatEvent([`event: ${type.replace(/\.done$/, '.delta')}`], { ...event, type: type.replace(/\.done$/, '.delta'), delta: tail, text: undefined, arguments: undefined, input: undefined })
    }
    if (type === 'response.completed' && typeof event.response?.id === 'string') onResponseId(event.response.id)
    return before + formatEvent(lines, restoreDeep(event, ctx))
  }
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
  const continuations = new Map<string, RequestTexts>()
  const tokenDigest = config.authToken === undefined ? undefined : createHash('sha256').update(config.authToken).digest()
  const originAllowed = (origin: string): boolean => config.allowedOrigins.includes(origin.toLowerCase()) || isLoopbackOrigin(origin)

  /**
   * Mask every text of one request body, a continuation's stored texts first.
   * @param body - the raw request body.
   * @param stats - counters; receives masked counts and a tolerated model failure.
   * @returns the masked body and what its response needs.
   * @throws {Refusal} on a body that is not JSON, an unscreenable text, a mask conflict, a required model's failure, or a leak.
   */
  const maskBody = async (body: Buffer | undefined, stats: Stats): Promise<MaskedRequest> => {
    let parsed: Json
    try {
      parsed = JSON.parse(body?.toString('utf8') ?? '') as Json
    } catch {
      throw new Refusal(400, 'request body is not JSON')
    }
    const slots: Slot[] = []
    collectSlots(parsed, '', slots)
    const texts = slots.map(slot => {
      const text = (slot.parent as Record<string | number, string>)[slot.key] as string
      if (config.screen === 'replace') return replaceUnscreenable(text)
      const refusal = screenText(text) ?? (text.includes('⟦') || text.includes('⟧') ? { reason: 'placeholder delimiter' } : undefined)
      if (refusal !== undefined) throw new Refusal(422, `request text at ${slot.path} holds a ${refusal.reason} and cannot be masked (screen: "refuse")`)
      return text
    })
    const prior = typeof parsed.previous_response_id === 'string' ? continuations.get(parsed.previous_response_id) : undefined
    // Without the earlier texts, this request's numbering would bind the upstream's old placeholders to other values.
    if (typeof parsed.previous_response_id === 'string' && prior === undefined) {
      throw new Refusal(422, 'previous_response_id is unknown to this proxy (restarted, evicted, or never seen); start a new conversation or resend the full history')
    }
    const priorTexts = prior?.texts ?? []
    const all = [...priorTexts, ...texts]
    const userTexts = new Set([...prior?.userTexts ?? [], ...texts.filter((_, i) => isUserText(parsed, (slots[i] as Slot).path))])
    let result
    try {
      result = await mask(detectorFor(userTexts, stats), all.map((text, seq) => ({ seq, path: '', text })), emptyRedactionIndex())
    } catch (error) {
      // Screening above leaves only a conflict a continuation's stored texts can raise.
      if (error instanceof RedactionError) throw new Refusal(422, `request text cannot be masked: ${error.code}`)
      if (error instanceof NameModelError) throw new Refusal(503, 'the name model failed and nameModel.required is set')
      throw error
    }
    result.masked.slice(priorTexts.length).forEach((masked, i) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- one masked string per slot.
      const slot = slots[i]!
      ;(slot.parent as Record<string | number, string>)[slot.key] = masked
    })
    const modelValues = new Set<string>()
    for (const span of result.applied) {
      const category = span.id.slice(0, span.id.lastIndexOf('_'))
      if (MODEL_CATEGORIES.has(category)) modelValues.add((all[span.seq] as string).slice(span.start, span.end))
      if (span.seq >= priorTexts.length) stats.masked[category] = (stats.masked[category] ?? 0) + 1
    }
    refuseLeaks(parsed, result.registry, modelValues)
    return { outgoing: JSON.stringify(parsed), registry: result.registry, texts: all, userTexts }
  }

  const forward = async (req: IncomingMessage, res: ServerResponse, path: string, api: Api | undefined, body: Buffer | undefined, cors: Record<string, string>): Promise<void> => {
    const started = Date.now()
    const stats: Stats = { masked: {}, restored: 0, unknown: 0, kept: 0, nameModelFailed: false }
    const anthropic = api === 'messages' || (api === undefined && (req.headers['x-api-key'] !== undefined || req.headers['anthropic-version'] !== undefined))
    const target = (anthropic ? config.anthropicUpstream : config.openaiUpstream) + (req.url ?? '/')

    const masked = api === undefined ? undefined : await maskBody(body, stats)
    const outgoing = masked?.outgoing
    if (outgoing !== undefined && config.debugMasked) log(`masked ${path}: ${outgoing}`)

    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP.has(name) && name !== TOKEN_HEADER && value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    if (anthropic && config.anthropicApiKey !== undefined && headers['x-api-key'] === undefined && headers.authorization === undefined) headers['x-api-key'] = config.anthropicApiKey
    if (!anthropic && config.openaiApiKey !== undefined && headers.authorization === undefined) headers.authorization = `Bearer ${config.openaiApiKey}`

    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const upstream = await fetch(target, {
      method: req.method ?? 'GET',
      headers,
      // Only masked routes carry a body; everything else relayed is a GET.
      ...(outgoing === undefined ? {} : { body: outgoing }),
      signal: abort.signal,
    })
    // The proxy, not the upstream, decides which browser origins may read the reply.
    const out: Record<string, string> = { ...cors }
    upstream.headers.forEach((value, name) => {
      if (!HOP.has(name) && !name.startsWith('access-control-')) out[name] = value
    })
    const remember = (id: string): void => {
      if (masked === undefined) return
      continuations.set(id, { texts: masked.texts, userTexts: masked.userTexts })
      if (continuations.size > CONTINUATIONS_MAX) continuations.delete(continuations.keys().next().value as string)
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
    const ctx = restoring(registry, stats, line => log(`${req.method} ${path} ${line}`))
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
        res.write(parsed !== null && typeof parsed === 'object' ? transform(lines, parsed as Json) : `${block}\n\n`)
        cut = buffer.indexOf('\n\n')
      }
      if (final && buffer.trim() !== '') res.write(`${buffer}\n\n`)
    }
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      drain(false)
    }
    buffer += decoder.decode()
    drain(true)
    res.end()
    done()
  }

  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const api = ROUTES[path]
    const origin = req.headers.origin
    const cors: Record<string, string> = origin === undefined ? {} : { 'access-control-allow-origin': origin, vary: 'origin' }
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
        else if (abortedByClient(error)) res.destroy()
        else fail(502, `upstream request failed: ${error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.name : 'error'}`)
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
