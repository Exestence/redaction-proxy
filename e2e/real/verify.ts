/**
 * Checks that do not depend on what the model chose to say: nothing original
 * reached the upstream, and the client's reply equals the upstream's reply
 * with each placeholder replaced by the original it stood for in the request.
 *
 * @module e2e/real/verify
 */

const PLACEHOLDER = /⟦([A-Z][A-Z0-9]*_[1-9]\d*)⟧/g
const GROUP_PREFIX = 'p_'

/** Placeholder id (such as `EMAIL_1`) → the original value it stands for. */
export type PlaceholderMap = ReadonlyMap<string, string>

/** Outcome of comparing the upstream's reply with the client's. */
export type RestoreVerdict =
  | { status: 'pass'; placeholders: number }
  | { status: 'fail'; reason: string }
  /** The model echoed no placeholder of the request, so restoration was not exercised. */
  | { status: 'inconclusive'; reason: string }

/**
 * @param upstreamRequest - request body the upstream received.
 * @param originals - sensitive values of the client's request.
 * @returns the originals found in the body, verbatim or JSON-escaped, including `\uXXXX` escapes.
 */
export function findLeakedOriginals(upstreamRequest: string, originals: readonly string[]): string[] {
  const bodies = [upstreamRequest, canonicalJson(upstreamRequest)]
  return originals.filter(original =>
    bodies.some(body => body.includes(original) || body.includes(JSON.stringify(original).slice(1, -1))))
}

/**
 * Re-serialize JSON so every `\uXXXX` escape of a printable character becomes the character itself.
 * @param body - a request body.
 * @returns the canonical serialization, or the body unchanged when it is not JSON.
 */
function canonicalJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body))
  } catch {
    // A body that is not JSON has no escapes to undo; the raw check covers it.
    return body
  }
}

/**
 * Pair each placeholder of the masked prompt with the original it replaced.
 * @param maskedPrompt - prompt as the upstream received it.
 * @param clientPrompt - prompt as the client sent it.
 * @param originals - sensitive values of the client's prompt.
 * @returns the pairs, or `undefined` when the masked prompt is not the client prompt with originals replaced by placeholders.
 */
export function mapPlaceholders(maskedPrompt: string, clientPrompt: string, originals: readonly string[]): PlaceholderMap | undefined {
  const groups = restoredTextPattern(maskedPrompt, originals).exec(clientPrompt)?.groups
  if (groups === undefined) return undefined
  return new Map(Object.entries(groups).map(([group, original]) => [group.slice(GROUP_PREFIX.length), original]))
}

/**
 * Compare the client's reply with the upstream's: the client's reply must be
 * the upstream's with every placeholder of the request replaced by its own
 * original. A placeholder the model invented stays as written.
 * @param upstreamReply - model output as the upstream sent it.
 * @param clientReply - model output as the proxy delivered it.
 * @param placeholders - what each placeholder of the request stands for.
 * @returns the verdict.
 */
export function verifyRestoration(upstreamReply: string, clientReply: string, placeholders: PlaceholderMap): RestoreVerdict {
  const echoed = [...upstreamReply.matchAll(PLACEHOLDER)].filter(match => placeholders.has(match[1] ?? '')).length
  if (echoed === 0) return { status: 'inconclusive', reason: 'the model echoed no placeholder of the request' }
  const expected = upstreamReply.replace(PLACEHOLDER, (placeholder, id: string) => placeholders.get(id) ?? placeholder)
  if (clientReply !== expected) {
    return { status: 'fail', reason: 'the client reply is not the upstream reply with each placeholder replaced by its original' }
  }
  return { status: 'pass', placeholders: echoed }
}

/**
 * @param maskedText - text with placeholders.
 * @param originals - values a placeholder may stand for.
 * @returns a pattern matching that text with the first occurrence of each placeholder replaced by any original, captured, and its repeats by the same one.
 */
function restoredTextPattern(maskedText: string, originals: readonly string[]): RegExp {
  const anyOriginal = [...originals].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  const seen = new Set<string>()
  let source = ''
  let cursor = 0
  for (const match of maskedText.matchAll(PLACEHOLDER)) {
    source += escapeRegExp(maskedText.slice(cursor, match.index))
    const group = `${GROUP_PREFIX}${match[1]}`
    source += seen.has(group) ? `\\k<${group}>` : `(?<${group}>${anyOriginal})`
    seen.add(group)
    cursor = match.index + match[0].length
  }
  return new RegExp(`^${source}${escapeRegExp(maskedText.slice(cursor))}$`, 's')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
