// Who may use the proxy: the bind address, the auth token, Host and Origin
// checks, and the settings that refuse unsafe configurations at startup.
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/proxy/config.ts'
import type { ProxyConfig } from '../src/proxy/config.ts'
import { closeProxy, createProxyServer, listen } from '../src/proxy/server.ts'

const TOKEN = 'fictional-token-0123456789abcdef'

function configFile(content: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'proxy-host-')), 'config.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

describe('host', () => {
  it('defaults to 127.0.0.1 and takes the file key, overridden by REDACTION_PROXY_HOST', () => {
    expect(loadConfig(undefined, {}).host).toBe('127.0.0.1')
    const file = configFile({ host: '::1' })
    expect(loadConfig(file, {}).host).toBe('::1')
    expect(loadConfig(file, { REDACTION_PROXY_HOST: '0.0.0.0', REDACTION_PROXY_AUTH_TOKEN: TOKEN }).host).toBe('0.0.0.0')
  })

  it('refuses a host that is not loopback without an auth token', () => {
    expect(() => loadConfig(undefined, { REDACTION_PROXY_HOST: '0.0.0.0' })).toThrow('auth token is required')
    expect(() => loadConfig(undefined, { REDACTION_PROXY_HOST: '::' })).toThrow('auth token is required')
    expect(loadConfig(undefined, { REDACTION_PROXY_HOST: '127.0.0.2' }).authToken).toBeUndefined()
    expect(loadConfig(configFile({ host: '0.0.0.0', authToken: TOKEN }), {}).authToken).toBe(TOKEN)
  })

  it('refuses a host that is not a non-empty string', () => {
    expect(() => loadConfig(configFile({ host: 8787 }), {})).toThrow('host must be a non-empty string')
    expect(() => loadConfig(undefined, { REDACTION_PROXY_HOST: '' })).toThrow('host must be a non-empty string')
  })

  it('listen binds 127.0.0.1 by default', async () => {
    const server = createProxyServer(loadConfig(undefined, {}))
    await listen(server, 0)
    expect(server.address()).toMatchObject({ address: '127.0.0.1' })
    server.close()
  })
})

describe('settings that fail loud', () => {
  it('refuses an empty or malformed REDACTION_PROXY_PORT', () => {
    expect(() => loadConfig(undefined, { REDACTION_PROXY_PORT: '' })).toThrow('REDACTION_PROXY_PORT must be a port number')
    expect(() => loadConfig(undefined, { REDACTION_PROXY_PORT: '0x10' })).toThrow('REDACTION_PROXY_PORT must be a port number')
    expect(loadConfig(undefined, { REDACTION_PROXY_PORT: '9000' }).port).toBe(9000)
  })

  it('refuses plain http:// to an upstream that is not loopback unless allowed', () => {
    expect(() => loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: 'http://api.example.test' })).toThrow('cleartext')
    expect(() => loadConfig(configFile({ anthropicUpstream: 'http://192.0.2.1:8080' }), {})).toThrow('cleartext')
    expect(loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: 'http://api.example.test', REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM: '1' }).openaiUpstream).toBe('http://api.example.test')
    for (const local of ['http://127.0.0.1:1234', 'http://localhost:1234/v1', 'http://[::1]:1234']) {
      expect(loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: local }).openaiUpstream).toBe(local)
    }
  })

  it('refuses a short auth token', () => {
    expect(() => loadConfig(undefined, { REDACTION_PROXY_AUTH_TOKEN: '' })).toThrow('at least 16 characters')
    expect(() => loadConfig(configFile({ authToken: 'short' }), {})).toThrow('at least 16 characters')
  })

  it('reads allowedOrigins and refuses null and *', () => {
    expect(loadConfig(undefined, {}).allowedOrigins).toEqual([])
    expect(loadConfig(configFile({ allowedOrigins: ['APP://Client/'] }), {}).allowedOrigins).toEqual(['app://client'])
    expect(loadConfig(undefined, { REDACTION_PROXY_ALLOWED_ORIGINS: 'app://a, https://b.example:8443' }).allowedOrigins).toEqual(['app://a', 'https://b.example:8443'])
    expect(() => loadConfig(configFile({ allowedOrigins: ['null'] }), {})).toThrow('"null"')
    expect(() => loadConfig(configFile({ allowedOrigins: ['*'] }), {})).toThrow('"null"')
  })
})

