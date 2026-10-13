/**
 * Proxy configuration: a TOML or JSON file plus environment overrides. Keys never
 * come from the file; an upstream key may come from the environment as a
 * fallback for clients that send no credentials, and stays in memory.
 *
 * @module redaction-proxy/proxy/config
 */

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { TomlError, parse as parseToml } from 'smol-toml'
import { RULE_CATEGORIES, RULE_NAMES, resolveRulesConfig } from '../core/index.ts'
import type { RulesRedactionConfig } from '../core/index.ts'
import { NAME_MODEL_CATEGORIES, resolveNameModelConfig } from '../core/model/config.ts'
import type { ResolvedNameModelConfig } from '../core/model/config.ts'
import { printable } from '../core/printable.ts'

/** How a request string the rules cannot reason about is handled. */
export type ScreenMode = 'replace' | 'refuse'

/** Placeholder categories restored into one tool's call arguments; `'*'` restores every category. */
export type RestoredCategories = readonly string[] | '*'

/**
 * Which placeholder categories are restored into tool-call arguments. A
 * placeholder of any other category reaches the client as written, so a tool
 * the model was steered into calling cannot carry its original off the machine.
 */
export interface ToolRestorePolicy {
  /** Categories restored for a tool `tools` does not name; {@link DEFAULT_TOOL_RESTORE_CATEGORIES} by default. */
  categories: RestoredCategories
  /** Categories by tool name as {@link toolKey} writes it; each replaces `categories` for that tool. */
  tools: ReadonlyMap<string, RestoredCategories>
}

/**
 * The key a tool's name is looked up by in {@link ToolRestorePolicy.tools}, so `Bash` and `bash ` match `bash`.
 * @param name - a tool name from the configuration or a model reply.
 * @returns the name trimmed and lower-cased.
 */
export function toolKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Categories coding work needs back in tool calls: home paths and the literals the user listed, which name identifiers in code. */
export const DEFAULT_TOOL_RESTORE_CATEGORIES: readonly string[] = ['PATH', 'TERM', 'PROJECT']

/** Every category a placeholder can have. */
const CATEGORIES: readonly string[] = [...RULE_CATEGORIES, ...NAME_MODEL_CATEGORIES]

/** Validated proxy configuration. */
export interface ProxyConfig {
  /** TCP port. */
  port: number
  /**
   * Address to bind; `127.0.0.1` by default. Any address that is not loopback
   * requires `authToken`. The Docker image sets `0.0.0.0`.
   */
  host: string
  /**
   * Token every request must carry in the `x-redaction-proxy-token` header;
   * required when `host` is not loopback, optional otherwise. Never forwarded.
   */
  authToken?: string
  /**
   * Browser origins served besides loopback `http(s)` ones, as the exact
   * `Origin` header value, such as `app://client`; lower case, no trailing slash.
   */
  allowedOrigins: string[]
  /** Base URL that `/v1/chat/completions`, `/v1/responses`, and OpenAI-style GETs are forwarded to. */
  openaiUpstream: string
  /** Base URL that `/v1/messages` and Anthropic-style GETs are forwarded to. */
  anthropicUpstream: string
  /** Key sent upstream as `Authorization: Bearer` only when an OpenAI-style client sends none. */
  openaiApiKey?: string
  /** Key sent upstream as `x-api-key` only when an Anthropic-style client sends none. */
  anthropicApiKey?: string
  /** Rules detector configuration; `rules` defaults to {@link PROXY_DEFAULT_RULES}. */
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
  /** Which placeholder categories are restored into tool-call arguments. */
  toolRestore: ToolRestorePolicy
  /**
   * Seconds a value a client's request detected stays remembered for its later
   * requests, counted from the last request that detected it; 86400 (24 hours)
   * by default, 0 remembers nothing.
   */
  knownOriginalsTtlSeconds: number
  /**
   * Whether `loadConfig` added the local account's names ({@link localUsernames})
   * to `redaction.terms`; on by default.
   */
  maskLocalUsername: boolean
  /**
   * The names `loadConfig` added to `redaction.terms` that the file did not list in any ASCII case.
   * They are masked like terms but never refuse a request: a user name such as
   * `max` or `claude` also spells JSON keys (`max_tokens`) and model ids, which
   * the proxy does not rewrite.
   */
  localUsernames: string[]
  /**
   * When masking fails, send the request anyway instead of refusing it with
   * 422: the partly masked body when the leak scan finds a detected value
   * still present, the original body when masking throws. Off by default.
   */
  sendWhenMaskFails: boolean
}

