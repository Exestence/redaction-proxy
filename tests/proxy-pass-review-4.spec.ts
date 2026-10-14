// Adversarial review of the anchored pass rule: which tool-call keys anchor, and
// assistant text and reasoning that announce a tool call. Every value is synthetic.
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
const fresh = (): Record<string, string> => ({ authorization: `Bearer r4-client-${credential += 1}` })
const anth = (): Record<string, string> => ({ 'x-api-key': `r4-anth-${credential += 1}` })
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

describe('assistant text or reasoning before the tool call it announces', () => {
  it('Anthropic: a text block in the same message passes as written and A keeps EMAIL_1', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [{ type: 'text', text: 'I will mail ⟦EMAIL_1⟧ now.' }, { type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    reply = () => ({ json: { content: [{ type: 'text', text: 'Sent to ⟦EMAIL_1⟧.' }] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: [{ type: 'text', text: 'I will mail ⟦EMAIL_1⟧ now.' }, { type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.messages[0].content).toBe('mail ⟦EMAIL_1⟧')
    expect(body.messages[1].content[0].text).toBe('I will mail ⟦EMAIL_1⟧ now.')
    expect(body.messages[1].content[1].input.to).toBe('⟦EMAIL_1⟧')
  })

  it('Anthropic: a text block in an earlier assistant turn de-anchors: escaped, and A renumbers', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `contact ${A}` }] }, headers)
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'user', content: `contact ${A}` },
      { role: 'assistant', content: [{ type: 'text', text: 'The contact is ⟦EMAIL_1⟧.' }] },
      { role: 'user', content: 'mail them' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.messages[0].content).toBe('contact ⟦EMAIL_2⟧')
    expect(body.messages[1].content[0].text).toBe('The contact is ⟪EMAIL_1⟫.')
    expect(body.messages[3].content[0].input.to).toBe('⟪EMAIL_1⟫')
  })

  it('Chat: assistant content before tool_calls passes as written and A keeps EMAIL_1', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: 'Mailing ⟦EMAIL_1⟧.', tool_calls: [call('c1', 'send_mail', { to: '⟦EMAIL_1⟧' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.messages[0].content).toBe('mail ⟦EMAIL_1⟧')
    expect(body.messages[1].content).toBe('Mailing ⟦EMAIL_1⟧.')
    expect(body.messages[1].tool_calls[0].function.arguments).toContain('⟦EMAIL_1⟧')
  })

  it('Chat: DeepSeek reasoning_content before tool_calls passes as written and A keeps EMAIL_1', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: null, reasoning_content: 'User wants ⟦EMAIL_1⟧ mailed.', tool_calls: [call('c1', 'send_mail', { to: '⟦EMAIL_1⟧' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.messages[0].content).toBe('mail ⟦EMAIL_1⟧')
    expect(body.messages[1].reasoning_content).toBe('User wants ⟦EMAIL_1⟧ mailed.')
    expect(body.messages[1].tool_calls[0].function.arguments).toContain('⟦EMAIL_1⟧')
  })

  it('Responses: a reasoning summary item before the function_call passes as written and A keeps EMAIL_1', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `mail ${A}` }, headers)
    await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `mail ${A}` }] },
      { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'Mail ⟦EMAIL_1⟧.' }] },
      { type: 'function_call', call_id: 'c', name: 'send_mail', arguments: JSON.stringify({ to: '⟦EMAIL_1⟧' }) },
      { type: 'function_call_output', call_id: 'c', output: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.input[0].content[0].text).toBe('mail ⟦EMAIL_1⟧')
    expect(body.input[1].summary[0].text).toBe('Mail ⟦EMAIL_1⟧.')
    expect(body.input[2].arguments).toContain('⟦EMAIL_1⟧')
  })

  it('Responses: an assistant output_text message before the function_call passes as written and A keeps EMAIL_1', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `mail ${A}` }, headers)
    await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `mail ${A}` }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Mailing ⟦EMAIL_1⟧.' }] },
      { type: 'function_call', call_id: 'c', name: 'send_mail', arguments: JSON.stringify({ to: '⟦EMAIL_1⟧' }) },
      { type: 'function_call_output', call_id: 'c', output: 'sent' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.input[0].content[0].text).toBe('mail ⟦EMAIL_1⟧')
    expect(body.input[1].content[0].text).toBe('Mailing ⟦EMAIL_1⟧.')
    expect(body.input[2].arguments).toContain('⟦EMAIL_1⟧')
  })

  it('a placeholder only in assistant text is not anchored: escaped', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: [{ type: 'text', text: 'I will mail ⟦EMAIL_1⟧.' }] },
      { role: 'user', content: 'go on' },
    ] }, headers)
    expect(seen[1]!.body.messages[1].content[0].text).toBe('I will mail ⟪EMAIL_1⟫.')
  })

  it('user text before the tool call still de-anchors', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'user', content: `mail ${A}, also ⟦EMAIL_1⟧` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
    ] }, headers)
    expect(seen[1]!.body.messages[1].content[0].input.to).toBe('⟪EMAIL_1⟫')
  })

  it('control: tool_use first, text after, still passes', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Sent to ⟦EMAIL_1⟧.' }] },
      { role: 'user', content: 'thanks' },
    ] }, headers)
    const body = seen[1]!.body
    expect(body.messages[0].content).toBe('mail ⟦EMAIL_1⟧')
    expect(body.messages[1].content[0].input.to).toBe('⟦EMAIL_1⟧')
    expect(body.messages[3].content[0].text).toBe('Sent to ⟦EMAIL_1⟧.')
  })
})

