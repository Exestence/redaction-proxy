/**
 * The redaction proxy: an HTTP server on 127.0.0.1 that masks the text of
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

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { RedactionError, RulesDetector, createStreamRestorer, emptyRedactionIndex, mask, screenText } from '../core/index.ts'
import type { RedactionRegistry, StreamRestorer } from '../core/index.ts'
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

/** Headers that describe one hop or the body encoding, never forwarded. */
const HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'content-length', 'content-encoding', 'accept-encoding',
])

// ponytail: fixed-size FIFO of continuation texts; a restart forgets them (documented).
const CONTINUATIONS_MAX = 256

/** One maskable string inside a request body. */
interface Slot {
  /** Object or array holding the string. */
  parent: Record<string, unknown> | unknown[]
  /** Key or index of the string in `parent`. */
  key: string | number
  /** JSON pointer of the string, for diagnostics that never carry text. */
  path: string
}

/** Per-request counters for the log line. */
interface Stats {
  masked: Record<string, number>
  restored: number
  unknown: number
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
    const at = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
    if (typeof item === 'string') out.push({ parent: record, key, path: at })
    else collectSlots(item, at, out)
  }
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

/**
 * Restore one response string and count what happened.
 * @param text - masked string from the upstream.
 * @param registry - bindings of the request's mask call.
 * @param json - whether the string is JSON text.
 * @param stats - counters.
 * @returns the restored string.
 */
function restoreString(text: string, registry: RedactionRegistry, json: boolean, stats: Stats): string {
  const restorer = createStreamRestorer(registry, { json })
  const out = restorer.push(text) + restorer.end()
  stats.restored += restorer.restored
  stats.unknown += restorer.unknown
  return out
}

/**
 * Restore every string of a parsed response value in place.
 * @param value - parsed JSON value.
 * @param registry - bindings of the request's mask call.
 * @param stats - counters.
 * @param key - the key holding `value`.
 * @returns the restored value.
 */
