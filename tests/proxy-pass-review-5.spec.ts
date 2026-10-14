// Review round 5 of the anchored pass rule: assistant text de-anchors outside the call's own turn, server-written sources, Chat custom calls. Every value is synthetic.
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
const fresh = (): Record<string, string> => ({ authorization: `Bearer r5-client-${credential += 1}` })
const anth = (): Record<string, string> => ({ 'x-api-key': `r5-anth-${credential += 1}` })
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

// Memory binds EMAIL_1 to B (another conversation of the same client). The request under test
// carries a stale ⟦EMAIL_1⟧ written for A, which is absent; B is present.
describe('a stale placeholder in a client-inserted assistant turn (a summary), copied by a later tool call', () => {
  it('Anthropic: de-anchors, so it is escaped and the reply does not restore it to B', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
    reply = () => ({ json: { content: [{ type: 'text', text: 'Sent to ⟦EMAIL_1⟧.' }] } })
    const r = await (await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Summary of the earlier session: the customer contact is ⟦EMAIL_1⟧.' }] },
      { role: 'user', content: `cc ${B} and mail the customer` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
    ] }, headers)).json() as any
    const body = seen[1]!.body
    expect(body.messages[0].content[0].text).toBe('Summary of the earlier session: the customer contact is ⟪EMAIL_1⟫.')
    expect(body.messages[2].content[0].input.to).toBe('⟪EMAIL_1⟫')
    expect(r.content[0].text).not.toContain(B)
  })

  it('Chat: an assistant-role summary message de-anchors the tool call that copies it', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'Sent to ⟦EMAIL_1⟧.' } }] } })
    const r = await (await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'assistant', content: 'Summary of the earlier session: the customer contact is ⟦EMAIL_1⟧.' },
      { role: 'user', content: `cc ${B} and mail the customer` },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'send_mail', { to: '⟦EMAIL_1⟧' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ] }, headers)).json() as any
    expect(seen[1]!.body.messages[0].content).toBe('Summary of the earlier session: the customer contact is ⟪EMAIL_1⟫.')
    expect(seen[1]!.body.messages[2].tool_calls[0].function.arguments).toContain('⟪EMAIL_1⟫')
    expect(r.choices[0].message.content).not.toContain(B)
  })

  it('control: the same summary as a user message is escaped and the reply does not restore to B', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'Sent to ⟦EMAIL_1⟧.' } }] } })
    const r = await (await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: 'Summary of the earlier session: the customer contact is ⟦EMAIL_1⟧.' },
      { role: 'user', content: `cc ${B} and mail the customer` },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'send_mail', { to: '⟦EMAIL_1⟧' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ] }, headers)).json() as any
    expect(seen[1]!.body.messages[0].content).toBe('Summary of the earlier session: the customer contact is ⟪EMAIL_1⟫.')
    expect(r.choices[0].message.content).not.toContain(B)
  })
})

describe('Responses web_search_call.action.sources is server-written and never anchors', () => {
  it('a stale ⟦EMAIL_1⟧ in a search-result URL is escaped and the reply does not restore it to B', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `cc ${B}` }, headers)
    reply = () => ({ json: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'the contact is ⟦EMAIL_1⟧' }] }] } })
    const r = await (await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `cc ${B}` }] },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'customer contact', sources: [{ type: 'url', url: 'https://notes.example/contact-⟦EMAIL_1⟧' }] } },
    ] }, headers)).json() as any
    expect(seen[1]!.body.input[1].action.sources[0].url).toBe('https://notes.example/contact-⟪EMAIL_1⟫')
    expect(r.output[0].content[0].text).not.toContain(B)
  })
})

describe('model-written *_call keys whose content came from a tool result', () => {
  it('local_shell_call.action echoing a file read earlier: the output de-anchors', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `cc ${B}` }, headers)
    await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `cc ${B}` }] },
      { type: 'local_shell_call', id: 'ls_1', call_id: 'c1', status: 'completed', action: { type: 'exec', command: ['cat', 'notes.txt'] } },
      { type: 'local_shell_call_output', id: 'lso_1', call_id: 'c1', output: 'contact: ⟦EMAIL_1⟧' },
      { type: 'local_shell_call', id: 'ls_2', call_id: 'c2', status: 'completed', action: { type: 'exec', command: ['sh', '-c', 'echo ⟦EMAIL_1⟧ > out.txt'] } },
      { type: 'local_shell_call_output', id: 'lso_2', call_id: 'c2', output: '' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.input[2].output).toBe('contact: ⟪EMAIL_1⟫')
    expect(body.input[3].action.command[2]).toBe('echo ⟪EMAIL_1⟫ > out.txt')
  })

  it('apply_patch_call.operation with context lines from a dropped read: passes (documented residual)', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `cc ${B}` }, headers)
    await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `cc ${B}` }] },
      { type: 'apply_patch_call', id: 'ap_1', call_id: 'c1', status: 'completed', operation: { type: 'update_file', path: 'notes.txt', diff: '@@\n contact: ⟦EMAIL_1⟧\n+added\n' } },
      { type: 'apply_patch_call_output', id: 'apo_1', call_id: 'c1', status: 'completed', output: 'ok' },
    ] }, headers)
    expect(seen[1]!.body.input[1].operation.diff).toContain('⟦EMAIL_1⟧')
  })
})

