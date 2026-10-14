// Adversarial review of passing resent placeholders as written: a placeholder must
// restore to the value it was written for or stay as written.
// Every value is synthetic.
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_RESTORE_CATEGORIES, loadConfig } from '../src/proxy/config.ts'
import type { ProxyConfig } from '../src/proxy/config.ts'
import { createProxyServer, listen } from '../src/proxy/server.ts'

const A = 'first.fictional@example.test'
const B = 'second.fictional@example.test'
const V1 = 'Tr0ub4dor&3x'

interface Seen { url: string; headers: IncomingHttpHeaders; raw: string; body: any }
type Reply = (seen: Seen) => { json?: unknown; status?: number }

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
const fresh = (): Record<string, string> => ({ authorization: `Bearer r2-client-${credential += 1}` })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('a Responses chain whose numbering moves', () => {
  const X1 = 'Blu3Whale#7xq'
  const M1 = 'C0rrectH0rse!9'

  it('escapes its stored placeholders when memory learns an earlier value, so the old ⟦KEY_1⟧ comes back as written', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    // Another conversation taught memory M1.
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${M1}` }] }, headers)
    // r1: X1 is bare and unknown; M1 is masked by memory alone as KEY_1 (no rule-detected KEY in the request).
    reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦KEY_1⟧' }) }] } })
    await post('/v1/responses', { model: 'm', input: `creds: ${X1} and ${M1}` }, headers)
    expect(seen[1]!.body.input).toBe(`creds: ${X1} and ⟦KEY_1⟧`)
    reply = () => ({ json: { id: 'r2', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦KEY_1⟧ ok' }] }, headers)
    expect(seen[2]!.body.input[0].output).toBe('⟦KEY_1⟧ ok')
    // Now another conversation teaches memory X1, which sits earlier in the chain's prior text.
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${X1}` }] }, headers)
    reply = () => ({ json: { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: 'use ⟦KEY_1⟧' }] }] } })
    const r3 = await (await post('/v1/responses', { model: 'm', previous_response_id: 'r2', input: 'and?' }, headers)).json() as any
    // The upstream learned KEY_1 = M1 in r1 and r2; X1 would now take KEY_1, so the stored ⟦KEY_1⟧ is escaped, which reserves its number.
    expect(r3.output[0].content[0].text).toBe('use ⟦KEY_1⟧')
  })

  it('escapes its stored placeholders when a memory-only value expires, so a new credential never answers to the old ⟦KEY_1⟧', async () => {
    await start({ knownOriginalsTtlSeconds: 1 })
    try {
      const headers = fresh()
      reply = () => ({ json: { choices: [] } })
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `password: ${M1}` }] }, headers)
      reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦KEY_1⟧' }) }] } })
      await post('/v1/responses', { model: 'm', input: `creds: ${M1}` }, headers)
      expect(seen[1]!.body.input).toBe('creds: ⟦KEY_1⟧')
      reply = () => ({ json: { id: 'r2', output: [] } })
      await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦KEY_1⟧ ok' }] }, headers)
      await sleep(1200)
      reply = () => ({ json: { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: 'use ⟦KEY_1⟧' }] }] } })
      const r3 = await (await post('/v1/responses', { model: 'm', previous_response_id: 'r2', input: `new password: ${X1}` }, headers)).json() as any
      expect(JSON.stringify(seen[3]!.body.input)).not.toContain(M1)
      expect(JSON.stringify(seen[3]!.body.input)).not.toContain(X1)
      expect(r3.output[0].content[0].text).toBe('use ⟦KEY_1⟧')
    } finally {
      await start()
    }
  })
})