function restoreDeep(value: unknown, registry: RedactionRegistry, stats: Stats, key = ''): unknown {
  if (typeof value === 'string') return SKIP_RESTORE.has(key) ? value : restoreString(value, registry, JSON_TEXT.has(key), stats)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = restoreDeep(value[i], registry, stats, key)
    return value
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const [name, item] of Object.entries(record)) {
      if (!SKIP_RESTORE.has(name)) record[name] = restoreDeep(item, registry, stats, name)
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
 * @param registry - bindings of the request's mask call.
 * @param stats - counters.
 * @returns accessors that push a chunk into a keyed restorer and flush it.
 */
function restorers(registry: RedactionRegistry, stats: Stats) {
  const open = new Map<string, StreamRestorer>()
  const get = (key: string, json: boolean): StreamRestorer => {
    let restorer = open.get(key)
    if (restorer === undefined) {
      restorer = createStreamRestorer(registry, { json })
      open.set(key, restorer)
    }
    return restorer
  }
  return {
    push(key: string, chunk: string, json = false): string {
      return get(key, json).push(chunk)
    },
    flush(key: string): string {
      const restorer = open.get(key)
      if (restorer === undefined) return ''
      open.delete(key)
      stats.restored += restorer.restored
      stats.unknown += restorer.unknown
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
 * @param registry - bindings of the request's mask call.
 * @param stats - counters.
 * @param onResponseId - receives the id of a completed Responses response.
 * @returns a function mapping one parsed event to the blocks to send.
 */
function sseTransformer(api: Api, registry: RedactionRegistry, stats: Stats, onResponseId: (id: string) => void) {
  const r = restorers(registry, stats)
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
          if (typeof call.function?.arguments === 'string') call.function.arguments = r.push(`${at}tool:${call.index}`, call.function.arguments, true)
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
      if (event.type === 'content_block_start' && (event.content_block?.type === 'text' || event.content_block?.type === 'tool_use')) {
        const block = event.content_block as Json
        if (block.type === 'text') {
          block.text = r.push(at, block.text ?? '')
        } else {
          toolBlocks.add(at)
          r.push(at, '', true)
          block.input = restoreDeep(block.input, registry, stats)
        }
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        event.delta.text = r.push(at, event.delta.text)
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        event.delta.partial_json = r.push(at, event.delta.partial_json, true)
        return formatEvent(lines, event)
      }
      if (event.type === 'content_block_delta') return formatEvent(lines, event)
      if (event.type === 'content_block_stop') {
        const tail = r.flush(at)
        const delta = toolBlocks.has(at) ? { type: 'input_json_delta', partial_json: tail } : { type: 'text_delta', text: tail }
        if (tail !== '') before = formatEvent(['event: content_block_delta'], { type: 'content_block_delta', index: event.index, delta })
        return before + formatEvent(lines, event)
      }
      return formatEvent(lines, restoreDeep(event, registry, stats))
    }
    // Responses
    const type = String(event.type ?? '')
    const deltaKey = `${event.item_id}:${event.content_index ?? event.summary_index ?? ''}:${type.replace(/\.(delta|done)$/, '')}`
    const json = type.startsWith('response.function_call_arguments.')
    if (type.endsWith('.delta') && typeof event.delta === 'string') {
      event.delta = r.push(deltaKey, event.delta, json)
      return formatEvent(lines, event)
    }
    if (type.endsWith('.done')) {
      const tail = r.flush(deltaKey)
      if (tail !== '') before = formatEvent([`event: ${type.replace(/\.done$/, '.delta')}`], { ...event, type: type.replace(/\.done$/, '.delta'), delta: tail, text: undefined, arguments: undefined })
    }
    if (type === 'response.completed' && typeof event.response?.id === 'string') onResponseId(event.response.id)
    return before + formatEvent(lines, restoreDeep(event, registry, stats))
  }
}

/**
 * Create the proxy server. The caller listens on it; see {@link listen}.
 * @param config - validated configuration.
 * @param log - receives one line per request; never an original value or a header.
 * @returns the HTTP server.
 */
export function createProxyServer(config: ProxyConfig, log: (line: string) => void = line => console.error(line)): Server {
  const detector = new RulesDetector(config.redaction)
  const continuations = new Map<string, string[]>()

  const forward = async (req: IncomingMessage, res: ServerResponse, path: string, api: Api | undefined, body: Buffer | undefined): Promise<void> => {
    const started = Date.now()
    const stats: Stats = { masked: {}, restored: 0, unknown: 0 }
    const anthropic = api === 'messages' || (api === undefined && (req.headers['x-api-key'] !== undefined || req.headers['anthropic-version'] !== undefined))
    const target = (anthropic ? config.anthropicUpstream : config.openaiUpstream) + (req.url ?? '/')

    let outgoing: string | undefined
    let registry: RedactionRegistry | undefined
    let texts: string[] = []
    if (api !== undefined) {
      let parsed: Json
      try {
        parsed = JSON.parse(body?.toString('utf8') ?? '') as Json
      } catch {
        throw new Refusal(400, 'request body is not JSON')
      }
      const slots: Slot[] = []
      collectSlots(parsed, '', slots)
      texts = slots.map(slot => {
        const text = (slot.parent as Record<string | number, string>)[slot.key] as string
        if (config.screen === 'replace') return replaceUnscreenable(text)
        const refusal = screenText(text) ?? (text.includes('⟦') || text.includes('⟧') ? { reason: 'placeholder delimiter' } : undefined)
        if (refusal !== undefined) throw new Refusal(422, `request text at ${slot.path} holds a ${refusal.reason} and cannot be masked (screen: "refuse")`)
        return text
      })
      const prior = typeof parsed.previous_response_id === 'string' ? continuations.get(parsed.previous_response_id) ?? [] : []
      const all = [...prior, ...texts]
      let result
      try {
        result = await mask(detector, all.map((text, seq) => ({ seq, path: '', text })), emptyRedactionIndex())
      } catch (error) {
        // Screening above leaves only a conflict a continuation's stored texts can raise.
        if (error instanceof RedactionError) throw new Refusal(422, `request text cannot be masked: ${error.code}`)
        throw error
      }
      result.masked.slice(prior.length).forEach((masked, i) => {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- one masked string per slot.
        const slot = slots[i]!
        ;(slot.parent as Record<string | number, string>)[slot.key] = masked
      })
      for (const span of result.applied) {
        if (span.seq < prior.length) continue
        const category = span.id.slice(0, span.id.lastIndexOf('_'))
        stats.masked[category] = (stats.masked[category] ?? 0) + 1
      }
      registry = result.registry
      texts = all
      outgoing = JSON.stringify(parsed)
      const leaked = registry.originals().filter(original =>
        outgoing!.includes(original) || outgoing!.includes(JSON.stringify(original).slice(1, -1)))
      if (leaked.length > 0) {
        const where = new Set<string>()
        const walk = (value: unknown, path: string): void => {
          if (typeof value === 'string') {
            if (leaked.some(original => value.includes(original))) where.add(path)
          } else if (value !== null && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) walk(item, `${path}/${key}`)
          }
        }
        walk(parsed, '')
        throw new Refusal(422, `masked request still contains ${leaked.length} detected value(s) in fields the proxy does not rewrite: ${[...where].slice(0, 5).join(', ')}`)
      }
      if (config.debugMasked) log(`masked ${path}: ${outgoing}`)
    }

    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP.has(name) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
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
    const out: Record<string, string> = {}
    upstream.headers.forEach((value, name) => {
      if (!HOP.has(name)) out[name] = value
    })
    const remember = (id: string): void => {
      continuations.set(id, texts)
      if (continuations.size > CONTINUATIONS_MAX) continuations.delete(continuations.keys().next().value as string)
    }
    const done = (): void => {
      const masked = Object.entries(stats.masked).map(([category, n]) => `${category} ${n}`).join(', ')
      log(`${req.method} ${path} -> ${upstream.status} masked ${Object.values(stats.masked).reduce((a, b) => a + b, 0)}${masked === '' ? '' : ` (${masked})`} restored ${stats.restored} unknown ${stats.unknown} ${Date.now() - started}ms`)
    }

    if (registry === undefined || upstream.body === null) {
      res.writeHead(upstream.status, out)
      res.end(Buffer.from(await upstream.arrayBuffer()))
      done()
      return
    }
    if (!(upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const text = await upstream.text()
      let payload = text
      try {
        const parsed = restoreDeep(JSON.parse(text), registry, stats) as Json
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
    const transform = sseTransformer(api!, registry, stats, remember)
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
    const fail = (status: number, message: string): void => {
      log(`${req.method} ${path} -> ${status} refused: ${message}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'redaction_proxy_error', message } }))
    }
    if (req.method === 'POST' ? api === undefined : req.method !== 'GET') {
      fail(404, `the proxy does not forward ${req.method} ${path}; only masked routes and GET are relayed`)
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      forward(req, res, path, api, Buffer.concat(chunks)).catch((error: unknown) => {
        if (error instanceof Refusal) fail(error.status, error.message)
        else if (abortedByClient(error)) res.destroy()
        else fail(502, `upstream request failed: ${error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.name : 'error'}`)
      })
    })
  })
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
 * Listen on 127.0.0.1 only; the proxy holds no authentication of its own.
 * @param server - the proxy server.
 * @param port - TCP port; 0 picks a free one.
 * @returns the bound port.
 */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}
