// Adversarial review of the anchored pass rule: an id anchors only when its first
// occurrence in the request is model-written tool input. Every value is synthetic.
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_RESTORE_CATEGORIES, loadConfig } from '../src/proxy/config.ts'
import type { ProxyConfig } from '../src/proxy/config.ts'
import { createProxyServer, listen } from '../src/proxy/server.ts'

const A = 'first.fictional@example.test'
const B = 'second.fictional@example.test'

interface Seen { url: string; headers: IncomingHttpHeaders; raw: string; body: any }
type Reply = (seen: Seen) => { json?: unknown; sse?: string; status?: number }

let upstream: Server
let proxy: Server
let base = ''
let seen: Seen[] = []
let reply: Reply = () => ({ json: {} })
const logs: string[] = []

async function start(overrides: Partial<ProxyConfig> = {}): Promise<void> {
  if (proxy !== undefined) await new Promise(resolve => proxy.close(resolve))
  const port = (upstream.address() as { port: number }).port
  const config = {
    ...loadConfig(undefined, {
      REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${port}`,
      REDACTION_PROXY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${port}/anthropic`,
    }),
    toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() },
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
        res.end(answer.sse)
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

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

let credential = 0
const fresh = (): Record<string, string> => ({ authorization: `Bearer r3-client-${credential += 1}` })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

/**
 * The model reads a file holding a placeholder written for A in an earlier
 * conversation, then writes that placeholder (re-bracketed) into a tool call.
 * The resent tool call anchors it; memory knows the number only for B.
 */
async function staleLiteralViaModelToolCall(headers: Record<string, string>): Promise<{ toolArgs: string; upstreamSaw: string[]; replyText: string }> {
  reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call('c1', 'bash', { command: 'cat contacts.txt' })] } }] } })
  await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
  // The model's next turn copies the file's placeholder into a tool call, with the standard brackets.
  reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call('c2', 'send_mail', { to: '⟦EMAIL_1⟧', body: 'hi' })] } }] } })
  const r3 = await (await post('/v1/chat/completions', { model: 'm', messages: [
    { role: 'user', content: `cc ${B}` },
    { role: 'assistant', content: null, tool_calls: [call('c1', 'bash', { command: 'cat contacts.txt' })] },
    { role: 'tool', tool_call_id: 'c1', content: 'contact: ⟦EMAIL_1⟧' },
  ] }, headers)).json() as any
  const toolArgs = r3.choices[0].message.tool_calls[0].function.arguments as string
  reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'Sent to ⟦EMAIL_1⟧, the contact listed in the file.' } }] } })
  const r4 = await (await post('/v1/chat/completions', { model: 'm', messages: [
    { role: 'user', content: `cc ${B}` },
    { role: 'assistant', content: null, tool_calls: [call('c1', 'bash', { command: 'cat contacts.txt' })] },
    { role: 'tool', tool_call_id: 'c1', content: 'contact: ⟦EMAIL_1⟧' },
    { role: 'assistant', content: null, tool_calls: [{ ...call('c2', 'send_mail', {}), function: { name: 'send_mail', arguments: toolArgs } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'sent' },
  ] }, headers)).json() as any
  const last = seen[seen.length - 1]!.body
  const upstreamSaw = [last.messages[0].content, last.messages[2].content, last.messages[3].tool_calls[0].function.arguments]
  return { toolArgs, upstreamSaw, replyText: r4.choices[0].message.content }
}

describe('a stale on-disk placeholder the model copies into a tool call', () => {
  it('after a proxy restart: escaped, so the reply never restores to the new holder of its number', async () => {
    const headers = fresh()
    // Conversation 1: A is EMAIL_1; the model wrote the placeholder to a file (EMAIL is not restored into tool arguments).
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'contacts.txt', content: 'contact: ⟦EMAIL_1⟧' })] } }] } })
    const r1 = await (await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)).json() as any
    expect(r1.choices[0].message.tool_calls[0].function.arguments).toContain('⟦EMAIL_1⟧')
    await start()
    const { toolArgs, upstreamSaw, replyText } = await staleLiteralViaModelToolCall(headers)
    // The client got the re-bracketed placeholder back as written (unknown in that request).
    expect(toolArgs).toContain('⟦EMAIL_1⟧')
    // A placeholder read back from a file is escaped, so the copy in the later tool call does not anchor it.
    expect(upstreamSaw[1]).toBe('contact: ⟪EMAIL_1⟫')
    expect(replyText).not.toContain(B)
  })

  it('after the old value expired: same outcome', async () => {
    await start({ knownOriginalsTtlSeconds: 1 })
    try {
      const headers = fresh()
      reply = () => ({ json: { choices: [] } })
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
      await sleep(1200)
      const { upstreamSaw, replyText } = await staleLiteralViaModelToolCall(headers)
      expect(upstreamSaw[1]).toBe('contact: ⟪EMAIL_1⟫')
      expect(replyText).not.toContain(B)
    } finally {
      await start()
    }
  })

  it('while A is still remembered under EMAIL_1: blocked (two values)', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    const { upstreamSaw, replyText } = await staleLiteralViaModelToolCall(headers)
    expect(upstreamSaw[1]).toBe('contact: ⟪EMAIL_1⟫')
    expect(replyText).not.toContain(B)
  })
})

