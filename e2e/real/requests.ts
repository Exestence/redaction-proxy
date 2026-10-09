/**
 * Synthetic prompts and request bodies for the real-service harness. Every
 * scenario asks the model to echo a line of synthetic personal data, as text
 * or as a forced tool call, so the reply carries the placeholders back.
 *
 * @module e2e/real/requests
 */

import { createRandom } from '../../bench/public/random.ts'
import { apiCredential, emailAddress, homeDirectory, nationalId, phoneNumber } from '../../bench/public/values.ts'
import type { WireApi } from './providers.ts'

/** One request shape to try against a service. */
export interface Scenario {
  api: WireApi
  stream: boolean
  toolCall: boolean
}

/** The synthetic line a scenario asks the model to echo, and the values in it. */
export interface SyntheticRecord {
  line: string
  originals: string[]
}

const TOOL_NAME = 'record_contact'
const TOOL_DESCRIPTION = 'Store one contact line.'
const TOOL_PARAMETERS = {
  type: 'object',
  properties: { line: { type: 'string', description: 'The contact line, verbatim.' } },
  required: ['line'],
}
const ANTHROPIC_MAX_TOKENS = 512

/**
 * @param apis - wire APIs the service offers.
 * @returns every combination of API, streaming, and tool call.
 */
export function scenariosFor(apis: readonly WireApi[]): Scenario[] {
  return apis.flatMap(api => [false, true].flatMap(stream => [false, true].map(toolCall => ({ api, stream, toolCall }))))
}

/**
 * @param scenario - the scenario.
 * @returns a short label such as `chat stream tool`.
 */
export function describeScenario(scenario: Scenario): string {
  return [scenario.api, scenario.stream ? 'stream' : 'json', scenario.toolCall ? 'tool' : 'text'].join(' ')
}

/**
 * Build a line of values the built-in rules mask: e-mail, Taiwan mobile and national ID, credential, home directory.
 * @param seed - random seed.
 * @returns the line and its sensitive values.
 */
export function syntheticRecord(seed: number): SyntheticRecord {
  const random = createRandom(seed)
  const originals = [
    emailAddress(random, 'en'),
    phoneNumber(random, 'zh-TW'),
    nationalId(random, 'zh-TW'),
    apiCredential(random),
    homeDirectory(random, 'en'),
  ]
  const [email, phone, id, key, home] = originals
  return { line: `Contact ${email}, phone ${phone}, ID ${id}, key ${key}, notes in ${home}/notes.md`, originals }
}

/**
 * @param scenario - the scenario.
 * @param model - model name.
 * @param record - the line to echo.
 * @returns the JSON request body for the scenario's wire API.
 */
export function buildRequestBody(scenario: Scenario, model: string, record: SyntheticRecord): Record<string, unknown> {
  const prompt = scenario.toolCall
    ? `Call ${TOOL_NAME} with "line" set to exactly the following text, unchanged:\n${record.line}`
    : `Repeat the following line exactly, character for character, and reply with nothing else:\n${record.line}`
  const tools = scenario.toolCall ? toolFields(scenario.api) : {}
  switch (scenario.api) {
    case 'chat': return { model, stream: scenario.stream, messages: [{ role: 'user', content: prompt }], ...tools }
    case 'responses': return { model, stream: scenario.stream, input: prompt, ...tools }
    case 'messages': return { model, stream: scenario.stream, max_tokens: ANTHROPIC_MAX_TOKENS, messages: [{ role: 'user', content: prompt }], ...tools }
  }
}

function toolFields(api: WireApi): Record<string, unknown> {
  switch (api) {
    case 'chat': return {
      tools: [{ type: 'function', function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS } }],
      tool_choice: { type: 'function', function: { name: TOOL_NAME } },
    }
    case 'responses': return {
      tools: [{ type: 'function', name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS }],
      tool_choice: { type: 'function', name: TOOL_NAME },
    }
    case 'messages': return {
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: TOOL_PARAMETERS }],
      tool_choice: { type: 'tool', name: TOOL_NAME },
    }
  }
}

/**
 * @param api - wire API of the request.
 * @param body - a request body that {@link buildRequestBody} built, before or after the proxy masked it.
 * @returns the user prompt in it.
 * @throws {Error} when the body holds no prompt string.
 */
export function promptOf(api: WireApi, body: Record<string, unknown>): string {
  const prompt = api === 'responses' ? body.input : (body.messages as { content?: unknown }[] | undefined)?.[0]?.content
  if (typeof prompt !== 'string') throw new Error(`the ${api} request holds no prompt string`)
  return prompt
}
