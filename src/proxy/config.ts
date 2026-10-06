/**
 * Proxy configuration: a JSON file plus environment overrides. Keys never
 * come from the file; an upstream key may come from the environment as a
 * fallback for clients that send no credentials, and stays in memory.
 *
 * @module redaction-proxy/proxy/config
 */

import { readFileSync } from 'node:fs'
import { resolveRulesConfig } from '../core/index.ts'
import type { RulesRedactionConfig } from '../core/index.ts'
import { resolveNameModelConfig } from '../core/model/config.ts'
import type { ResolvedNameModelConfig } from '../core/model/config.ts'

/** How a request string the rules cannot reason about is handled. */
export type ScreenMode = 'replace' | 'refuse'

/** Validated proxy configuration. */
export interface ProxyConfig {
  /** TCP port on 127.0.0.1. */
  port: number
  /** Base URL that `/v1/chat/completions`, `/v1/responses`, and OpenAI-style GETs are forwarded to. */
  openaiUpstream: string
  /** Base URL that `/v1/messages` and Anthropic-style GETs are forwarded to. */
  anthropicUpstream: string
  /** Key sent upstream as `Authorization: Bearer` only when an OpenAI-style client sends none. */
  openaiApiKey?: string
  /** Key sent upstream as `x-api-key` only when an Anthropic-style client sends none. */
  anthropicApiKey?: string
  /** Rules detector configuration. */
  redaction: RulesRedactionConfig
  /** Optional name model; absent means rules only. */
  nameModel?: ResolvedNameModelConfig
  /**
   * `replace` (default) rewrites control characters, U+FFFD, lone surrogates,
   * and pre-existing `⟦`/`⟧` in request text to visible stand-ins before
   * masking; `refuse` rejects the request with 422 instead.
   */
  screen: ScreenMode
  /** Log each masked request body. Masked text only; off by default. */
  debugMasked: boolean
}

const FILE_KEYS = new Set(['port', 'openaiUpstream', 'anthropicUpstream', 'redaction', 'nameModel', 'screen', 'debugMasked'])

/**
 * Check one upstream base URL.
 * @param value - candidate URL.
 * @param label - setting name for the failure message.
 * @returns the URL without a trailing slash.
 * @throws {Error} when the value is not an http(s) URL.
 */
function upstream(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^https?:\/\/[^/]/.test(value)) throw new Error(`${label} must be an http(s) URL`)
  return value.replace(/\/+$/, '')
}

/**
 * Read the optional name-model block; `REDACTION_PROXY_NAME_MODEL_DIR` sets
 * its directory and so turns it on.
 * @param value - the file's `nameModel` value.
 * @param dir - the environment's model directory.
 * @returns the resolved block, or `undefined` when the model is off.
 * @throws {Error} on an invalid block.
 */
function nameModel(value: unknown, dir: string | undefined): ResolvedNameModelConfig | undefined {
  if (dir === undefined) return value === undefined ? undefined : resolveNameModelConfig(value)
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('nameModel: must be an object')
  return resolveNameModelConfig({ ...value, dir })
}

/**
 * Load the configuration.
 * @param path - JSON config file, or `undefined` for none.
 * @param env - environment; `REDACTION_PROXY_*` variables override the file.
 * @returns the validated configuration.
 * @throws {Error} on an unreadable file, an unknown key, or an invalid value.
 */
export function loadConfig(path: string | undefined, env: NodeJS.ProcessEnv): ProxyConfig {
  const file: Record<string, unknown> = path === undefined ? {} : JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  for (const key of Object.keys(file)) {
    if (!FILE_KEYS.has(key)) throw new Error(`config: unknown key "${key}"${/key|token|secret/i.test(key) ? ' (keys belong in the environment, not the file)' : ''}`)
  }
  const port = Number(env.REDACTION_PROXY_PORT ?? file.port ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer in 0..65535')
  const screen = env.REDACTION_PROXY_SCREEN ?? file.screen ?? 'replace'
  if (screen !== 'replace' && screen !== 'refuse') throw new Error('screen must be "replace" or "refuse"')
  const redaction = (file.redaction ?? {}) as RulesRedactionConfig
  resolveRulesConfig(redaction)
  const config: ProxyConfig = {
    port,
    openaiUpstream: upstream(env.REDACTION_PROXY_OPENAI_UPSTREAM ?? file.openaiUpstream ?? 'https://api.openai.com', 'openaiUpstream'),
    anthropicUpstream: upstream(env.REDACTION_PROXY_ANTHROPIC_UPSTREAM ?? file.anthropicUpstream ?? 'https://api.anthropic.com', 'anthropicUpstream'),
    redaction,
    screen,
    debugMasked: env.REDACTION_PROXY_DEBUG_MASKED === '1' || file.debugMasked === true,
  }
  const model = nameModel(file.nameModel, env.REDACTION_PROXY_NAME_MODEL_DIR)
  if (model !== undefined) config.nameModel = model
  if (env.REDACTION_PROXY_OPENAI_API_KEY) config.openaiApiKey = env.REDACTION_PROXY_OPENAI_API_KEY
  if (env.REDACTION_PROXY_ANTHROPIC_API_KEY) config.anthropicApiKey = env.REDACTION_PROXY_ANTHROPIC_API_KEY
  return config
}
