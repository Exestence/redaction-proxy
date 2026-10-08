/**
 * The rules detector combined with the name model. Rules run on every text;
 * the model runs only on the texts a request marks as user-written, and its
 * spans give way to every rules detection they overlap.
 *
 * Every value the model finds (NAME, ORG, LOC, ADDR) is masked everywhere in
 * the request: system prompts, assistant turns, tool results, and tool-call
 * arguments. Further occurrences are found by the configured-terms matcher, so
 * `許 雅 雯` is masked after `許雅雯`, and `JORDAN` after `Jordan`. Each
 * spelling has its own placeholder, because restore writes back the one
 * original its placeholder is bound to. A Latin-script value matches whole words
 * only (`Lee` never inside `Leeds`); a CJK value matches anywhere. False
 * positives spread the same way, which the allowlist contains.
 *
 * @module redaction-proxy/core/model/detector
 */

import { createHash } from 'node:crypto'
import { RedactionPolicyDigest } from '../engine.ts'
import type { RulesDetector } from '../rules/index.ts'
import type { Candidate } from '../rules/candidate.ts'
import { mergeCandidates } from '../rules/candidate.ts'
import { collectTermCandidates, standsAlone } from '../rules/rules.ts'
import type { RedactionDetection, RedactionDetector, RedactionPropagation } from '../types.ts'
import type { NameModel } from './name-model.ts'
import { NAME_MODEL_CATEGORIES } from './config.ts'
import { dropOverlapping } from './spans.ts'

/** Suffix that marks a detector version as rules plus the name model. */
const NAME_MODEL_VERSION = 'nym-edge-int8-3'

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
 * Whether a value is long enough to search for: a shorter model value is not
 * propagated, and the proxy's leak scan checks no shorter model value.
 * One character (`王`, or `燕` from a partly found `王晓燕`) would
 * mask that character in every word holding it.
 * @param value - a bound original.
 * @returns whether it has at least two code points.
 */
export function isSearchedValue(value: string): boolean {
  // oxlint-disable-next-line typescript/no-misused-spread -- the floor counts code points, not graphemes.
  return [...value].length >= 2
}

/**
 * Whether a text holds a value as a whole word, by {@link standsAlone}.
 * @param text - the text to search.
 * @param value - the value.
 * @returns whether one occurrence stands alone.
 */
export function containsStandingAlone(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    if (standsAlone(text, at, at + value.length)) return true
  }
  return false
}

/**
 * Find further occurrences of model-found values through the terms matcher,
 * keeping only those that stand alone.
 * @param texts - every submitted text.
 * @param values - the model-found values mapped to their categories.
 * @returns disjoint ranges per text.
 */
function propagateModelValues(texts: readonly string[], values: ReadonlyMap<string, string>): RedactionPropagation[] {
  const terms = [...values].filter(([value]) => isSearchedValue(value)).map(([value, category]) => ({ value, category }))
  if (terms.length === 0) return []
  return texts.flatMap((text, at) => {
    const candidates: Candidate[] = []
    collectTermCandidates(text, terms, (start, end, category, priority) => {
      if (standsAlone(text, start, end)) candidates.push({ start, end, category, priority })
    })
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
   * for model-found values. Rules ranges come first, so they win an overlap.
   * @param texts - every submitted text.
   * @param values - every bound original mapped to its category.
   * @returns ranges naming their text by index.
   */
  private propagate(texts: readonly string[], values: ReadonlyMap<string, string>): RedactionPropagation[] {
    const isModel = ([, category]: [string, string]): boolean => MODEL_CATEGORIES.has(category)
    const ruleValues = new Map([...values].filter(entry => !isModel(entry)))
    const modelValues = new Map([...values].filter(isModel))
    return [...this.rules.propagate(texts, ruleValues), ...propagateModelValues(texts, modelValues)]
  }
}
