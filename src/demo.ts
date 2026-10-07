/**
 * Demo without an API key (`redaction-proxy --demo`): a fake OpenAI-compatible
 * upstream that streams back the placeholders it received, the proxy in front
 * of it, and one streamed request. Prints what the client sent, what the
 * upstream saw, and what the client got back. All values are fictional.
 *
 * @module redaction-proxy/demo
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadConfig } from './proxy/config.ts'
import { createProxyServer, listen } from './proxy/server.ts'

/** Run the demo once; both servers are closed before it resolves. */
export async function runDemo(): Promise<void> {
  let received = ''
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', part => { raw += part })
    req.on('end', () => {
      received = raw
      const ids = [...new Set(raw.match(/⟦[A-Z0-9_]+⟧/g) ?? [])]
      const answer = `I will email ${ids[0]} about ${ids[2]}/notes.md (ID ${ids[1]}).`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let i = 0; i < answer.length; i += 4) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer.slice(i, i + 4) }, finish_reason: null }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      res.end()
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))

  const upstreamPort = (upstream.address() as AddressInfo).port
  const config = loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}` })
  const proxy = createProxyServer(config, line => console.log(`[proxy log] ${line}`))
  const port = await listen(proxy, 0)

  const content = '請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md'
  console.log(`client sends:      ${content}`)
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-key' },
    body: JSON.stringify({ model: 'demo', stream: true, messages: [{ role: 'user', content }] }),
  })
  const text = await res.text()
  const reply = text.split('\n\n').filter(block => block.startsWith('data: {'))
    .map(block => (JSON.parse(block.slice(6)) as { choices: [{ delta: { content?: string } }] }).choices[0].delta.content ?? '').join('')
  console.log(`upstream received: ${(JSON.parse(received) as { messages: [{ content: string }] }).messages[0].content}`)
  console.log(`client receives:   ${reply}`)
  proxy.close()
  upstream.close()
}
