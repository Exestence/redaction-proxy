/**
 * The candidate range every rule pass produces, and the overlap resolution the
 * provider applies before it returns detections. The base service resolves
 * overlaps by start order, which would let an entropy or address range that
 * begins earlier displace the credential range that covers it, so the provider
 * resolves them here instead.
 *
 * @module redaction-proxy/core/rules/candidate
 */

/** Configured literal value; it wins every overlap. */
export const PRIORITY_EXACT = 0
/** Credential rule. */
export const PRIORITY_SECRET = 1
/** Structured personal data: paths, addresses, numbers, hosts. */
export const PRIORITY_PII = 2
/** Configured term or project name. */
export const PRIORITY_TERM = 3
/** High-entropy run with no other evidence. */
export const PRIORITY_ENTROPY = 4

/** One range a rule pass proposes. */
export interface Candidate {
  /** Inclusive UTF-16 start offset. */
  start: number
  /** Exclusive UTF-16 end offset. */
  end: number
  /** Placeholder category of the range. */
  category: string
  /** Rule priority; the lower number wins an overlap of equal length. */
  priority: number
}

/**
 * Sink a rule pass reports one range to.
 * @param start - inclusive UTF-16 start offset.
 * @param end - exclusive UTF-16 end offset.
 * @param category - placeholder category.
 * @param priority - rule priority.
 */
export type PushCandidate = (start: number, end: number, category: string, priority: number) => void

/**
 * Resolve overlapping candidates into disjoint ranges. Candidates that overlap
 * transitively form one range covering all of them, whose category comes from
 * the longest candidate, then from the lowest priority, then from the one that
 * starts earliest. Proposal order decides only between candidates that share
 * both offsets, because the group is sorted by start and end first.
 * @param candidates - ranges from every rule pass of one text, in any order.
 * @returns disjoint ranges in start order.
 */
export function mergeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const ordered = [...candidates].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Candidate[] = []
  let group: Candidate[] = []
  let start = -1
  let end = -1
  const flush = (): void => {
    if (group.length === 0) return
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the group is not empty.
    let winner = group[0]!
    for (const candidate of group) {
      const size = candidate.end - candidate.start
      const best = winner.end - winner.start
      if (size > best || (size === best && candidate.priority < winner.priority)) winner = candidate
    }
    merged.push({ start, end, category: winner.category, priority: winner.priority })
    group = []
  }
  for (const candidate of ordered) {
    if (group.length > 0 && candidate.start < end) {
      group.push(candidate)
      end = Math.max(end, candidate.end)
      continue
    }
    flush()
    group = [candidate]
    start = candidate.start
    end = candidate.end
  }
  flush()
  return merged
}
