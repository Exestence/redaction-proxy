/**
 * Vocabulary of the redaction core: placeholder identities, span locations,
 * the persisted span index, detector output, and mask/restore results. Types
 * only; recorded values never contain an original sensitive string.
 *
 * Every location-bearing type is generic over `S`, the identity of the record
 * that holds a string (a log sequence number in a host that persists scans, a
 * plain index in a stateless caller).
 *
 * @module redaction-proxy/core/types
 */

declare const BRAND: unique symbol

/**
 * Placeholder identity `CATEGORY_n`, for example `EMAIL_3`: an upper-case
 * category, an underscore, and a positive decimal number. The masked text
 * carries it as `⟦CATEGORY_n⟧`.
 */
export type RedactionId = string & { readonly [BRAND]: 'RedactionId' }

/** Detector-computed digest identifying the detection policy that produced a scan. */
export type RedactionPolicyDigest = string & { readonly [BRAND]: 'RedactionPolicyDigest' }

/**
 * One string inside one record: `seq` names the record and `path` is a JSON
 * pointer into it, for example `/content/0/text`.
 */
export interface RedactionLocation<S = number> {
  /** Record that holds the string. */
  seq: S
  /** JSON pointer into the record. */
  path: string
}

/**
 * One masked range of a located string. `start` and `end` are UTF-16 code-unit
 * offsets, `end` exclusive. The original value is that slice of the string and
 * is never recorded beside the span.
 */
export interface RedactionSpan<S = number> extends RedactionLocation<S> {
  /** Inclusive start offset. */
  start: number
  /** Exclusive end offset. */
  end: number
  /** Placeholder identity that replaces the slice. */
  id: RedactionId
}

/** One masked range of an in-memory string, before it is bound to a location. */
export interface RedactionTextSpan {
  /** Inclusive start offset. */
  start: number
  /** Exclusive end offset. */
  end: number
  /** Placeholder identity that replaces the slice. */
  id: RedactionId
}

/**
 * Scan facts one producer records so a later mask can reuse them without
 * running the detector again.
 */
export interface RedactionScan<S = number> {
  /** Policy that produced `spans` and `scanned`. */
  policyDigest: RedactionPolicyDigest
  /** Detector version that produced `spans` and `scanned`. */
  detectorVersion: string
  /** Spans the detector found during this scan; reused spans are not repeated. */
  spans: RedactionSpan<S>[]
  /** Locations the detector scanned during this scan without finding a span. */
  scanned: RedactionLocation<S>[]
  /**
   * Placeholder positions restored into a written checkpoint message. A later
   * mask applies them instead of scanning that message again.
   */
  checkpointSpans: RedactionSpan<S>[]
  /**
   * Identities whose literal `CATEGORY_n` form this scan found in original
   * text. A reserved identity is never allocated to a detected value.
   */
  reserved: RedactionId[]
}

/** One sensitive range reported by a detector. */
export interface RedactionDetection {
  /** Inclusive UTF-16 start offset. */
  start: number
  /** Exclusive UTF-16 end offset. */
  end: number
  /** Upper-case category, for example `EMAIL`; becomes the placeholder prefix. */
  category: string
}

/**
 * One sensitive range reported by a detector's propagation pass, naming the
 * text it belongs to by position in the submitted array.
 */
export interface RedactionPropagation extends RedactionDetection {
  /** Index into the submitted `texts` array. */
  text: number
}

/** One located string submitted for masking. */
export interface RedactionText<S = number> extends RedactionLocation<S> {
  /** The complete string currently at `seq`/`path`. */
  text: string
}

/** Recorded spans of one location, with the detector version that last scanned it. */
export interface RedactionIndexEntry<S = number> extends RedactionLocation<S> {
  /** Detector version of the newest scan folded into this entry. */
  detectorVersion: string
  /** Non-overlapping spans in start order; empty when the location was scanned clean. */
  spans: RedactionTextSpan[]
}

/**
 * Plain-JSON span index folded from recorded scans. It holds locations and
 * placeholder identities only, so a host may persist it.
 */
