#!/usr/bin/env node
/**
 * Command line: `node lib/cli.js [--config path]`. The config path may also
 * come from `REDACTION_PROXY_CONFIG`; `REDACTION_PROXY_*` variables override it.
 *
 * @module redaction-proxy/cli
 */

import { parseArgs } from 'node:util'
import { loadConfig } from './proxy/config.ts'
import { createProxyServer, listen } from './proxy/server.ts'

const { values } = parseArgs({ options: { config: { type: 'string', short: 'c' } } })
let config
try {
  config = loadConfig(values.config ?? process.env.REDACTION_PROXY_CONFIG, process.env)
} catch (error) {
  console.error(`redaction-proxy: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const port = await listen(createProxyServer(config), config.port)
console.error(`redaction-proxy on http://127.0.0.1:${port} -> openai ${config.openaiUpstream}, anthropic ${config.anthropicUpstream}`)
