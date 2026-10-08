/**
 * Value propagation: once a rule has found a value somewhere, every other
 * occurrence of that value is masked with the same identity. The index is a
 * code-unit trie for short values and a scan for long ones; a single
 * alternation pattern over the values took 18.3 seconds and exhausted memory
 * on 5000 addresses.
 *
 * @module redaction-proxy/core/rules/propagate
 */

import type { Candidate } from './candidate.ts'
import { PRIORITY_EXACT, mergeCandidates } from './candidate.ts'
import { hasFreeEdges } from './rules.ts'
import { isPropagatableValue } from './secret.ts'

/** Longest value the trie holds; longer values are found with `indexOf` instead. */
const TRIE_MAX = 64

/** One further occurrence of an already-detected value, naming its text by index. */
export interface PropagatedRange {
  /** Index into the submitted `texts` array. */
  text: number
  /** Inclusive UTF-16 start offset. */
  start: number
  /** Exclusive UTF-16 end offset. */
  end: number
  /** Category of the value's placeholder identity. */
  category: string
}

/** One node of the code-unit trie. */
interface TrieNode {
  /** Child nodes by UTF-16 code unit. */
  next: Map<number, TrieNode>
  /** The value ending at this node, when one does. */
  value?: string
}

/**
 * Build a code-unit trie over the values.
 * @param values - values to index.
 * @returns the trie root.
 */
function buildTrie(values: readonly string[]): TrieNode {
  const root: TrieNode = { next: new Map() }
  for (const value of values) {
    let node = root
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i)
      let next = node.next.get(code)
      if (next === undefined) {
        next = { next: new Map() }
        node.next.set(code, next)
      }
      node = next
    }
    node.value = value
  }
  return root
}

/**
 * Find every further occurrence of an already-detected value.
 * @param texts - every submitted text, in submission order.
 * @param values - each bound original mapped to its category.
 * @returns disjoint ranges, in text order and then in start order.
 */
export function propagateValues(
  texts: readonly string[],
  values: ReadonlyMap<string, string>,
): PropagatedRange[] {
  const indexed: string[] = []
  const long: string[] = []
  for (const [value, category] of values) {
    if (!isPropagatableValue(value, category)) continue
    if (value.length <= TRIE_MAX) indexed.push(value)
    else long.push(value)
  }
  const found: PropagatedRange[] = []
  if (indexed.length === 0 && long.length === 0) return found
  const root = indexed.length === 0 ? undefined : buildTrie(indexed)

  for (const [at, text] of texts.entries()) {
    const candidates: Candidate[] = []
    const take = (start: number, value: string): void => {
      const end = start + value.length
      if (!hasFreeEdges(text, start, end, value)) return
      // oxlint-disable-next-line typescript/no-non-null-assertion -- `value` came from `values`.
      candidates.push({ start, end, category: values.get(value)!, priority: PRIORITY_EXACT })
    }
    if (root !== undefined) {
      for (let i = 0; i < text.length; i += 1) {
        let node = root.next.get(text.charCodeAt(i))
        if (node === undefined) continue
        let best: string | undefined
        let depth = 1
        for (;;) {
          if (node.value !== undefined) best = node.value
          const next = node.next.get(text.charCodeAt(i + depth))
          if (next === undefined) break
          node = next
          depth += 1
        }
        if (best !== undefined) take(i, best)
      }
    }
    for (const value of long) {
      for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + 1)) take(start, value)
    }
    // Two values that share a non-alphanumeric edge overlap partially. Keeping
    // the first and dropping the second would send the second value's tail
    // verbatim, so the union of the overlap is masked instead.
    for (const merged of mergeCandidates(candidates)) {
      found.push({ text: at, start: merged.start, end: merged.end, category: merged.category })
    }
  }
  return found
}
