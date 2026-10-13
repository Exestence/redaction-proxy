// sendWhenMaskFails: a request whose masking fails is refused by default and
// sent, marked by a response header, when the switch is on.
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedactionError, mask } from '../src/core/index.ts'
import { loadConfig } from '../src/proxy/config.ts'
import { closeProxy, createProxyServer, listen } from '../src/proxy/server.ts'

vi.mock('../src/core/index.ts', async importOriginal => {
  const core = await importOriginal<typeof import('../src/core/index.ts')>()
  return { ...core, mask: vi.fn(core.mask) }
})

// Fictional values only.
const EMAIL = 'lin.fictional@example.test'
const HEADER = 'x-redaction-proxy-mask-failed'

let upstream: Server
let upstreamPort = 0
let received: Array<{ headers: IncomingHttpHeaders, raw: string }> = []

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part: string) => { raw += part })
    req.on('end', () => {
      received.push({ headers: req.headers, raw })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Wrote to ⟦EMAIL_1⟧.' } }] }))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as { port: number }).port
})

afterAll(() => new Promise(resolve => upstream.close(resolve)))

beforeEach(() => {
  received = []
})

async function withProxy(env: Record<string, string>, run: (base: string, logs: string[]) => Promise<void>): Promise<void> {
  const logs: string[] = []
  const config = loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, REDACTION_PROXY_DEBUG_MASKED: '1', ...env })
  const server = createProxyServer(config, line => logs.push(line))
  try {
    await run(`http://127.0.0.1:${await listen(server, 0)}`, logs)
  } finally {
    await closeProxy(server)
  }
}

function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

const LEAKY = { model: 'm', metadata: { owner: EMAIL }, messages: [{ role: 'user', content: `mail ${EMAIL} today` }] }

describe('a detected value still present after masking', () => {
  it('is refused with 422 by default', async () => {
    await withProxy({}, async base => {
      const res = await post(base, LEAKY)
      expect(res.status).toBe(422)
      expect(res.headers.has(HEADER)).toBe(false)
      expect(await res.text()).toContain('/metadata/owner (EMAIL)')
      expect(received).toHaveLength(0)
    })
  })

  it('is sent partly masked with the header when sendWhenMaskFails is on, logging fields but no value', async () => {
    await withProxy({ REDACTION_PROXY_SEND_WHEN_MASK_FAILS: '1' }, async (base, logs) => {
      const res = await post(base, LEAKY)
      expect(res.status).toBe(200)
      expect(res.headers.get(HEADER)).toBe('1')
      expect((await res.json() as any).choices[0].message.content).toBe(`Wrote to ${EMAIL}.`)
      const sent = JSON.parse(received[0]!.raw)
      expect(sent.messages[0].content).toBe('mail ⟦EMAIL_1⟧ today')
      expect(sent.metadata.owner).toBe(EMAIL)
      const warnings = logs.filter(line => line.includes('sendWhenMaskFails'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('/metadata/owner (EMAIL)')
      for (const line of logs) expect(line).not.toContain(EMAIL)
    })
  })

  it('is sent without the header when nothing leaks', async () => {
    await withProxy({ REDACTION_PROXY_SEND_WHEN_MASK_FAILS: '1' }, async base => {
      const res = await post(base, { model: 'm', messages: [{ role: 'user', content: `mail ${EMAIL}` }] })
      expect(res.status).toBe(200)
      expect(res.headers.has(HEADER)).toBe(false)
      expect(received[0]!.raw).not.toContain(EMAIL)
    })
  })
})

describe('masking that throws', () => {
  const failOnce = (): void => {
    vi.mocked(mask).mockImplementationOnce(() => Promise.reject(new RedactionError('conflict', 'fictional conflict')))
  }

  it('is refused with 422 by default', async () => {
    await withProxy({}, async base => {
      failOnce()
      const res = await post(base, LEAKY)
      expect(res.status).toBe(422)
      expect(await res.text()).toContain('request text cannot be masked: conflict')
      expect(received).toHaveLength(0)
    })
  })

  it('sends the original body with the header when sendWhenMaskFails is on, restoring nothing', async () => {
    await withProxy({ REDACTION_PROXY_SEND_WHEN_MASK_FAILS: '1' }, async (base, logs) => {
      failOnce()
      const res = await post(base, LEAKY)
      expect(res.status).toBe(200)
      expect(res.headers.get(HEADER)).toBe('1')
      expect(received[0]!.raw).toBe(JSON.stringify(LEAKY))
      expect((await res.json() as any).choices[0].message.content).toBe('Wrote to ⟦EMAIL_1⟧.')
      const warnings = logs.filter(line => line.includes('sendWhenMaskFails'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('cannot be masked: conflict')
      for (const line of logs) expect(line).not.toContain(EMAIL)
    })
  })
})

describe('refusals the switch leaves in place', () => {
  it('still refuses screen "refuse" and an unknown previous_response_id', async () => {
    await withProxy({ REDACTION_PROXY_SEND_WHEN_MASK_FAILS: '1', REDACTION_PROXY_SCREEN: 'refuse' }, async base => {
      expect((await post(base, { model: 'm', messages: [{ role: 'user', content: 'a\u0007b' }] })).status).toBe(422)
      const res = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', previous_response_id: 'resp_unknown', input: 'hi' }) })
      expect(res.status).toBe(422)
      expect(received).toHaveLength(0)
    })
  })
})
