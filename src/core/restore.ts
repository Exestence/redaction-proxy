/**
 * Lenient restoration for a byte stream the caller cannot retry: a model
 * reply relayed chunk by chunk. Unlike the strict {@link restore} of the
 * engine, it never fails: an identity the registry does not bind stays as its
 * literal placeholder, and a delimiter that does not form a placeholder is
 * passed through as text.
 *
 * @module redaction-proxy/core/restore
 */

import { TextCursor } from './cursor.ts'
import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN, REDACTION_ID_PATTERN } from './engine.ts'
import type { RedactionId, RedactionRegistry } from './types.ts'

/** Longest held tail after an opening delimiter before it is released as text. */
const HELD_MAX = 64

/** Text that can still grow into a `CATEGORY_n` identity. */
const ID_PREFIX = /^(?:[A-Z][A-Z0-9]*(?:_(?:[1-9]\d*)?)?)?$/

/** Options of {@link createStreamRestorer}. */
export interface StreamRestoreOptions {
  /**
   * Write each original as the body of a JSON string literal, for streams of
   * JSON text such as tool-call arguments, where a placeholder only occurs
   * inside a string literal and a raw quote or newline would break the JSON.
   */
  json?: boolean
  /**
   * Leave a bound placeholder as written when it sits inside a URL, as
   * {@link TextCursor} defines it, in the text restored so far. For tool-call
   * arguments: a URL the client fetches would carry the original to its host.
   */
  keepInUrls?: boolean
  /** Receives each bound placeholder after it is restored or kept; never the original. */
  onPlaceholder?: (event: PlaceholderEvent) => void
}

/** One bound placeholder met by a restorer. */
export interface PlaceholderEvent {
  id: RedactionId
  /** `false` when it was kept as written because it sat inside a URL. */
  restored: boolean
  /** JSON pointer segments where it sat; `undefined` for a key; empty for plain text. */
  path: Array<string | number | undefined>
}

/** Incremental restorer for one stream of text. */
export interface StreamRestorer {
  /**
   * Accept the next chunk.
   * @param chunk - next part of the masked stream.
   * @returns restored text that is now final; a possible placeholder prefix is held back.
   */
  push(chunk: string): string
  /**
   * Close the stream.
   * @returns the held tail as text; empty when nothing is held.
   */
  end(): string
  /** Number of placeholders replaced so far. */
  readonly restored: number
  /** Number of well-formed placeholders the registry does not bind. */
  readonly unknown: number
  /** Number of bound placeholders kept as written by `keepInUrls`. */
  readonly kept: number
}

/**
 * Create a restorer for one stream. Only an opening delimiter followed by text
 * that can still become `CATEGORY_n⟧` is held, at most {@link HELD_MAX} code
 * units; everything before it is returned at once.
 * @param registry - bindings of the mask call that produced the request.
 * @param options - output encoding of originals.
 * @returns the restorer.
 */
export function createStreamRestorer(registry: RedactionRegistry, options: StreamRestoreOptions = {}): StreamRestorer {
  let held = ''
  let restored = 0
  let unknown = 0
  let kept = 0
  const encode = options.json === true
    ? (value: string): string => JSON.stringify(value).slice(1, -1)
    : (value: string): string => value
  const cursor = options.keepInUrls === true || options.onPlaceholder !== undefined ? new TextCursor(options.json === true) : undefined
  let out = ''
  const emit = (text: string): void => {
    out += text
    cursor?.feed(text)
  }
  return {
    get restored() {
      return restored
    },
    get unknown() {
      return unknown
    },
    get kept() {
      return kept
    },
    push(chunk) {
      held += chunk
      out = ''
      for (;;) {
        const open = held.indexOf(PLACEHOLDER_OPEN)
        if (open < 0) {
          emit(held)
          held = ''
          return out
        }
        emit(held.slice(0, open))
        held = held.slice(open)
        const close = held.indexOf(PLACEHOLDER_CLOSE, 1)
        const body = held.slice(1, close < 0 ? undefined : close)
        if (close < 0) {
          // Still possibly a placeholder: wait for more text.
          if (held.length <= HELD_MAX && ID_PREFIX.test(body)) return out
          emit(PLACEHOLDER_OPEN)
          held = held.slice(1)
          continue
        }
        if (!REDACTION_ID_PATTERN.test(body)) {
          emit(PLACEHOLDER_OPEN)
          held = held.slice(1)
          continue
        }
        const id = body as RedactionId
        const original = registry.original(id)
        const keep = original === undefined || (options.keepInUrls === true && cursor?.inUrl === true)
        if (original === undefined) unknown += 1
        else if (keep) kept += 1
        else restored += 1
        const path = cursor?.path() ?? []
        emit(keep ? held.slice(0, close + 1) : encode(original))
        if (original !== undefined) options.onPlaceholder?.({ id, restored: !keep, path })
        held = held.slice(close + 1)
      }
    },
    end() {
      const tail = held
      held = ''
      cursor?.feed(tail)
      return tail
    },
  }
}

/**
 * Restore one complete string leniently.
 * @param text - masked text.
 * @param registry - bindings the text may reference.
 * @param options - output encoding of originals.
 * @returns the restored text.
 */
export function restoreLenient(text: string, registry: RedactionRegistry, options: StreamRestoreOptions = {}): string {
  const restorer = createStreamRestorer(registry, options)
  return restorer.push(text) + restorer.end()
}