/**
 * The proxy enables every built-in rule unless the file names its own, with
 * `card-strict` and `entropy-strict` in place of `card` and `entropy`. The
 * core's narrower default exists to keep the policy digest that hosts persist
 * with their span index; the proxy keeps no index, so its digest is never
 * compared. The strict variants leave no mask ending inside a digit group and
 * skip content digests keyed by a file name, which the default rules mask in
 * real diffs.
 */
export const PROXY_DEFAULT_RULES = RULE_NAMES.filter(rule => rule !== 'card' && rule !== 'entropy')

const FILE_KEYS = new Set([
  'port', 'host', 'authToken', 'allowedOrigins', 'openaiUpstream', 'anthropicUpstream', 'allowInsecureUpstream',
  'redaction', 'nameModel', 'screen', 'debugMasked', 'toolRestore', 'knownOriginalsTtlSeconds',
  'sendWhenMaskFails', 'maskLocalUsername',
])

/**
 * Account names too generic to mask as words: service and container defaults
 * (`node` in the official Node.js image, `runner` on GitHub Actions) and
 * words prose uses on its own.
 */
const GENERIC_USERNAMES = new Set([
  'admin', 'administrator', 'app', 'default', 'dev', 'docker', 'ec2-user', 'guest', 'node', 'nobody', 'root',
  'runner', 'runneradmin', 'test', 'ubuntu', 'user', 'vagrant',
])

/** The account a proxy runs as, as `os.userInfo()` reports it. */
export interface LocalUser {
  username: string
  homedir: string
}

/**
 * The names of the local account worth masking as terms: the user name and,
 * when it differs, the home directory's last segment. A name shorter than 3
 * characters or in {@link GENERIC_USERNAMES} (in any case) is skipped, as it
 * would mask ordinary words.
 * @param user - the local account.
 * @returns the names to add to `redaction.terms`.
 */
export function localUsernames(user: LocalUser): string[] {
  const names = [user.username, basename(user.homedir)].map(name => name.trim())
  return [...new Set(names)].filter(name => [...name].length >= 3 && !GENERIC_USERNAMES.has(name.toLowerCase()) && !/[⟦⟧]/.test(name))
}

/** Shortest `authToken` accepted; `openssl rand -hex 32` gives 64 characters. */
const AUTH_TOKEN_MIN = 16

/**
 * Whether a host name or address is loopback: `localhost`, `::1`, or `127.0.0.0/8`.
 * @param host - a host name, an IPv4 address, or an IPv6 address with or without brackets.
 * @returns whether it is loopback.
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Whether a value is a table: a TOML table, whose prototype is `null`, or a JSON object.
 * @param value - a parsed file value.
 * @returns whether it is a plain object; arrays, dates, and other instances are not.
 */
function isTable(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Read an optional table setting.
 * @param value - the file value.
 * @param label - setting name for the failure message.
 * @returns the table, or an empty one when absent.
 * @throws {Error} on a value that is not a table.
 */
function table(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isTable(value)) throw new Error(`${label} must be a table (a JSON object), not ${printable(value)}`)
  return value
}

/**
 * Read an optional boolean file setting.
 * @param value - the file value.
 * @param label - setting name for the failure message.
 * @returns the value, or `false` when absent.
 * @throws {Error} on a value that is not a boolean.
 */
function fileBoolean(value: unknown, label: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value === true
}

