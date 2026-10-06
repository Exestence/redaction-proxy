/**
 * Reply text extraction. The same function reads the upstream's reply (from
 * the tee) and the client's reply (from the proxy), so the two can be
 * compared placeholder for placeholder.
 *
 * @module e2e/real/replies
 */

import type { WireApi } from './providers.ts'

// Provider responses are untyped JSON read field by field with optional chaining.
type Json = Record<string, any>

const SSE_DATA_PREFIX = /^data: ?/

/**
 * Concatenate every piece of model output in a response: message text and tool-call arguments, in arrival order.
 * @param api - wire API of the response.
 * @param body - raw response body, JSON or server-sent events.
 * @returns the model output as one string.
 */
export function extractReplyText(api: WireApi, body: string): string {
  return isEventStream(body)
    ? parseEvents(body).map(event => streamEventText(api, event)).join('')
    : messageText(api, JSON.parse(body) as Json)
}

function isEventStream(body: string): boolean {
  return /^(event|data):/.test(body.trimStart())
}

function parseEvents(body: string): Json[] {
  return body.split(/\r?\n/)
    .filter(line => SSE_DATA_PREFIX.test(line))
    .map(line => line.replace(SSE_DATA_PREFIX, ''))
    .filter(data => data.startsWith('{'))
    .map(data => JSON.parse(data) as Json)
}

function messageText(api: WireApi, response: Json): string {
  switch (api) {
    case 'chat': return chatChoicesText(response, 'message')
    case 'responses': return (response.output ?? []).map((item: Json) => item.type === 'function_call'
      ? item.arguments ?? ''
      : (item.content ?? []).map((part: Json) => part.text ?? '').join('')).join('')
    case 'messages': return (response.content ?? []).map((block: Json) => block.type === 'tool_use'
      ? JSON.stringify(block.input)
      : block.text ?? '').join('')
  }
}

function streamEventText(api: WireApi, event: Json): string {
  switch (api) {
    case 'chat': return chatChoicesText(event, 'delta')
    case 'responses': return event.type === 'response.output_text.delta' || event.type === 'response.function_call_arguments.delta'
      ? event.delta ?? ''
      : ''
    case 'messages': return event.type === 'content_block_delta' ? event.delta?.text ?? event.delta?.partial_json ?? '' : ''
  }
}

/** Chat Completions puts the same fields under `message` in a JSON response and under `delta` in a stream event. */
function chatChoicesText(response: Json, field: 'message' | 'delta'): string {
  return (response.choices ?? []).map((choice: Json) =>
    (choice[field]?.content ?? '') + (choice[field]?.tool_calls ?? []).map((call: Json) => call.function?.arguments ?? '').join('')).join('')
}