export interface RedactionIndex<S = number> {
  /** One entry per scanned location. */
  entries: RedactionIndexEntry<S>[]
  /** Highest placeholder number recorded per category. */
  lastIds: Record<string, number>
  /** Every identity reserved by a recorded scan. */
  reserved: RedactionId[]
  /** Policy of the first recorded scan; a mask under another policy is refused. */
  policyDigest?: RedactionPolicyDigest
}

/** Outcome of one {@link mask} call. */
export interface RedactionMaskResult<S = number> {
  /** Masked strings, index for index with the submitted texts. */
  masked: string[]
  /** Spans the detector found in this call. */
  spans: RedactionSpan<S>[]
  /** Locations the detector scanned in this call without finding a span. */
  scanned: RedactionLocation<S>[]
  /** Identities this call reserved because their literal form occurs in a submitted text. */
  reserved: RedactionId[]
  /** Every span applied to the submitted texts, reused and new. */
  applied: RedactionSpan<S>[]
  /** Number of texts passed to the detector. */
  detected: number
  /** In-memory bindings of every applied placeholder to its original. */
  registry: RedactionRegistry
}

/**
 * Process-local bindings between placeholder identities and originals. It is
 * never serialized; a mask rebuilds it from the texts it receives.
 */
export interface RedactionRegistry {
  /**
   * Look up one binding.
   * @param id - placeholder identity.
   * @returns the original, or `undefined` when unbound.
   */
  original(id: RedactionId): string | undefined
  /**
   * List bound identities.
   * @returns every bound identity in binding order.
   */
  ids(): RedactionId[]
  /**
   * List bound originals, for leak scans of outgoing requests.
   * @returns every bound original in binding order.
   */
  originals(): string[]
  /**
   * Restrict the bindings to the identities a restore may accept.
   * @param ids - identities to keep; unbound identities are ignored.
   * @returns a registry holding only those bindings.
   */
  subset(ids: Iterable<RedactionId>): RedactionRegistry
}

/** Why a model output could not be restored. */
export type RedactionRestoreFailure = 'unknown-placeholder' | 'malformed-placeholder'

/** Outcome of one strict {@link restore} call. */
export type RedactionRestoreResult =
  | {
    ok: true
    /** Output with every placeholder replaced by its original. */
    text: string
    /** Restored ranges in `text`; re-applying them yields the output again. */
    spans: RedactionTextSpan[]
    /** Registry identities that did not occur in the output. */
    missing: RedactionId[]
  }
  | {
    ok: false
    /** Failure class. */
    reason: RedactionRestoreFailure
    /** Diagnostic naming placeholder identities only, never an original. */
    detail: string
  }

/**
 * A detection policy: what {@link mask} needs from a detector. Masking,
 * identity allocation, span reuse, and restoration stay in the engine so
 * every detector records spans with the same meaning.
 */
export interface RedactionDetector {
  /** Digest of the active detection policy, recorded with each scan. */
  readonly policyDigest: RedactionPolicyDigest
  /** Detector version; a change makes recorded locations eligible for additive rescans. */
  readonly detectorVersion: string
  /**
   * Upper-case categories the detector can report. A bare `CATEGORY_n`
   * literal of one of these categories in original text reserves that identity.
   */
  readonly categories: readonly string[]
  /**
   * Find sensitive ranges in one string.
   * @param text - one complete string without placeholder delimiters.
   * @returns ranges inside `text` with upper-case categories; overlapping ranges are resolved by start order.
   */
  detect(text: string): readonly RedactionDetection[] | Promise<readonly RedactionDetection[]>
  /**
   * Find further ranges once every value the call binds is known; see {@link mask}.
   * @param texts - every submitted string, in submission order.
   * @param values - each original bound by the call mapped to its category.
   * @returns ranges naming their text by index.
   */
  propagate?(
    texts: readonly string[],
    values: ReadonlyMap<string, string>,
  ): readonly RedactionPropagation[] | Promise<readonly RedactionPropagation[]>
}