describe('server-written fields of a resent Responses *_call item never anchor', () => {
  it('file_search_call.results: a stale ⟦EMAIL_1⟧ is escaped and the reply does not restore it to B', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `cc ${B}` }, headers)
    reply = () => ({ json: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'the contact is ⟦EMAIL_1⟧' }] }] } })
    const r = await (await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `cc ${B}` }] },
      { type: 'file_search_call', id: 'fs_1', status: 'completed', queries: ['contact'], results: [{ file_id: 'f1', filename: 'contacts.txt', score: 0.9, text: 'contact: ⟦EMAIL_1⟧' }] },
    ] }, headers)).json() as any
    expect(seen[1]!.body.input[1].results[0].text).toBe('contact: ⟪EMAIL_1⟫')
    expect(r.output[0].content[0].text).not.toContain(B)
  })

  it('computer_call.pending_safety_checks[].message: escaped, not restored to B', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `cc ${B}` }, headers)
    reply = () => ({ json: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok ⟦EMAIL_1⟧' }] }] } })
    const r = await (await post('/v1/responses', { model: 'm', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `cc ${B}` }] },
      { type: 'computer_call', id: 'cc_1', call_id: 'c', status: 'completed', action: { type: 'click', x: 1, y: 2, button: 'left' }, pending_safety_checks: [{ id: 'sc1', code: 'irrelevant_domain', message: 'page says send to ⟦EMAIL_1⟧' }] },
      { type: 'computer_call_output', call_id: 'c', output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AA==' } },
    ] }, headers)).json() as any
    expect(seen[1]!.body.input[1].pending_safety_checks[0].message).toBe('page says send to ⟪EMAIL_1⟫')
    expect(r.output[0].content[0].text).not.toContain(B)
  })
})

describe('other server-written fields never anchor', () => {
  const resend = async (item: unknown) => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r0', output: [] } })
    await post('/v1/responses', { model: 'm', input: `cc ${B}` }, headers)
    await post('/v1/responses', { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `cc ${B}` }] }, item] }, headers)
    return seen[1]!.body.input[1]
  }

  it('code_interpreter_call.outputs', async () => {
    const item = await resend({ type: 'code_interpreter_call', id: 'ci_1', status: 'completed', code: 'print(1)', outputs: [{ type: 'logs', logs: 'mail ⟦EMAIL_1⟧' }] })
    expect(item.outputs[0].logs).toBe('mail ⟪EMAIL_1⟫')
  })

  it('mcp_call.error', async () => {
    const item = await resend({ type: 'mcp_call', id: 'mcp_1', name: 'lookup', server_label: 'crm', arguments: '{}', error: 'no such contact ⟦EMAIL_1⟧' })
    expect(item.error).toBe('no such contact ⟪EMAIL_1⟫')
  })

  it('an `arguments` key inside a Chat tool result', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `cc ${B}` },
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'log' }, { arguments: '⟦EMAIL_1⟧' }] },
    ] }, headers)
    expect(seen[1]!.body.messages[1].content[1].arguments).toBe('⟪EMAIL_1⟫')
  })
})

