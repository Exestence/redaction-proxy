#!/usr/bin/env node
/**
 * Command line: `redaction-proxy [--config path]`, or `redaction-proxy --demo`
 * to run the keyless demo and exit. The config path may also
 * come from `REDACTION_PROXY_CONFIG`; `REDACTION_PROXY_*` variables override it.
 * A configured name model is loaded before the port opens, so a missing file
 * stops startup instead of failing the first request. SIGINT and SIGTERM
 * close the server and release the model before the process exits.
 *
 * @module redaction-proxy/cli
 */

import { parseArgs } from 'node:util'
import { loadNameModel } from './core/model/name-model.ts'
import { loadConfig } from './proxy/config.ts'
import { closeProxy, createProxyServer, listen } from './proxy/server.ts'

/**
 * Print a startup failure and exit.
 * @param error - the failure.
 */
function exitWith(error: unknown): never {
  console.error(`redaction-proxy: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { values } = parseArgs({ options: { config: { type: 'string', short: 'c' }, demo: { type: 'boolean' } } })
if (values.demo) {
  const { runDemo } = await import('./demo.ts')
  await runDemo()
  process.exit(0)
}
let config
try {
  config = loadConfig(values.config ?? process.env.REDACTION_PROXY_CONFIG, process.env)
} catch (error) {
  exitWith(error)
}
const nameModel = config.nameModel === undefined ? undefined : await loadNameModel(config.nameModel).catch(exitWith)
const server = createProxyServer(config, undefined, nameModel)
const port = await listen(server, config.port, config.host)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void closeProxy(server, nameModel))
}
const modelNote = nameModel === undefined ? '' : ', name model on (experimental)'
const tokenNote = config.authToken === undefined ? '' : ', x-redaction-proxy-token required'
const { categories } = config.toolRestore
const toolNote = `, tool arguments restore ${categories === '*' ? 'every category' : categories.join(', ') || 'no category'}${config.toolRestore.tools.size === 0 ? '' : ` (${config.toolRestore.tools.size} per-tool override(s))`}`
console.error(`redaction-proxy on http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port} -> openai ${config.openaiUpstream}, anthropic ${config.anthropicUpstream}${tokenNote}${modelNote}${toolNote}`)