describe('requests', () => {
  let upstream: Server
  let upstreamPort = 0
  let received: IncomingHttpHeaders[] = []

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      received.push(req.headers)
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end('{"choices":[]}')
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstream.address() as { port: number }).port
  })

  afterAll(() => new Promise(resolve => upstream.close(resolve)))

  async function withProxy(env: Record<string, string>, run: (port: number, logs: string[]) => Promise<void>, overrides: Partial<ProxyConfig> = {}): Promise<void> {
    received = []
    const logs: string[] = []
    const server = createProxyServer({ ...loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, ...env }), ...overrides }, line => logs.push(line))
    try {
      await run(await listen(server, 0), logs)
    } finally {
      await closeProxy(server)
    }
  }

  function send(port: number, headers: Record<string, string>, method = 'POST', body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })): Promise<{ status: number, headers: IncomingHttpHeaders, body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method, headers: { 'content-type': 'application/json', ...headers } }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (part: string) => { text += part })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
      })
      req.on('error', reject)
      req.end(method === 'POST' ? body : undefined)
    })
  }

  it('requires the token when one is set, strips it before forwarding, and accepts any Host with it', async () => {
    await withProxy({ REDACTION_PROXY_AUTH_TOKEN: TOKEN }, async (port, logs) => {
      expect((await send(port, {})).status).toBe(401)
      expect((await send(port, { 'x-redaction-proxy-token': `${TOKEN}x` })).status).toBe(401)
      expect(received).toHaveLength(0)
      expect((await send(port, { 'x-redaction-proxy-token': TOKEN, host: 'redaction-proxy:8787' })).status).toBe(200)
      expect(received[0]!['x-redaction-proxy-token']).toBeUndefined()
      expect(logs.join('\n')).not.toContain(TOKEN)
    })
  })

  it('refuses a foreign Host without a token, and a browser origin that is not loopback http(s) or allowed', async () => {
    await withProxy({}, async port => {
      expect((await send(port, { host: 'rebound.example:8787' })).status).toBe(403)
      expect((await send(port, { origin: 'app://localhost' })).status).toBe(403)
      expect((await send(port, { origin: 'app://client' })).status).toBe(403)
      expect((await send(port, { origin: 'null' })).status).toBe(403)
      expect(received).toHaveLength(0)
      const local = await send(port, { origin: 'http://localhost:3000' })
      expect(local.status).toBe(200)
      expect(local.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    })
  })

  it('serves an allowed origin, answering its preflight without the token and without forwarding', async () => {
    await withProxy({ REDACTION_PROXY_AUTH_TOKEN: TOKEN, REDACTION_PROXY_ALLOWED_ORIGINS: 'app://client' }, async port => {
      const preflight = await send(port, { origin: 'app://client', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-redaction-proxy-token' }, 'OPTIONS')
      expect(preflight.status).toBe(204)
      expect(preflight.headers).toMatchObject({
        'access-control-allow-origin': 'app://client',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type, x-redaction-proxy-token',
      })
      expect((await send(port, { origin: 'https://evil.example', 'access-control-request-method': 'POST' }, 'OPTIONS')).status).toBe(403)
      expect(received).toHaveLength(0)
      const real = await send(port, { origin: 'app://client', 'x-redaction-proxy-token': TOKEN })
      expect(real.status).toBe(200)
      // The upstream's `*` is replaced by the proxy's own decision.
      expect(real.headers['access-control-allow-origin']).toBe('app://client')
    })
  })

  it('names a key that is not a lower-case identifier as <key> in a refusal', async () => {
    await withProxy({}, async (port, logs) => {
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], extra: { 'Alice Fictional\nforged': 'bell \u0007' } })
      const res = await send(port, {}, 'POST', body)
      expect(res.status).toBe(422)
      expect(res.body).toContain('/extra/<key>')
      expect(logs.join('\n')).not.toContain('Alice')
    }, { screen: 'refuse' })
  })
})
