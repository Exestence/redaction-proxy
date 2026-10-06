// Captures real proxy output for the README media. Runs `bench/demo.mjs` and
// one more streamed request through the built proxy against a local fake
// upstream, then writes what the client sent, what the upstream received, and
// what the client got back to docs/media/src/captured.json. All values are
// fictional. Run `pnpm build && node docs/media/src/capture.mjs`.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../../lib/proxy/config.js'
import { createProxyServer, listen } from '../../../lib/proxy/server.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))

const demo = execFileSync(process.execPath, ['bench/demo.mjs'], { cwd: root, encoding: 'utf8' })
  .trimEnd().split('\n')

// The fake upstream answers with the placeholders it received, in order.
let received = ''
let answered = ''
const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', part => { raw += part })
  req.on('end', () => {
    received = raw
    const ids = [...new Set(raw.match(/⟦[A-Z0-9_]+⟧/g) ?? [])]
    const find = category => ids.find(id => id.startsWith(`⟦${category}_`))
    const answer = `Done. I emailed the summary to ${find('EMAIL')}, revoked ${find('KEY')}, and ` +
      `${find('HOST')} (${find('IP')}) is back up. The log is still in ${find('PATH')}/deploy.log.`
    answered = answer
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (let i = 0; i < answer.length; i += 5) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer.slice(i, i + 5) }, finish_reason: null }] })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    res.end()
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))

const logs = []
const config = loadConfig(undefined, { REDACTION_PROXY_OPENAI_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` })
const proxy = createProxyServer(config, line => logs.push(line))
const port = await listen(proxy, 0)

const content = [
  'The deploy on build01.internal (10.0.4.17) failed again.',
  'Log: /Users/dana/deploy.log',
  'Revoke the key sk-proj-Fak3Ex4mpleKeyN0tReal00000000000000 and',
  'email a summary to dana.reyes@example.test.',
].join('\n')
const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer demo-key' },
  body: JSON.stringify({ model: 'demo', stream: true, messages: [{ role: 'user', content }] }),
})
const reply = (await res.text()).split('\n\n').filter(block => block.startsWith('data: {'))
  .map(block => JSON.parse(block.slice(6)).choices[0].delta.content ?? '').join('')
proxy.close()
upstream.close()

const example = {
  sent: content,
  upstream: JSON.parse(received).messages[0].content,
  upstreamReply: answered,
  reply,
  log: logs.at(-1),
}
writeFileSync(fileURLToPath(new URL('captured.json', import.meta.url)), `${JSON.stringify({ demo, example }, null, 2)}\n`)
console.log(JSON.stringify({ demo, example }, null, 2))
