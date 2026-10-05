/**
 * Checks that do not depend on what the model chose to say: nothing original
 * reached the upstream, and the client's reply equals the upstream's reply
 * with each placeholder replaced by one of the originals.
 *
 * @module e2e/real/verify
 */

const PLACEHOLDER = /⟦([A-Z][A-Z0-9]*_[1-9]\d*)⟧/g

/** Outcome of comparing the upstream's reply with the client's. */
export type RestoreVerdict =
  | { status: 'pass'; placeholders: number }
  | { status: 'fail'; reason: string }
  /** The model echoed no placeholder, so restoration was not exercised. */
  | { status: 'inconclusive'; reason: string }

/**
 * @param upstreamRequest - request body the upstream received.
 * @param originals - sensitive values of the client's request.
 * @returns the originals found in the body, verbatim or JSON-escaped.
 */
export function findLeakedOriginals(upstreamRequest: string, originals: readonly string[]): string[] {
  return originals.filter(original => upstreamRequest.includes(original) || upstreamRequest.includes(JSON.stringify(original).slice(1, -1)))
}

/**
 * Compare the client's reply with the upstream's: outside placeholders they
 * must be identical, every placeholder must have become an original, and
 * repeats of one placeholder must have become the same original.
 * @param upstreamReply - model output as the upstream sent it.
 * @param clientReply - model output as the proxy delivered it.
 * @param originals - sensitive values of the client's request.
 * @returns the verdict.
 */
export function verifyRestoration(upstreamReply: string, clientReply: string, originals: readonly string[]): RestoreVerdict {
  const placeholders = [...upstreamReply.matchAll(PLACEHOLDER)].length
  if (placeholders === 0) return { status: 'inconclusive', reason: 'the model echoed no placeholder' }
  if (!restoredReplyPattern(upstreamReply, originals).test(clientReply)) {
    return { status: 'fail', reason: 'the client reply is not the upstream reply with each placeholder replaced by an original' }
  }
  return { status: 'pass', placeholders }
}

/**
 * @param upstreamReply - model output with placeholders.
 * @param originals - values a placeholder may have been restored to.
 * @returns a pattern matching that output with the first occurrence of each placeholder replaced by any original and its repeats by the same one.
 */
function restoredReplyPattern(upstreamReply: string, originals: readonly string[]): RegExp {
  const anyOriginal = [...originals].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  const seen = new Set<string>()
  let source = ''
  let cursor = 0
  for (const match of upstreamReply.matchAll(PLACEHOLDER)) {
    source += escapeRegExp(upstreamReply.slice(cursor, match.index))
    const group = `p_${match[1]}`
    source += seen.has(group) ? `\\k<${group}>` : `(?<${group}>${anyOriginal})`
    seen.add(group)
    cursor = match.index + match[0].length
  }
  return new RegExp(`^${source}${escapeRegExp(upstreamReply.slice(cursor))}$`, 's')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
