// The real-service harness against a fake upstream that speaks all three wire
// APIs and echoes the placeholders it received, in 3-character stream chunks.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProvider } from '../e2e/real/harness.ts'
import { PROVIDERS } from '../e2e/real/providers.ts'
import { extractReplyText } from '../e2e/real/replies.ts'
import type { Scenario } from '../e2e/real/requests.ts'
import { findLeakedOriginals, verifyRestoration } from '../e2e/real/verify.ts'
import { listen } from '../src/proxy/server.ts'

const CHUNK_SIZE = 3
const FAKE_KEY = 'fake-key-for-tests-0001'

type Json = Record<string, unknown>
type Shape = Pick<Scenario, 'stream' | 'toolCall'>

let upstream: Server
let upstreamUrl = ''
let rejectWithKey = false

function pieces(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += CHUNK_SIZE) out.push(text.slice(i, i + CHUNK_SIZE))
  return out
}

function dataEvents(events: Json[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

function namedEvents(events: Json[]): string {
  return events.map(event => `event: ${String(event.type)}\n${dataEvents([event])}`).join('')
}

function chatReply(text: string, { stream, toolCall: tool }: Shape): string {
  const call = (args: string): Json => ({ index: 0, id: 'call_1', type: 'function', function: { name: 'record_contact', arguments: args } })
  if (!stream) return JSON.stringify({ choices: [{ index: 0, message: tool ? { content: null, tool_calls: [call(text)] } : { content: text }, finish_reason: 'stop' }] })
  const deltas = pieces(text).map(piece => ({ choices: [{ index: 0, delta: tool ? { tool_calls: [call(piece)] } : { content: piece }, finish_reason: null }] }))
  return `${dataEvents([...deltas, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])}data: [DONE]\n\n`
}

function responsesReply(text: string, { stream, toolCall: tool }: Shape): string {
  const item = tool ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'record_contact', arguments: text } : { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text }] }
  if (!stream) return JSON.stringify({ id: 'resp_1', output: [item] })
  const kind = tool ? 'response.function_call_arguments' : 'response.output_text'
  const deltas = pieces(text).map(delta => ({ type: `${kind}.delta`, item_id: item.id, output_index: 0, content_index: 0, delta }))
  const done = { type: `${kind}.done`, item_id: item.id, output_index: 0, content_index: 0, ...(tool ? { arguments: text } : { text }) }
  return namedEvents([...deltas, done, { type: 'response.completed', response: { id: 'resp_1', output: [item] } }])
}

function messagesReply(text: string, { stream, toolCall: tool }: Shape): string {
  const block = tool ? { type: 'tool_use', id: 'toolu_1', name: 'record_contact', input: JSON.parse(text) as Json } : { type: 'text', text }
  if (!stream) return JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [block] })
  const start = tool ? { ...block, input: {} } : { type: 'text', text: '' }
  const deltas = pieces(text).map(piece => ({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: piece } : { type: 'text_delta', text: piece } }))
  return namedEvents([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: start },
    ...deltas,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ])
}

const REPLIES: Record<string, (text: string, shape: Shape) => string> = {
  '/v1/chat/completions': chatReply,
  '/v1/responses': responsesReply,
  '/v1/messages': messagesReply,
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part: string) => { raw += part })
    req.on('end', () => {
      if (rejectWithKey) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `invalid key ${String(req.headers.authorization ?? req.headers['x-api-key'])}` }))
        return
      }
      const body = JSON.parse(raw) as Json
      const ids = [...new Set(raw.match(/⟦[A-Z0-9_]+⟧/g) ?? [])]
      const shape = { stream: body.stream === true, toolCall: body.tools !== undefined }
      const text = shape.toolCall ? JSON.stringify({ line: ids.join(' ') }) : `Sure: ${ids.join(' and ')}.`
      res.writeHead(200, { 'content-type': shape.stream ? 'text/event-stream' : 'application/json' })
      res.end(REPLIES[req.url ?? '']?.(text, shape))
    })
  })
  upstreamUrl = `http://127.0.0.1:${await listen(upstream, 0)}`
})

afterAll(() => {
  upstream.close()
})

function fakeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(PROVIDERS.flatMap(provider => [[provider.keyVariable, FAKE_KEY], [provider.baseUrlVariable, upstreamUrl]]))
}

describe('real-service harness against a fake upstream', () => {
  it.each(PROVIDERS.map(provider => [provider.name, provider] as const))('passes every %s scenario', async (_name, provider) => {
    const results = await runProvider(provider, fakeEnv())
    expect(results.length).toBe(provider.apis.length * 4)
    for (const result of results) expect(result, `${result.scenario}: ${result.detail}`).toMatchObject({ status: 'pass' })
  })

  it('skips a provider without a key', async () => {
    expect(await runProvider(PROVIDERS[0]!, {})).toEqual([])
  })

  it('never reports the key an upstream error quotes', async () => {
    rejectWithKey = true
    try {
      const results = await runProvider(PROVIDERS[0]!, fakeEnv())
      for (const result of results) {
        expect(result.status).toBe('error')
        expect(result.detail).not.toContain(FAKE_KEY)
      }
    } finally {
      rejectWithKey = false
    }
  })
})

describe('verification', () => {
  const originals = ['a@example.com', 'A123456789']

  it('passes a reply whose placeholders became originals', () => {
    expect(verifyRestoration('to ⟦EMAIL_1⟧ and ⟦EMAIL_1⟧', 'to a@example.com and a@example.com', originals))
      .toEqual({ status: 'pass', placeholders: 2 })
  })

  it('fails a reply that kept a placeholder', () => {
    expect(verifyRestoration('to ⟦EMAIL_1⟧', 'to ⟦EMAIL_1⟧', originals).status).toBe('fail')
  })

  it('fails a reply that changed outside the placeholders', () => {
    expect(verifyRestoration('to ⟦EMAIL_1⟧.', 'to a@example.com!', originals).status).toBe('fail')
  })

  it('fails one placeholder restored to two different values', () => {
    expect(verifyRestoration('⟦X_1⟧ ⟦X_1⟧', 'a@example.com A123456789', originals).status).toBe('fail')
  })

  it('is inconclusive when the model echoed no placeholder', () => {
    expect(verifyRestoration('no', 'no', originals).status).toBe('inconclusive')
  })

  it('finds originals sent verbatim or JSON-escaped', () => {
    expect(findLeakedOriginals('{"x":"A123456789"}', originals)).toEqual(['A123456789'])
    expect(findLeakedOriginals(JSON.stringify({ x: 'C:\\Users\\lin' }), ['C:\\Users\\lin'])).toEqual(['C:\\Users\\lin'])
  })

  it('reads message text and tool arguments from JSON and event streams', () => {
    expect(extractReplyText('chat', chatReply('hello', { stream: true, toolCall: false }))).toBe('hello')
    expect(extractReplyText('responses', responsesReply('{"line":"x"}', { stream: false, toolCall: true }))).toBe('{"line":"x"}')
    expect(extractReplyText('messages', messagesReply('{"line":"x"}', { stream: true, toolCall: true }))).toBe('{"line":"x"}')
  })
})
