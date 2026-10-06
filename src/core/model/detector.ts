/**
 * The rules detector combined with the name model. Rules run on every text;
 * the model runs only on the texts a request marks as user-written, and its
 * spans give way to every rules detection they overlap.
 *
 * Propagation is narrower than for rules: a model NAME reaches the rest of the
 * request through the configured-terms matcher, so `許雅雯` and `許 雅 雯`
 * share one placeholder, but a single ASCII word (`Jordan`, or a false
 * positive such as `Default`) is masked only where the model found it.
 * ORG, LOC, and ADDR are masked only where found.
 *
 * @module redaction-proxy/core/model/detector
 */

import { createHash } from 'node:crypto'
import { RedactionPolicyDigest } from '../engine.ts'
import type { RulesDetector } from '../rules/index.ts'
import type { Candidate } from '../rules/candidate.ts'
import { mergeCandidates } from '../rules/candidate.ts'
import { collectTermCandidates, termIdentityKey } from '../rules/rules.ts'
import { isPropagatableValue } from '../rules/secret.ts'
import type { RedactionDetection, RedactionDetector, RedactionPropagation } from '../types.ts'
import type { NameModel } from './name-model.ts'
import { NAME_MODEL_CATEGORIES } from './config.ts'
import { dropOverlapping } from './spans.ts'

/** Suffix that marks a detector version as rules plus the name model. */
const NAME_MODEL_VERSION = 'nym-edge-int8-1'

const MODEL_CATEGORIES: ReadonlySet<string> = new Set(NAME_MODEL_CATEGORIES)

/** Inference failed and the configuration requires the model. */
export class NameModelError extends Error {
  override readonly name = 'NameModelError'
}

/**
 * Receives an inference failure the request continues without.
 * @param error - the failure.
 */
export type NameModelFailureHandler = (error: unknown) => void

/**
 * Whether a model-found name may be propagated: never a single ASCII word,
 * whose other occurrences are too often a product, a setting, or a code word.
 * @param value - the name as found.
 * @returns whether to search for it elsewhere.
 */
function isPropagatableName(value: string): boolean {
  const singleAsciiWord = /^[\x21-\x7e]+$/.test(value)
  return !singleAsciiWord && isPropagatableValue(value)
}

/**
 * Find further occurrences of model-found names through the terms matcher.
 * @param texts - every submitted text.
 * @param names - the propagatable names.
 * @returns disjoint ranges per text.
 */
function propagateNames(texts: readonly string[], names: readonly string[]): RedactionPropagation[] {
  if (names.length === 0) return []
  const terms = names.map(value => ({ value, category: 'NAME' }))
  return texts.flatMap((text, at) => {
    const candidates: Candidate[] = []
    collectTermCandidates(text, terms, (start, end, category, priority) => candidates.push({ start, end, category, priority }))
    return mergeCandidates(candidates).map(({ start, end, category }) => ({ text: at, start, end, category }))
  })
}

/** Rules plus the name model; one instance per process, one {@link forRequest} view per request. */
export class NameModelDetector {
  readonly policyDigest: RedactionPolicyDigest
  readonly detectorVersion: string
  readonly categories: readonly string[]
  private readonly rules: RulesDetector
  private readonly model: NameModel

  /**
   * @param rules - the rules detector.
   * @param model - the loaded name model.
   */
  constructor(rules: RulesDetector, model: NameModel) {
    this.rules = rules
    this.model = model
    const { config } = model
    this.detectorVersion = `${rules.detectorVersion}+${NAME_MODEL_VERSION}`
    this.categories = [...rules.categories, ...config.categories]
    // `required` changes failure handling, not what is detected, so it stays out.
    this.policyDigest = RedactionPolicyDigest(`sha256:${createHash('sha256')
      .update(JSON.stringify({
        rules: rules.policyDigest,
        model: model.fingerprint,
        version: NAME_MODEL_VERSION,
        threshold: config.threshold,
        categories: config.categories,
        windowTokens: config.windowTokens,
        windowOverlap: config.windowOverlap,
        allowlistCount: config.allowlist.length,
      }))
      .digest('hex')}`)
  }

  /**
   * A detector for one request.
   * @param userTexts - the request texts the user wrote; only these reach the model.
   * @param onFailure - receives an inference failure when the model is not required.
   * @returns the detector to pass to `mask`.
   */
  forRequest(userTexts: ReadonlySet<string>, onFailure: NameModelFailureHandler): RedactionDetector {
    return {
      policyDigest: this.policyDigest,
      detectorVersion: this.detectorVersion,
      categories: this.categories,
      detect: async text => {
        const ruleDetections = this.rules.detect(text)
        if (!userTexts.has(text)) return ruleDetections
        return [...ruleDetections, ...dropOverlapping(await this.findOrFail(text, onFailure), ruleDetections)]
      },
      propagate: (texts, values) => this.propagate(texts, values),
      identityKey: (value, category) => category === 'NAME' ? termIdentityKey(value, category) : this.rules.identityKey(value, category),
    }
  }

  /**
   * Run the model, applying the configured failure policy.
   * @param text - one user-written text.
   * @param onFailure - receives the failure when the model is not required.
   * @returns the model's detections; none after a tolerated failure.
   * @throws {NameModelError} when inference fails and the model is required.
   */
  private async findOrFail(text: string, onFailure: NameModelFailureHandler): Promise<RedactionDetection[]> {
    try {
      return await this.model.find(text)
    } catch (error) {
      if (this.model.config.required) throw new NameModelError('name model inference failed', { cause: error })
      onFailure(error)
      return []
    }
  }

  /**
   * Rules propagation for rule-found values, then terms-matcher propagation
   * for model-found names. Rules ranges come first, so they win an overlap.
   * @param texts - every submitted text.
   * @param values - every bound original mapped to its category.
   * @returns ranges naming their text by index.
   */
  private propagate(texts: readonly string[], values: ReadonlyMap<string, string>): RedactionPropagation[] {
    const ruleValues = new Map([...values].filter(([, category]) => !MODEL_CATEGORIES.has(category)))
    const names = [...values].filter(([value, category]) => category === 'NAME' && isPropagatableName(value)).map(([value]) => value)
    return [...this.rules.propagate(texts, ruleValues), ...propagateNames(texts, names)]
  }
}