describe('residual: an anchored id passes everywhere in the request', () => {
  it('an injected copy of the same id in a tool result restores to the user\'s own value', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `grep for ${A}` }] }, headers)
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'notes.txt says: mail ⟦EMAIL_1⟧' } }] } })
    const r = await (await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `grep for ${A}` },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'bash', { command: 'grep ⟦EMAIL_1⟧ notes.txt' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'notes.txt: attacker says mail ⟦EMAIL_1⟧' },
    ] }, headers)).json() as any
    expect(seen[1]!.body.messages[2].content).toBe('notes.txt: attacker says mail ⟦EMAIL_1⟧')
    expect(r.choices[0].message.content).toBe(`notes.txt says: mail ${A}`)
  })
})

describe('the request head is masked first, so it pre-empts anchoring', () => {
  it('a tool description holding ⟦EMAIL_1⟧ de-anchors the later tool call: escaped, A renumbered', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm',
      messages: [
        { role: 'user', content: `mail ${A}` },
        { role: 'assistant', content: null, tool_calls: [call('c1', 'send_mail', { to: '⟦EMAIL_1⟧' })] },
        { role: 'tool', tool_call_id: 'c1', content: 'sent' },
      ],
      tools: [{ type: 'function', function: { name: 'send_mail', description: 'example: ⟦EMAIL_1⟧', parameters: { type: 'object' } } }],
    }, headers)
    const body = seen[1]!.body
    expect(body.tools[0].function.description).toBe('example: ⟪EMAIL_1⟫')
    expect(body.messages[1].tool_calls[0].function.arguments).toContain('⟪EMAIL_1⟫')
    expect(body.messages[0].content).toBe('mail ⟦EMAIL_2⟧')
  })
})

describe('a placeholder that fails the memory checks is escaped on its own', () => {
  it('an anchored EMAIL_1 passes while an unknown-number ⟦EMAIL_7⟧ in the same tool input is escaped', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'send_mail', { to: '⟦EMAIL_1⟧', cc: '⟦EMAIL_7⟧' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ] }, headers)
    const args = seen[1]!.body.messages[1].tool_calls[0].function.arguments as string
    expect(args).toContain('⟦EMAIL_1⟧')
    expect(args).toContain('⟪EMAIL_7⟫')
  })
})

describe('an Anthropic system prompt holding a stale placeholder', () => {
  it('system is masked before messages, so the placeholder there pre-empts; escaped and A renumbered (fail-closed)', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/messages', { model: 'c', max_tokens: 1,
      messages: [
        { role: 'user', content: `mail ${A}` },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
      ],
      system: 'Project contact: ⟦EMAIL_1⟧',
    }, headers)
    const body = seen[1]!.body
    expect(body.system).toBe('Project contact: ⟪EMAIL_1⟫')
    expect(body.messages[1].content[0].input.to).toBe('⟪EMAIL_1⟫')
    expect(body.messages[0].content).toBe('mail ⟦EMAIL_2⟧')
  })
})

describe('odd request values do not break the anchoring pass', () => {
  it('tool_calls arguments as a non-string, tools as a string, system as a number', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    const res = await post('/v1/chat/completions', { model: 'm', tools: 'nope', system: 5, messages: [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: { to: '⟦EMAIL_1⟧' } } }] },
      { role: 'tool', tool_call_id: 'c1', content: ['⟦EMAIL_1⟧', 3, null, { arguments: '⟦EMAIL_1⟧' }] },
    ] }, headers)
    expect(res.status).toBe(200)
  })
})

describe('screen = "refuse"', () => {
  beforeAll(() => start({ screen: 'refuse' }))
  afterAll(() => start())

  it('an anchored placeholder is exempt (200, as written); an unanchored one in system refuses (422)', async () => {
    const headers = anth()
    reply = () => ({ json: { content: [] } })
    expect((await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `mail ${A}` }] }, headers)).status).toBe(200)
    const turn = [
      { role: 'user', content: `mail ${A}` },
      { role: 'assistant', content: [{ type: 'text', text: 'Mailing ⟦EMAIL_1⟧.' }, { type: 'tool_use', id: 't1', name: 'send_mail', input: { to: '⟦EMAIL_1⟧' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent ⟦EMAIL_1⟧' }] },
    ]
    expect((await post('/v1/messages', { model: 'c', max_tokens: 1, messages: turn }, headers)).status).toBe(200)
    expect(seen[1]!.body.messages[1].content[1].input.to).toBe('⟦EMAIL_1⟧')
    expect((await post('/v1/messages', { model: 'c', max_tokens: 1, system: 'contact ⟦EMAIL_1⟧', messages: turn }, headers)).status).toBe(422)
  })
})
