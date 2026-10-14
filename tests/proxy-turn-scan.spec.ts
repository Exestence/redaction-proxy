// Finding the model turn of each Responses item must stay linear: 64,000 consecutive
// `function_call` items took 12 s of CPU when every item walked back to its turn start.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DEFAULT_TOOL_RESTORE_CATEGORIES, loadConfig } from '../src/proxy/config.ts'
import { createProxyServer, listen } from '../src/proxy/server.ts'

let upstream: Server
let proxy: Server
let base = ''

beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"id":"r","output":[]}')
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const port = (upstream.address() as { port: number }).port
  const config = {
    ...loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${port}` }),
    toolRestore: { categories: DEFAULT_TOOL_RESTORE_CATEGORIES, tools: new Map() },
  }
  proxy = createProxyServer(config, () => {})
  base = `http://127.0.0.1:${await listen(proxy, 0)}`
})

afterAll(async () => {
  await new Promise(resolve => proxy.close(resolve))
  await new Promise(resolve => upstream.close(resolve))
})

it('groups 64,000 consecutive Responses call items into turns within 5s of CPU time', async () => {
  const input = Array.from({ length: 64_000 }, (_, i) => ({ type: 'function_call', call_id: `c${i}`, name: 'f', arguments: '{"a":"x"}' }))
  const started = process.cpuUsage()
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: JSON.stringify({ model: 'm', input }),
  })
  await res.text()
  const used = process.cpuUsage(started)
  expect(res.status).toBe(200)
  expect((used.user + used.system) / 1_000).toBeLessThan(5_000)
}, 60_000)