/**
 * Check one upstream base URL.
 * @param value - candidate URL.
 * @param label - setting name for the failure message.
 * @param allowInsecure - whether plain `http://` may reach a host that is not loopback.
 * @returns the URL without a trailing slash.
 * @throws {Error} when the value is not an http(s) URL, or sends keys in cleartext over the network.
 */
function upstream(value: unknown, label: string, allowInsecure: boolean): string {
  if (typeof value !== 'string' || !/^https?:\/\/[^/]/.test(value)) throw new Error(`${label} must be an http(s) URL`)
  if (!URL.canParse(value)) throw new Error(`${label} must be an http(s) URL`)
  if (value.startsWith('http:') && !allowInsecure && !isLoopbackHost(new URL(value).hostname)) {
    throw new Error(`${label} is plain http:// to a host that is not loopback, which would send API keys in cleartext; use https:// or set allowInsecureUpstream (REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM=1)`)
  }
  return value.replace(/\/+$/, '')
}

/**
 * Read `allowedOrigins`: a file array, or a comma-separated environment value.
 * @param value - the file value or the environment string.
 * @returns the origins in lower case without a trailing slash.
 * @throws {Error} on a value that is not `scheme://host[:port]`, including `null` and `*`.
 */
function allowedOrigins(value: unknown): string[] {
  const list = typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(item => item !== '') : value ?? []
  if (!Array.isArray(list)) throw new Error('allowedOrigins must be an array of origins')
  return list.map(origin => {
    const normal = typeof origin === 'string' ? origin.toLowerCase().replace(/\/$/, '') : ''
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/.test(normal)) {
      throw new Error('allowedOrigins entries must look like scheme://host[:port]; "null" (file:// pages, sandboxed frames) and "*" are not accepted')
    }
    return normal
  })
}

/**
 * Read one restored-category setting: a list, `"*"`, or a comma-separated environment value.
 * @param value - the file value or the environment string.
 * @param label - setting name for the failure message.
 * @returns the distinct categories, or `'*'`.
 * @throws {Error} on a value that is not a list of known categories or `"*"`.
 */
function restoredCategories(value: unknown, label: string): RestoredCategories {
  if (value === '*') return '*'
  const list = typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(item => item !== '') : value
  if (!Array.isArray(list)) throw new Error(`${label} must be an array of categories or "*"`)
  for (const category of list) {
    if (!CATEGORIES.includes(category)) throw new Error(`${label}: unknown category ${printable(category)}; valid: ${CATEGORIES.join(', ')}`)
  }
  return [...new Set(list as string[])]
}

/**
 * Read the `toolRestore` block; `REDACTION_PROXY_TOOL_RESTORE_CATEGORIES` overrides its `categories`.
 * @param value - the file's `toolRestore` value.
 * @param envCategories - the environment's default categories.
 * @returns the policy.
 * @throws {Error} on a value that is not a table, an unknown key, or an unknown category.
 */
function toolRestore(value: unknown, envCategories: string | undefined): ToolRestorePolicy {
  const { categories, tools, ...rest } = table(value, 'toolRestore')
  const [unknown] = Object.keys(rest)
  if (unknown !== undefined) throw new Error(`toolRestore: unknown key ${printable(unknown, 'key')}`)
  const byTool = new Map<string, RestoredCategories>()
  for (const [tool, list] of Object.entries(table(tools, 'toolRestore.tools'))) {
    const name = printable(tool, 'tool')
    if (byTool.has(toolKey(tool))) throw new Error(`toolRestore.tools: ${name} names a tool listed before; names match trimmed and in any case`)
    byTool.set(toolKey(tool), restoredCategories(list, `toolRestore.tools.${name.replace(/^"|"$/g, '')}`))
  }
  return {
    categories: restoredCategories(envCategories ?? categories ?? DEFAULT_TOOL_RESTORE_CATEGORIES, 'toolRestore.categories'),
    tools: byTool,
  }
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
  if (dir === undefined && value === undefined) return undefined
  const block = table(value, 'nameModel')
  return resolveNameModelConfig(dir === undefined ? block : { ...block, dir })
}

