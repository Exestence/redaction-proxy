/**
 * Send a scenario through an official SDK instead of `fetch`: the `openai`
 * package for Chat Completions and Responses, `@anthropic-ai/sdk` for
 * Anthropic Messages. The SDK's parsed reply is written back as JSON, or as
 * `data:` events for a stream, so the harness reads it like a raw body.
 *
 * @module e2e/real/sdk
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Provider, WireApi } from './providers.ts'

/** How the harness sends requests: raw `fetch` (the default) or the official SDKs. */
export type ClientKind = 'fetch' | 'sdk'

/**
 * @param value - the `E2E_CLIENT` variable.
 * @returns the client kind it names.
 * @throws {Error} when it names neither `fetch` nor `sdk`.
 */
export function parseClientKind(value: string | undefined): ClientKind {
  if (value === undefined || value === '' || value === 'fetch') return 'fetch'
  if (value === 'sdk') return 'sdk'
  throw new Error(`E2E_CLIENT must be fetch or sdk, not ${JSON.stringify(value)}`)
}

/**
 * @param provider - the service; `anthropic` auth selects the Anthropic SDK.
 * @param api - wire API of the scenario.
 * @param proxyUrl - the proxy's base URL.
 * @param key - API key the SDK sends.
 * @param body - request body from `buildRequestBody`; the SDKs' parameter types are not built here, so it is untyped.
 * @returns the reply as the SDK parsed it, serialized as JSON or as `data:` events.
 * @throws the SDK's error on a non-2xx reply.
 */
// Request bodies are untyped JSON built by requests.ts.
export async function sendWithSdk(provider: Provider, api: WireApi, proxyUrl: string, key: string, body: Record<string, any>): Promise<string> {
  if (provider.auth === 'anthropic') {
    const client = new Anthropic({ apiKey: key, baseURL: proxyUrl, maxRetries: 0 })
    return serialize(await client.messages.create(body as Anthropic.MessageCreateParams))
  }
  const client = new OpenAI({ apiKey: key, baseURL: `${proxyUrl}/v1`, maxRetries: 0 })
  return serialize(api === 'responses'
    ? await client.responses.create(body as OpenAI.Responses.ResponseCreateParams)
    : await client.chat.completions.create(body as OpenAI.Chat.ChatCompletionCreateParams))
}

async function serialize(result: object): Promise<string> {
  if (!(Symbol.asyncIterator in result)) return JSON.stringify(result)
  let events = ''
  for await (const event of result as AsyncIterable<unknown>) events += `data: ${JSON.stringify(event)}\n\n`
  return events
}