describe('a Responses mcp_call item resent with its output', () => {
  it('does not anchor a placeholder in the server-side tool output', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await start()
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
    reply = () => ({ json: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'the contact is ⟦EMAIL_1⟧' }] }] } })
    const r = await (await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `cc ${B}` }] },
      { type: 'mcp_call', id: 'mcp_1', name: 'lookup', server_label: 'crm', arguments: '{}', output: 'contact: ⟦EMAIL_1⟧' },
    ] }, headers)).json() as any
    expect(seen[1]!.body.input[1].output).toBe('contact: ⟪EMAIL_1⟫')
    expect(r.output[0].content[0].text).not.toContain(B)
  })

  it('still anchors a model-written tool_use input field named output', async () => {
    const headers = { 'x-api-key': fresh().authorization! }
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'user', content: `cc ${B}` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'save', input: { output: '⟦EMAIL_1⟧' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'saved ⟦EMAIL_1⟧' }] },
    ] }, headers)
    expect(seen[1]!.body.messages[2].content[0].content).toBe('saved ⟦EMAIL_1⟧')
  })
})

describe('two continuations of one Responses reply', () => {
  it('do not share the ids the other branch kept', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' }) }] } })
    await post('/v1/responses', { model: 'm', input: `mail ${A}, also ${B}` }, headers)
    // Branch a: kept EMAIL_1 passes; its reply keeps EMAIL_2.
    reply = () => ({ json: { id: 'r2a', output: [{ type: 'function_call', call_id: 'd', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦EMAIL_2⟧' }) }] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦EMAIL_1⟧ ok' }] }, headers)
    expect(seen[1]!.body.input[0].output).toBe('⟦EMAIL_1⟧ ok')
    // Branch b, from r1 too: EMAIL_2 was never kept on this branch, so it is not anchored.
    reply = () => ({ json: { id: 'r2b', output: [{ type: 'message', content: [{ type: 'output_text', text: 'got ⟦EMAIL_1⟧ and ⟦EMAIL_2⟧' }] }] } })
    const r2b = await (await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦EMAIL_1⟧ and ⟦EMAIL_2⟧' }] }, headers)).json() as any
    expect(seen[2]!.body.input[0].output).toBe('⟦EMAIL_1⟧ and ⟪EMAIL_2⟫')
    expect(r2b.output[0].content[0].text).toBe(`got ${A} and ⟦EMAIL_2⟧`)
  })
})

describe('a kept placeholder split across streamed Responses argument deltas', () => {
  it('is recorded as kept, so the next continuation passes it', async () => {
    const headers = fresh()
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    reply = () => ({ sse:
      event('response.output_item.added', { item_id: 'fc1', item: { id: 'fc1', type: 'function_call', call_id: 'c', name: 'bash' } }) +
      event('response.function_call_arguments.delta', { item_id: 'fc1', delta: '{"command":"echo ⟦EMA' }) +
      event('response.function_call_arguments.delta', { item_id: 'fc1', delta: 'IL_1⟧"}' }) +
      event('response.function_call_arguments.done', { item_id: 'fc1', arguments: '{"command":"echo ⟦EMAIL_1⟧"}' }) +
      event('response.completed', { response: { id: 'r1', output: [{ id: 'fc1', type: 'function_call', call_id: 'c', name: 'bash', arguments: '{"command":"echo ⟦EMAIL_1⟧"}' }] } }) +
      'data: [DONE]\n\n' })
    const r1 = await (await post('/v1/responses', { model: 'm', stream: true, input: `mail ${A}` }, headers)).text()
    expect(r1).toContain('⟦EMA')
    expect(r1).not.toContain(A)
    reply = () => ({ json: { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done ⟦EMAIL_1⟧' }] }] } })
    const r2 = await (await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦EMAIL_1⟧ ok' }] }, headers)).json() as any
    expect(seen[1]!.body.input[0].output).toBe('⟦EMAIL_1⟧ ok')
    expect(r2.output[0].content[0].text).toBe(`done ${A}`)
  })
})

describe('the cost of one anchored id repeated many times whose value is absent', () => {
  it('6000 occurrences of ⟦EMAIL_1⟧ in a tool call beside a 1 MB text', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    const literals = Array.from({ length: 6000 }, () => '⟦EMAIL_1⟧').join(' ')
    const big = 'x'.repeat(1024 * 1024)
    const started = performance.now()
    const res = await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: big },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'bash', { command: literals })] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ] }, headers)
    const took = performance.now() - started
    expect(res.status).toBe(200)
    expect(took).toBeLessThan(5000)
  }, 120_000)
})
