/**
 * Drive the proxy against one real service: client → proxy → tee → service.
 * Each scenario checks that the service received placeholders only and that
 * the client got the service's reply back with every placeholder restored.
 *
 * @module e2e/real/harness
 */

import { loadConfig } from '../../src/proxy/config.ts'
import { createProxyServer, listen } from '../../src/proxy/server.ts'
import { ROUTES, authHeaders } from './providers.ts'
import type { Provider } from './providers.ts'
import { extractReplyText } from './replies.ts'
import { buildRequestBody, describeScenario, promptOf, scenariosFor, syntheticRecord } from './requests.ts'
import type { Scenario } from './requests.ts'
import { startTee } from './tee.ts'
import type { Tee } from './tee.ts'
import { findLeakedOriginals, mapPlaceholders, verifyRestoration } from './verify.ts'

/** Outcome of one scenario. */
export interface Outcome {
  status: 'pass' | 'fail' | 'inconclusive' | 'error'
  detail: string
}

/** Outcome of one scenario against one service. */
export interface CaseResult extends Outcome {
  provider: string
  scenario: string
}

/** One service behind a running proxy and tee. */
interface Rig {
  provider: Provider
  key: string
  model: string
  proxyUrl: string
  tee: Tee
}

const RECORD_SEED = 20261005
const ERROR_EXCERPT_LENGTH = 300
const REDACTED_KEY = '[key]'

/**
 * Run every scenario of one service through a fresh proxy and tee.
 * @param provider - the service.
 * @param env - environment holding the key and optional overrides.
 * @returns one result per scenario, or an empty list when the key is not set.
 */
export async function runProvider(provider: Provider, env: NodeJS.ProcessEnv): Promise<CaseResult[]> {
  const key = env[provider.keyVariable]
  if (key === undefined || key === '') return []
  const tee = await startTee(env[provider.baseUrlVariable] ?? provider.defaultBaseUrl)
  const proxy = createProxyServer(loadConfig(undefined, {
    REDACTION_PROXY_OPENAI_UPSTREAM: tee.url,
    REDACTION_PROXY_ANTHROPIC_UPSTREAM: tee.url,
  }), () => {})
  const rig: Rig = {
    provider,
    key,
    model: env[provider.modelVariable] ?? provider.defaultModel,
    proxyUrl: `http://127.0.0.1:${await listen(proxy, 0)}`,
    tee,
  }
  try {
    const results: CaseResult[] = []
    for (const scenario of scenariosFor(provider.apis)) {
      const outcome = await runScenario(rig, scenario).catch((error: unknown): Outcome =>
        ({ status: 'error', detail: excerptWithoutKey(String(error), key) }))
      results.push({ provider: provider.name, scenario: describeScenario(scenario), ...outcome })
    }
    return results
  } finally {
    proxy.close()
    await tee.close()
  }
}

async function runScenario(rig: Rig, scenario: Scenario): Promise<Outcome> {
  const record = syntheticRecord(RECORD_SEED)
  const requestBody = buildRequestBody(scenario, rig.model, record)
  const exchangesBefore = rig.tee.exchanges.length
  const response = await fetch(rig.proxyUrl + ROUTES[scenario.api], {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(rig.provider, rig.key) },
    body: JSON.stringify(requestBody),
  })
  const clientBody = await response.text()
  if (!response.ok) return { status: 'error', detail: `HTTP ${response.status}: ${excerptWithoutKey(clientBody, rig.key)}` }
  const exchange = rig.tee.exchanges[exchangesBefore]
  if (exchange === undefined) return { status: 'error', detail: 'the upstream received no request' }
  const leaked = findLeakedOriginals(exchange.requestBody, record.originals)
  if (leaked.length > 0) return { status: 'fail', detail: `${leaked.length} of ${record.originals.length} original values reached the upstream` }
  const placeholders = mapPlaceholders(
    promptOf(scenario.api, JSON.parse(exchange.requestBody) as Record<string, unknown>),
    promptOf(scenario.api, requestBody),
    record.originals,
  )
  if (placeholders === undefined) return { status: 'fail', detail: 'the upstream prompt is not the client prompt with each original replaced by a placeholder' }
  const verdict = verifyRestoration(
    extractReplyText(scenario.api, exchange.responseBody),
    extractReplyText(scenario.api, clientBody),
    placeholders,
  )
  return verdict.status === 'pass'
    ? { status: 'pass', detail: `upstream saw placeholders only; ${verdict.placeholders} placeholder(s) restored` }
    : { status: verdict.status, detail: verdict.reason }
}

/**
 * A run succeeds when no scenario failed or errored and at least one passed;
 * a run of only inconclusive scenarios verified no restoration.
 * @param results - every scenario of every service that ran.
 * @returns whether the run succeeded.
 */
export function isSuccessfulRun(results: readonly CaseResult[]): boolean {
  return results.some(result => result.status === 'pass')
    && results.every(result => result.status === 'pass' || result.status === 'inconclusive')
}

/**
 * @param body - an error body from the service, which may quote the key.
 * @param key - the key to remove.
 * @returns the start of the body with every occurrence of the key replaced.
 */
export function excerptWithoutKey(body: string, key: string): string {
  return body.replaceAll(key, REDACTED_KEY).slice(0, ERROR_EXCERPT_LENGTH)
}
