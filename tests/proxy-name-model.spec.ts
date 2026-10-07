// The proxy with a name model (a fake runtime): only user-written text reaches the model, names are restored in the
// reply, a failed inference is logged or refused per `required`, and closing the proxy releases the model.
// Every name is fictional.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/proxy/config.ts'
import { closeProxy, createProxyServer, listen } from '../src/proxy/server.ts'
import { fakeNameModel } from './name-model-fake.ts'
import type { FakeRuntime } from './name-model-fake.ts'

const LABELS = {
  Jane: 'B-GIVEN_NAME', Doe: 'B-SURNAME', Lee: 'B-SURNAME', Berlin: 'B-CITY', 許: 'B-SURNAME', 雅: 'I-GIVEN_NAME', 雯: 'I-GIVEN_NAME',
} as const

let upstream: Server
let upstreamPort = 0
let proxy: Server | undefined
let base = ''
let received: any[] = []
const logs: string[] = []

/** Upstream that echoes the last message's text back as the assistant reply. */
beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (part: Buffer) => { raw += part.toString('utf8') })
    req.on('end', () => {
      const body = JSON.parse(raw)
      received.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: body.messages.at(-1).content } }] }))
    })
  })
  upstreamPort = await listen(upstream, 0)
})

afterEach(async () => {
  if (proxy !== undefined) await closeProxy(proxy)
  proxy = undefined
  received = []
  logs.length = 0
})

afterAll(async () => {
  await new Promise(resolve => upstream.close(resolve))
})

/**
 * Start the proxy with a fake name model.
 * @param required - whether a failed inference refuses the request.
 * @returns the fake runtime.
 */
async function start(required = false): Promise<FakeRuntime> {
  const config = loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}` })
  const { model, runtime } = fakeNameModel(LABELS, { required })
  proxy = createProxyServer({ ...config, nameModel: model.config }, line => logs.push(line), model)
  base = `http://127.0.0.1:${await listen(proxy, 0)}`
  return runtime
}

async function chat(messages: unknown[]): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages }) })
}

describe('proxy with the name model', () => {
  it('masks names in user text, propagates them to the system prompt, and restores the reply', async () => {
    await start()
    const response = await chat([
      { role: 'system', content: 'The user is 許 雅 雯.' },
      { role: 'user', content: [{ type: 'text', text: '我是許雅雯, ask Jane Doe' }] },
    ])
    expect(received[0].messages).toEqual([
      { role: 'system', content: 'The user is ⟦NAME_3⟧.' },
      { role: 'user', content: [{ type: 'text', text: '我是⟦NAME_1⟧, ask ⟦NAME_2⟧' }] },
    ])
    expect((await response.json()).choices[0].message.content).toEqual([{ type: 'text', text: '我是許雅雯, ask Jane Doe' }])
  })

  it('masks every model value in every message, tool-call arguments included, and leaves longer words alone', async () => {
    await start()
    const response = await chat([
      { role: 'user', content: 'Please email Lee about Berlin today.' },
      { role: 'assistant', content: 'Emailing Lee.', tool_calls: [{ id: 'c', type: 'function', function: { name: 'send', arguments: '{"to":"Lee"}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'Sent to Lee, Berlin office; Leeds office skipped.' },
    ])
    expect(response.status).toBe(200)
    expect(received[0].messages).toEqual([
      { role: 'user', content: 'Please email ⟦NAME_1⟧ about ⟦LOC_1⟧ today.' },
      { role: 'assistant', content: 'Emailing ⟦NAME_1⟧.', tool_calls: [{ id: 'c', type: 'function', function: { name: 'send', arguments: '{"to":"⟦NAME_1⟧"}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'Sent to ⟦NAME_1⟧, ⟦LOC_1⟧ office; Leeds office skipped.' },
    ])
    expect((await response.json()).choices[0].message.content).toBe('Sent to Lee, Berlin office; Leeds office skipped.')
  })

  it('refuses a model value left in a field it does not rewrite, but not a longer word holding it', async () => {
    await start()
    const leeds = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', metadata: { office: 'Leeds' }, messages: [{ role: 'user', content: 'Ask Lee' }] }),
    })
    expect(leeds.status).toBe(200)
    const leak = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', metadata: { owner: 'Lee' }, messages: [{ role: 'user', content: 'Ask Lee' }] }),
    })
    expect(leak.status).toBe(422)
    const message = (await leak.json()).error.message
    expect(message).toBe('a detected value is still unmasked at /metadata/owner; the request was not forwarded')
    expect(received).toHaveLength(1)
  })

  it('does not run the model on assistant or tool text', async () => {
    const runtime = await start()
    await chat([{ role: 'assistant', content: 'Jane Doe' }, { role: 'tool', tool_call_id: 't', content: 'Jane Doe' }, { role: 'user', content: 'ok' }])
    expect(received[0].messages.map((message: { content: string }) => message.content)).toEqual(['Jane Doe', 'Jane Doe', 'ok'])
    expect(runtime.windows).toHaveLength(1)
  })

  it('forwards with rules only and logs the failure when inference fails', async () => {
    const runtime = await start()
    runtime.failure = new Error('session lost')
    const response = await chat([{ role: 'user', content: 'Jane Doe at ops@example.test' }])
    expect(response.status).toBe(200)
    expect(received[0].messages[0].content).toBe('Jane Doe at ⟦EMAIL_1⟧')
    expect(logs.at(-1)).toContain('nameModel failed')
  })

  it('refuses with 503 and forwards nothing when inference fails and the model is required', async () => {
    const runtime = await start(true)
    runtime.failure = new Error('session lost')
    const response = await chat([{ role: 'user', content: 'Jane Doe' }])
    expect(response.status).toBe(503)
    expect(received).toHaveLength(0)
  })

  it('releases the model when the proxy closes', async () => {
    const config = loadConfig(undefined, {})
    const { model, runtime } = fakeNameModel(LABELS)
    const server = createProxyServer({ ...config, nameModel: model.config }, () => {}, model)
    await listen(server, 0)
    await closeProxy(server, model)
    expect(runtime.released).toBe(true)
  })
})