describe('a passed placeholder beside a credential keyword', () => {
  it('a tool result "password: ⟦KEY_1⟧" still passes as written', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo "password: ⟦KEY_1⟧" and "Bearer ⟦KEY_1⟧"' } }] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [{ role: 'user', content: `password: ${V1}` }] }, { 'x-api-key': headers.authorization! })
    reply = () => ({ json: { content: [] } })
    await post('/v1/messages', { model: 'c', max_tokens: 1, messages: [
      { role: 'user', content: `password: ${V1}` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo "password: ⟦KEY_1⟧" and "Bearer ⟦KEY_1⟧"' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'password: ⟦KEY_1⟧ and Bearer ⟦KEY_1⟧' }] },
    ] }, { 'x-api-key': headers.authorization! })
    expect(seen[1]!.body.messages[2].content[0].content).toBe('password: ⟦KEY_1⟧ and Bearer ⟦KEY_1⟧')
  })
})

describe('a placeholder read back from a file', () => {
  it('is escaped once the value it was written for is forgotten, so the reply\'s ⟦EMAIL_1⟧ never restores to the new EMAIL_1', async () => {
    await start({ knownOriginalsTtlSeconds: 1 })
    try {
      const headers = fresh()
      reply = () => ({ json: { choices: [] } })
      // Conversation 1 (day 1): A is EMAIL_1; the model wrote it to a file as the literal placeholder (EMAIL is not restored into tool args).
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
      expect(seen[0]!.body.messages[0].content).toBe('mail ⟦EMAIL_1⟧')
      await sleep(1200)
      // Conversation 2 (later): B is this conversation's first email, EMAIL_1.
      await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
      expect(seen[1]!.body.messages[0].content).toBe('cc ⟦EMAIL_1⟧')
      // The model cats the old file; its content is the literal written for A.
      reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'The file lists ⟦EMAIL_1⟧ as the contact.' } }] } })
      const res = await (await post('/v1/chat/completions', { model: 'm', messages: [
        { role: 'user', content: `cc ${B}` },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'cat contacts.txt' }) } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'contact: ⟦EMAIL_1⟧' },
      ] }, headers)).json() as any
      // Only in a tool result, so escaped: its number is reserved and B is renumbered.
      expect(seen[2]!.body.messages[2].content).toBe('contact: ⟪EMAIL_1⟫')
      expect(seen[2]!.body.messages[0].content).toBe('cc ⟦EMAIL_2⟧')
      expect(res.choices[0].message.content).toBe('The file lists ⟦EMAIL_1⟧ as the contact.')
    } finally {
      await start()
    }
  })
})

describe('a bare identity in the new input of a chain', () => {
  it('reserves the number: the chain\'s old ⟦EMAIL_1⟧ comes back unknown (kept), not as another value', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' }) }] } })
    await post('/v1/responses', { model: 'm', input: `mail ${A}` }, headers)
    reply = () => ({ json: { id: 'r2', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦EMAIL_1⟧ ok' }] }, headers)
    reply = () => ({ json: { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: 'sent to ⟦EMAIL_1⟧ and ⟦EMAIL_2⟧' }] }] } })
    const r3 = await (await post('/v1/responses', { model: 'm', previous_response_id: 'r2', input: `the id EMAIL_1 and ${B}` }, headers)).json() as any
    expect(seen[2]!.body.input).toBe('the id EMAIL_1 and ⟦EMAIL_3⟧')
    expect(r3.output[0].content[0].text).toBe(`sent to ⟦EMAIL_1⟧ and ${A}`)
  })
})

describe('texts that use every private-use character', () => {
  let pua = ''
  for (let code = 0xe000; code <= 0xf8ff; code += 1) pua += String.fromCharCode(code)

  it('a non-chain request that resends a passable placeholder beside every PUA character still goes through, escaped', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    const res = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }, { role: 'assistant', content: `sent ⟦EMAIL_1⟧ ${pua}` }] }, headers)
    expect(res.status).toBe(200)
    expect(seen[1]!.body.messages[1].content.startsWith('sent ⟪EMAIL_1⟫')).toBe(true)
  })

  it('a chain goes on with its stored placeholders escaped, and the old ⟦EMAIL_1⟧ comes back as written', async () => {
    const headers = fresh()
    reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' }) }] } })
    await post('/v1/responses', { model: 'm', input: `mail ${A}` }, headers)
    reply = () => ({ json: { id: 'r2', output: [] } })
    await post('/v1/responses', { model: 'm', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c', output: '⟦EMAIL_1⟧ ok' }] }, headers)
    reply = () => ({ json: { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: 'sent ⟦EMAIL_1⟧' }] }] } })
    const res = await post('/v1/responses', { model: 'm', previous_response_id: 'r2', input: `font dump ${pua}` }, headers)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).output[0].content[0].text).toBe('sent ⟦EMAIL_1⟧')
  })
})