/**
 * Read a config file: `.toml` as TOML; `.json` or no extension (`/dev/stdin`)
 * as JSON. A failure message names the path and, for TOML, the line and
 * column, never the file's text.
 * @param path - a `.toml`, `.json`, or extensionless file.
 * @returns the file's top-level table.
 * @throws {Error} on another extension, an unreadable file, or a syntax error.
 */
function readConfigFile(path: string): Record<string, unknown> {
  const base = basename(path).toLowerCase()
  const format = base === '.toml' || base === '.json' ? base : extname(base) || '.json'
  if (format !== '.toml' && format !== '.json') throw new Error(`config ${path}: unsupported file extension; use .toml, .json, or none for JSON`)
  // TOML parsers skip a leading BOM; JSON.parse does not.
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  let file: unknown
  try {
    file = format === '.toml' ? parseToml(text) : JSON.parse(text)
  } catch (error) {
    // Both parsers quote the file's text in their messages, which may hold a token.
    if (error instanceof TomlError) throw new Error(`config ${path}:${error.line}:${error.column}: invalid TOML: ${error.message.split('\n')[0]?.replace(/^Invalid TOML document: /, '')}`)
    throw new Error(`config ${path}: invalid JSON`)
  }
  if (file === null || typeof file !== 'object' || Array.isArray(file)) throw new Error(`config ${path}: must hold an object`)
  return file as Record<string, unknown>
}

/**
 * Read an on/off environment variable, which overrides the file when set.
 * @param env - environment.
 * @param name - the variable.
 * @param fileValue - the file's validated value.
 * @returns `true` for `1`, `false` for `0`, `fileValue` when unset.
 * @throws {Error} on any other value.
 */
function envFlag(env: NodeJS.ProcessEnv, name: string, fileValue: boolean): boolean {
  const value = env[name]
  if (value !== undefined && value !== '1' && value !== '0') throw new Error(`${name} must be 1 or 0`)
  return value === undefined ? fileValue : value === '1'
}

/**
 * Load the configuration.
 * @param path - TOML or JSON config file, or `undefined` for none.
 * @param env - environment; `REDACTION_PROXY_*` variables override the file.
 * @param user - the account the proxy runs as, whose names are masked as terms unless `maskLocalUsername` is off; `undefined` adds none.
 * @returns the validated configuration.
 * @throws {Error} on an unreadable or unparsable file, an unsupported extension, an unknown key, or an invalid value.
 */