describe('Chat legacy function_call and custom tool calls anchor', () => {
  it('legacy function_call.arguments anchors', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: null, function_call: { name: 'send_mail', arguments: JSON.stringify({ to: '⟦EMAIL_1⟧' }) } },
      { role: 'function', name: 'send_mail', content: 'sent' },
    ] }, headers)
    expect(seen[1]!.body.messages[1].function_call.arguments).toContain('⟦EMAIL_1⟧')
  })

  it('tool_calls[].type custom: custom.input is kept on the reply and passes as written when resent', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'custom', custom: { name: 'send_mail', input: 'to ⟦EMAIL_1⟧' } }] } }] } })
    const r = await (await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)).json() as any
    const kept = r.choices[0].message.tool_calls[0].custom.input as string
    expect(kept).toBe('to ⟦EMAIL_1⟧')
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'custom', custom: { name: 'send_mail', input: kept } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.messages[1].tool_calls[0].custom.input).toBe('to ⟦EMAIL_1⟧')
    expect(body.messages[0].content).toBe('mail ⟦EMAIL_1⟧')
  })
})

describe('odd message lists never 500', () => {
  const odd = [
    { model: 'm', messages: [{ role: 'assistant', content: { 0: { text: '⟦EMAIL_1⟧' } } }, { role: 'user', content: `mail ${A}` }] },
    { model: 'm', messages: [{ role: 'assistant', content: ['⟦EMAIL_1⟧', { type: 'text', text: '⟦EMAIL_1⟧' }] }, { role: 'user', content: `mail ${A}` }] },
    { model: 'm', messages: [{ role: 'assistant', reasoning_content: ['⟦EMAIL_1⟧'] }, { role: 'user', content: `mail ${A}` }] },
    { model: 'm', messages: [{ role: 'assistant', content: [{ text: '⟦EMAIL_1⟧' }], summary: [{ text: '⟦EMAIL_1⟧' }] }, { role: 'user', content: `mail ${A}` }] },
    { model: 'm', messages: { 0: { role: 'assistant', content: '⟦EMAIL_1⟧' } } },
    { model: 'm', messages: [null, 'x', 5, { role: 'assistant', content: '⟦EMAIL_1⟧' }] },
    { model: 'm', input: [{ type: 'reasoning', summary: '⟦EMAIL_1⟧', content: '⟦EMAIL_1⟧' }, { type: 'reasoning', summary: [{ type: 'summary_text', text: '⟦EMAIL_1⟧' }], content: [{ type: 'reasoning_text', text: '⟦EMAIL_1⟧' }] }] },
    { model: 'm', input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '⟦EMAIL_1⟧' }, 'x', { type: 'refusal', refusal: '⟦EMAIL_1⟧' }] }] },
    { model: 'm', messages: [{ role: ['assistant'], content: [{ type: ['text'], text: '⟦EMAIL_1⟧' }] }] },
    { model: 'm', messages: [{ role: 'assistant', content: [{ type: 'text', text: '⟦EMAIL_1⟧' }], tool_calls: 'nope', function_call: 'nope' }] },
  ]
  for (const [i, body] of odd.entries()) {
    it(`case ${i}`, async () => {
      reply = () => ({ json: { choices: [], output: [] } })
      const path = 'input' in body ? '/v1/responses' : '/v1/chat/completions'
      const res = await post(path, body, fresh())
      expect([200, 422]).toContain(res.status)
    })
  }
})

describe('the model turn a Responses assistant item belongs to', () => {
  it('an assistant message separated from the call by a user message de-anchors', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `contact ${A}` }, headers)
    await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `contact ${A}` }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The contact is ⟦EMAIL_1⟧.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'mail them' }] },
      { type: 'function_call', call_id: 'c', name: 'send_mail', arguments: JSON.stringify({ to: '⟦EMAIL_1⟧' }) },
      { type: 'function_call_output', call_id: 'c', output: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.input[1].content[0].text).toBe('The contact is ⟪EMAIL_1⟫.')
    expect(body.input[3].arguments).toContain('⟪EMAIL_1⟫')
  })

  it('reasoning and an assistant message in the call\'s own turn, after a tool output, pass as written', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `mail ${A}` }, headers)
    await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `mail ${A}` }] },
      { type: 'function_call', call_id: 'c0', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c0', output: 'ok' },
      { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'Mail ⟦EMAIL_1⟧.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Mailing ⟦EMAIL_1⟧.' }] },
      { type: 'function_call', call_id: 'c', name: 'send_mail', arguments: JSON.stringify({ to: '⟦EMAIL_1⟧' }) },
      { type: 'function_call_output', call_id: 'c', output: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.input[0].content[0].text).toBe('mail ⟦EMAIL_1⟧')
    expect(body.input[3].summary[0].text).toBe('Mail ⟦EMAIL_1⟧.')
    expect(body.input[4].content[0].text).toBe('Mailing ⟦EMAIL_1⟧.')
    expect(body.input[5].arguments).toContain('⟦EMAIL_1⟧')
  })

  it('Chat: an earlier assistant message de-anchors, while text in the call\'s own message does not', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `contact ${A}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `contact ${A}` },
      { role: 'assistant', content: 'The contact is ⟦EMAIL_1⟧.' },
      { role: 'user', content: 'mail them' },
      { role: 'assistant', content: 'Mailing ⟦EMAIL_1⟧.', tool_calls: [call('c1', 'send_mail', { to: '⟦EMAIL_1⟧' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.messages[1].content).toBe('The contact is ⟪EMAIL_1⟫.')
    expect(body.messages[3].tool_calls[0].function.arguments).toContain('⟪EMAIL_1⟫')
  })
})
