/**
 * Real LLM services the harness can drive, and the wire APIs each one speaks.
 * Keys come only from the environment; every other setting has a default
 * that an `E2E_*` variable overrides.
 *
 * @module e2e/real/providers
 */

/** Request format a scenario is sent in. */
export type WireApi = 'chat' | 'responses' | 'messages'

/** Proxy route of each wire API. */
export const ROUTES: Readonly<Record<WireApi, string>> = {
  chat: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
}

/** One real service. */
export interface Provider {
  name: string
  /** Environment variable that holds the API key. */
  keyVariable: string
  /** Environment variable that overrides `defaultBaseUrl`. */
  baseUrlVariable: string
  defaultBaseUrl: string
  /** Environment variable that overrides `defaultModel`. */
  modelVariable: string
  defaultModel: string
  /** Wire APIs the service offers. */
  apis: readonly WireApi[]
  /** How the service expects the key. */
  auth: 'bearer' | 'anthropic'
}

/** Services the harness knows, in run order. */
export const PROVIDERS: readonly Provider[] = [
  {
    name: 'openai',
    keyVariable: 'OPENAI_API_KEY',
    baseUrlVariable: 'E2E_OPENAI_UPSTREAM',
    defaultBaseUrl: 'https://api.openai.com',
    modelVariable: 'E2E_OPENAI_MODEL',
    defaultModel: 'gpt-4.1-mini',
    apis: ['chat', 'responses'],
    auth: 'bearer',
  },
  {
    name: 'anthropic',
    keyVariable: 'ANTHROPIC_API_KEY',
    baseUrlVariable: 'E2E_ANTHROPIC_UPSTREAM',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelVariable: 'E2E_ANTHROPIC_MODEL',
    defaultModel: 'claude-haiku-4-5',
    apis: ['messages'],
    auth: 'anthropic',
  },
  {
    name: 'deepseek',
    keyVariable: 'DEEPSEEK_API_KEY',
    baseUrlVariable: 'E2E_DEEPSEEK_UPSTREAM',
    defaultBaseUrl: 'https://api.deepseek.com',
    modelVariable: 'E2E_DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    apis: ['chat'],
    auth: 'bearer',
  },
]

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * @param provider - the service.
 * @param key - its API key.
 * @returns the headers a client sends with the key.
 */
export function authHeaders(provider: Provider, key: string): Record<string, string> {
  return provider.auth === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    : { authorization: `Bearer ${key}` }
}