export function loadConfig(path: string | undefined, env: NodeJS.ProcessEnv, user?: LocalUser): ProxyConfig {
  const file = path === undefined ? {} : readConfigFile(path)
  for (const key of Object.keys(file)) {
    if (!FILE_KEYS.has(key)) throw new Error(`config: unknown key ${printable(key, 'key')}${/key|secret/i.test(key) ? ' (upstream API keys belong in the environment, not the file)' : ''}`)
  }
  const envPort = env.REDACTION_PROXY_PORT
  if (envPort !== undefined && !/^\d{1,5}$/.test(envPort)) throw new Error('REDACTION_PROXY_PORT must be a port number')
  if (file.port !== undefined && typeof file.port !== 'number') throw new Error('port must be an integer in 0..65535')
  const port = Number(envPort ?? file.port ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer in 0..65535')
  const host = env.REDACTION_PROXY_HOST ?? file.host ?? '127.0.0.1'
  if (typeof host !== 'string' || host === '') throw new Error('host must be a non-empty string')
  const authToken = env.REDACTION_PROXY_AUTH_TOKEN ?? file.authToken
  if (authToken !== undefined && (typeof authToken !== 'string' || authToken.length < AUTH_TOKEN_MIN)) {
    throw new Error(`authToken must be a string of at least ${AUTH_TOKEN_MIN} characters, such as the output of \`openssl rand -hex 32\``)
  }
  if (authToken === undefined && !isLoopbackHost(host)) {
    throw new Error(`host ${printable(host, 'host')} is not loopback, so an auth token is required: set REDACTION_PROXY_AUTH_TOKEN (or authToken) and have clients send it in x-redaction-proxy-token`)
  }
  const allowInsecure = envFlag(env, 'REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM', fileBoolean(file.allowInsecureUpstream, 'allowInsecureUpstream'))
  const screen = env.REDACTION_PROXY_SCREEN ?? file.screen ?? 'replace'
  if (screen !== 'replace' && screen !== 'refuse') throw new Error('screen must be "replace" or "refuse"')
  const envTtl = env.REDACTION_PROXY_KNOWN_ORIGINALS_TTL_SECONDS
  if (envTtl !== undefined && !/^\d+$/.test(envTtl)) throw new Error('REDACTION_PROXY_KNOWN_ORIGINALS_TTL_SECONDS must be a whole number of seconds')
  const knownOriginalsTtlSeconds = Number(envTtl ?? file.knownOriginalsTtlSeconds ?? 86400)
  if ((file.knownOriginalsTtlSeconds !== undefined && typeof file.knownOriginalsTtlSeconds !== 'number') || !Number.isSafeInteger(knownOriginalsTtlSeconds) || knownOriginalsTtlSeconds < 0) {
    throw new Error('knownOriginalsTtlSeconds must be a whole number of seconds, 0 or more')
  }
  const sendWhenMaskFails = envFlag(env, 'REDACTION_PROXY_SEND_WHEN_MASK_FAILS', fileBoolean(file.sendWhenMaskFails, 'sendWhenMaskFails'))
  const debugMasked = envFlag(env, 'REDACTION_PROXY_DEBUG_MASKED', fileBoolean(file.debugMasked, 'debugMasked'))
  const maskLocalUsername = envFlag(env, 'REDACTION_PROXY_MASK_LOCAL_USERNAME', fileBoolean(file.maskLocalUsername ?? true, 'maskLocalUsername'))
  const redaction = { rules: [...PROXY_DEFAULT_RULES], ...table(file.redaction, 'redaction') } as RulesRedactionConfig
  resolveRulesConfig(redaction)
  // A name listed as a term in any ASCII case stays a listed term, which the leak check refuses.
  const fold = (text: string): string => text.replace(/[A-Z]+/g, run => run.toLowerCase())
  const listed = new Set((redaction.terms ?? []).map(fold))
  const names = (maskLocalUsername && user !== undefined ? localUsernames(user) : []).filter(name => !listed.has(fold(name)))
  if (names.length > 0) redaction.terms = [...redaction.terms ?? [], ...names]
  const config: ProxyConfig = {
    port,
    host,
    allowedOrigins: allowedOrigins(env.REDACTION_PROXY_ALLOWED_ORIGINS ?? file.allowedOrigins),
    openaiUpstream: upstream(env.REDACTION_PROXY_OPENAI_UPSTREAM ?? file.openaiUpstream ?? 'https://api.openai.com', 'openaiUpstream', allowInsecure),
    anthropicUpstream: upstream(env.REDACTION_PROXY_ANTHROPIC_UPSTREAM ?? file.anthropicUpstream ?? 'https://api.anthropic.com', 'anthropicUpstream', allowInsecure),
    redaction,
    screen,
    debugMasked,
    toolRestore: toolRestore(file.toolRestore, env.REDACTION_PROXY_TOOL_RESTORE_CATEGORIES),
    knownOriginalsTtlSeconds,
    sendWhenMaskFails,
    maskLocalUsername,
    localUsernames: names,
  }
  const model = nameModel(file.nameModel, env.REDACTION_PROXY_NAME_MODEL_DIR)
  if (model !== undefined) config.nameModel = model
  if (authToken !== undefined) config.authToken = authToken
  if (env.REDACTION_PROXY_OPENAI_API_KEY) config.openaiApiKey = env.REDACTION_PROXY_OPENAI_API_KEY
  if (env.REDACTION_PROXY_ANTHROPIC_API_KEY) config.anthropicApiKey = env.REDACTION_PROXY_ANTHROPIC_API_KEY
  return config
}
