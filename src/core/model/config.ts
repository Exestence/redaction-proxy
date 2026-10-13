/**
 * Configuration of the optional name model: where its files are, how its
 * scores are cut, and which spans it may never report.
 *
 * @module redaction-proxy/core/model/config
 */

import { isAbsolute } from 'node:path'
import { printable } from '../printable.ts'

/** Categories the name model can report, in placeholder-prefix form. */
export const NAME_MODEL_CATEGORIES = ['NAME', 'ORG', 'LOC', 'ADDR'] as const

/** One category the name model can report. */
export type NameModelCategory = typeof NAME_MODEL_CATEGORIES[number]

/**
 * Tool, product, and setting words the model reports as names or companies in
 * technical chat (measured: `Default`, `High`, `Low`, `フィールド` as NAME;
 * `Kafka`, `Podman`, `React` as ORG; `Admin` as LOC). Matched
 * case-insensitively against a whole span. Every value the model reports is
 * masked everywhere in the request, so a word missing here is masked
 * request-wide.
 */
export const DEFAULT_NAME_MODEL_ALLOWLIST: readonly string[] = [
  'Ansible', 'Apache', 'Bun', 'Chrome', 'Claude', 'Consul', 'Datadog', 'Debian', 'Deno', 'Django', 'Docker',
  'Elasticsearch', 'Envoy', 'Fedora', 'Figma', 'Firefox', 'Flask', 'GitHub', 'GitLab', 'Grafana', 'Helm', 'Jenkins',
  'Jira', 'Kafka', 'Kibana', 'Kubernetes', 'MongoDB', 'MySQL', 'Nginx', 'Notion', 'Ollama', 'Podman', 'Postgres',
  'PostgreSQL', 'Prometheus', 'RabbitMQ', 'React', 'Redis', 'Sentry', 'Slack', 'Terraform', 'Ubuntu', 'Vagrant',
  'Vercel', 'Vite', 'VS Code',
  'Default', 'High', 'Low', 'Medium', 'Off', 'On', 'None', 'Auto', 'Enabled', 'Disabled', 'Admin', 'フィールド',
]

/** Name-model configuration as written in the proxy config file. */
export interface NameModelConfig {
  /** Absolute path of the directory holding the model and tokenizer files. */
  dir: string
  /** Minimum summed probability of one category for a token to count; default 0.3. */
  threshold?: number
  /** Categories to report; default all four. */
  categories?: readonly NameModelCategory[]
  /** Tokens per forward pass, including the two special tokens; default 512. */
  windowTokens?: number
  /** Tokens two neighbouring windows share; default 128. Must be even. */
  windowOverlap?: number
  /** Whole-span literals never reported; replaces the default list. */
  allowlist?: readonly string[]
  /** Refuse a request with 503 when inference fails, instead of masking it with the rules only; default false. */
  required?: boolean
}

/** The name-model configuration after validation and defaulting. */
export interface ResolvedNameModelConfig {
  readonly dir: string
  readonly threshold: number
  readonly categories: readonly NameModelCategory[]
  readonly windowTokens: number
  readonly windowOverlap: number
  readonly allowlist: readonly string[]
  readonly required: boolean
}

const DEFAULTS = { threshold: 0.3, windowTokens: 512, windowOverlap: 128, required: false } as const

/** Longest input the model accepts (`max_position_embeddings`). */
const MODEL_MAX_TOKENS = 8192

/** BOS and EOS, which every window carries besides its text tokens. */
export const SPECIAL_TOKENS_PER_WINDOW = 2

const CONFIG_KEYS: ReadonlySet<string> = new Set(['dir', 'threshold', 'categories', 'windowTokens', 'windowOverlap', 'allowlist', 'required'])

/**
 * Fail one configuration check.
 * @param message - what is wrong, without the `nameModel` prefix.
 * @throws {Error} always.
 */
function invalid(message: string): never {
  throw new Error(`nameModel: ${message}`)
}

/**
 * Read one optional integer field.
 * @param value - configured value, or `undefined` for the default.
 * @param fallback - default value.
 * @param label - field name for the failure message.
 * @returns the integer.
 */
function integerField(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value)) invalid(`${label} must be an integer`)
  return value as number
}

/**
 * Validate the token window settings against each other and the model limit.
 * @param config - configured values.
 * @returns the window size and overlap.
 */
function resolveWindow(config: NameModelConfig): { windowTokens: number; windowOverlap: number } {
  const windowTokens = integerField(config.windowTokens, DEFAULTS.windowTokens, 'windowTokens')
  const windowOverlap = integerField(config.windowOverlap, DEFAULTS.windowOverlap, 'windowOverlap')
  if (windowTokens > MODEL_MAX_TOKENS) invalid(`windowTokens must be at most ${MODEL_MAX_TOKENS}`)
  // Each window drops half the overlap at each inner edge, so the overlap splits evenly.
  if (windowOverlap < 0 || windowOverlap % 2 !== 0) invalid('windowOverlap must be a non-negative even integer')
  if (windowTokens - SPECIAL_TOKENS_PER_WINDOW <= windowOverlap) {
    invalid(`windowTokens must exceed windowOverlap + ${SPECIAL_TOKENS_PER_WINDOW}`)
  }
  return { windowTokens, windowOverlap }
}

/**
 * Validate the reported categories.
 * @param value - configured value, or `undefined` for every category.
 * @returns the distinct categories in declaration order.
 */
function resolveCategories(value: unknown): NameModelCategory[] {
  if (value === undefined) return [...NAME_MODEL_CATEGORIES]
  if (!Array.isArray(value) || value.length === 0) invalid(`categories must be a non-empty array of ${NAME_MODEL_CATEGORIES.join(', ')}`)
  for (const category of value) {
    if (!NAME_MODEL_CATEGORIES.includes(category)) invalid(`unknown category ${printable(category)}`)
  }
  return NAME_MODEL_CATEGORIES.filter(category => value.includes(category))
}

/**
 * Validate the allowlist.
 * @param value - configured value, or `undefined` for the default list.
 * @returns the distinct literals.
 */
function resolveAllowlist(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_NAME_MODEL_ALLOWLIST]
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
    invalid('allowlist must be an array of non-blank strings')
  }
  return [...new Set(value as string[])]
}

/**
 * Validate and default the name-model configuration.
 * @param config - the `nameModel` block of the proxy configuration.
 * @returns the resolved configuration.
 * @throws {Error} on an unknown key or an invalid value.
 */
export function resolveNameModelConfig(config: unknown): ResolvedNameModelConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) invalid('must be an object')
  const input = config as NameModelConfig
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) invalid(`unknown key ${printable(key, 'key')}`)
  }
  if (typeof input.dir !== 'string' || !isAbsolute(input.dir)) invalid('dir must be an absolute path')
  const threshold = input.threshold ?? DEFAULTS.threshold
  if (typeof threshold !== 'number' || !(threshold > 0 && threshold < 1)) invalid('threshold must be a number between 0 and 1')
  const required = input.required ?? DEFAULTS.required
  if (typeof required !== 'boolean') invalid('required must be a boolean')
  return {
    dir: input.dir,
    threshold,
    categories: resolveCategories(input.categories),
    ...resolveWindow(input),
    allowlist: resolveAllowlist(input.allowlist),
    required,
  }
}