describe('sendWhenMaskFails on a chain', () => {
  it('a continuation after a sent-anyway failure does not restore an old id to another value', async () => {
    await start({ sendWhenMaskFails: true })
    try {
      const headers = fresh()
      reply = () => ({ json: { id: 'r1', output: [{ type: 'function_call', call_id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'echo ⟦EMAIL_1⟧' }) }] } })
      await post('/v1/responses', { model: 'm', input: `mail ${A}` }, headers)
      // A leak the proxy cannot mask: the email in metadata, which it does not rewrite.
      reply = () => ({ json: { id: 'r2', output: [] } })
      const r2 = await post('/v1/responses', { model: 'm', previous_response_id: 'r1', metadata: { who: A }, input: [{ type: 'function_call_output', call_id: 'c', output: `⟦EMAIL_1⟧ ok, cc ${B}` }] }, headers)
      expect(r2.headers.get('x-redaction-proxy-mask-failed')).toBe('1')
      reply = () => ({ json: { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: 'to ⟦EMAIL_1⟧ and ⟦EMAIL_2⟧' }] }] } })
      const r3 = await (await post('/v1/responses', { model: 'm', previous_response_id: 'r2', input: 'and?' }, headers)).json() as any
      expect(r3.output[0].content[0].text).toBe(`to ${A} and ${B}`)
    } finally {
      await start()
    }
  })
})

describe('the cost of many remembered placeholders', () => {
  it('4096 distinct passable literals beside a 1 MB text', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    const emails = Array.from({ length: 4096 }, (_, i) => `person${i}.fictional@example.test`)
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: emails.join('\n') }] }, headers)
    const literals = emails.map((_, i) => `⟦EMAIL_${i + 1}⟧`).join('\n')
    const big = 'x'.repeat(1024 * 1024)
    const started = performance.now()
    const res = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: emails.join('\n') }, { role: 'assistant', content: literals }, { role: 'user', content: big }] }, headers)
    const took = performance.now() - started
    expect(res.status).toBe(200)
    expect(took).toBeLessThan(5000)
  }, 60_000)
})

describe('a placeholder read back from a file after a restart', () => {
  it('is escaped, so the reply\'s ⟦EMAIL_1⟧ never restores to the new EMAIL_1', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `cc ${B}` }] }, headers)
    reply = () => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'The file lists ⟦EMAIL_1⟧.' } }] } })
    const res = await (await post('/v1/chat/completions', { model: 'm', messages: [
      { role: 'user', content: `cc ${B}` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'cat contacts.txt' }) } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'contact: ⟦EMAIL_1⟧' },
    ] }, headers)).json() as any
    expect(seen[1]!.body.messages[2].content).toBe('contact: ⟪EMAIL_1⟫')
    expect(res.choices[0].message.content).toBe('The file lists ⟦EMAIL_1⟧.')
  })
})

describe('an issued placeholder outside tool-call input', () => {
  it('is escaped in user text although its value is in the request', async () => {
    const headers = fresh()
    reply = () => ({ json: { choices: [] } })
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }] }, headers)
    await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `mail ${A}` }, { role: 'user', content: 'Summary: the customer is ⟦EMAIL_1⟧.' }] }, headers)
    expect(seen[1]!.body.messages.map((message: any) => message.content)).toEqual(['mail ⟦EMAIL_2⟧', 'Summary: the customer is ⟪EMAIL_1⟫.'])
  })
})
