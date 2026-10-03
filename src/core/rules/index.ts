/**
 * Rule-based redaction provider: home paths, email addresses, Taiwan
 * identification and business numbers, telephone numbers, payment card
 * numbers, credentials, high-entropy runs, private addresses, internal host
 * names, and configured literal terms, with every rule run a second time over
 * an NFKC projection and every detected value propagated to its other
 * occurrences.
 *
 * @module redaction-proxy/core/rules
 */

import { createHash } from 'node:crypto'
import { RedactionError, RedactionPolicyDigest } from '../engine.ts'
import type { RedactionDetection, RedactionDetector, RedactionPropagation } from '../types.ts'
import type { Candidate, PushCandidate } from './candidate.ts'
import { mergeCandidates } from './candidate.ts'
import { projectNfkc } from './normalize.ts'
import { propagateValues } from './propagate.ts'
import { screenText } from './screen.ts'
import type { ConfiguredTerm } from './rules.ts'
import {
  collectCardCandidates,
  collectEmailCandidates,
  collectEntropyCandidates,
  collectNetworkCandidates,
  collectNumberCandidates,
  collectPathCandidates,
  collectTermCandidates,
} from './rules.ts'
import { collectSecretCandidates } from './secret.ts'

export { isTaiwanNationalId } from './rules.ts'

/** Built-in rule names. */
export type RedactionRuleName =
  | 'email'
  | 'user-path'
  | 'api-key'
  | 'tw-national-id'
  | 'phone'
  | 'tax-id'
  | 'card'
  | 'ip'
  | 'host'
  | 'entropy'

/** Rules-provider configuration. */
export interface RulesRedactionConfig {
  /** Enabled built-in rules; defaults to every rule. An empty list disables built-in detection. */
  rules?: RedactionRuleName[]
  /** Literal strings masked case-insensitively under category `TERM`, for example personal names. */
  terms?: string[]
  /** Literal strings masked case-insensitively under category `PROJECT`, for example internal code names. */
  projectNames?: string[]
  /** Literal values every built-in rule leaves alone; an empty list allows nothing. */
  allowlist?: string[]
}

/** Detector version recorded with every scan; changes whenever a rule's matches change. */
export const DETECTOR_VERSION = 'rules-2'

/** Shared addresses that are public by construction and carry no private value. */
export const DEFAULT_ALLOWLIST: readonly string[] = ['git@github.com', 'noreply@github.com']

/** Every built-in rule name, in declaration order. */
export const RULE_NAMES: readonly RedactionRuleName[] = [
  'email', 'user-path', 'api-key', 'tw-national-id', 'phone', 'tax-id', 'card', 'ip', 'host', 'entropy',
]

const CONFIG_KEYS: ReadonlySet<string> = new Set(['rules', 'terms', 'projectNames', 'allowlist'])

/** Categories each rule can report, in the order `categories` lists them. */
const RULE_CATEGORIES: Readonly<Record<RedactionRuleName, readonly string[]>> = {
  'email': ['EMAIL'],
  'user-path': ['PATH'],
  'api-key': ['KEY'],
  'tw-national-id': ['TWID'],
  'phone': ['PHONE'],
  'tax-id': ['TAXID'],
  'card': ['CARD'],
  'ip': ['IP'],
  'host': ['HOST'],
  // A run beside credential words is reported as a credential instead.
  'entropy': ['ENTROPY', 'KEY'],
}

/**
 * Validate one configured literal list.
 * @param values - the configured values, or `undefined` for the fallback.
 * @param fallback - the value used when the key is absent.
 * @param label - configuration key name, for the failure message.
 * @returns the distinct values in declaration order.
 * @throws {Error} when an entry is blank or carries a placeholder delimiter.
 */
function resolveLiterals(values: string[] | undefined, fallback: readonly string[], label: string): string[] {
  if (values !== undefined && !Array.isArray(values)) throw new Error(`RulesRedactionConfig: ${label} must be an array`)
  const list: readonly string[] = values ?? fallback
  for (const value of list) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`RulesRedactionConfig: every ${label} entry must be a non-blank string`)
    }
    if (value.includes('⟦') || value.includes('⟧')) {
      throw new Error(`RulesRedactionConfig: a ${label} entry must not contain a placeholder delimiter`)
    }
    // A term of zero-width characters alone projects to nothing and would match everywhere.
    if (projectNfkc(value).norm.length === 0) {
      throw new Error(`RulesRedactionConfig: a ${label} entry must hold a character that survives normalization`)
    }
  }
  return [...new Set(list)]
}

/** The provider configuration after validation and defaulting. */
export interface ResolvedRulesConfig {
  /** Enabled rules in declaration order. */
  rules: RedactionRuleName[]
  /** Distinct `TERM` literals. */
  terms: string[]
  /** Distinct `PROJECT` literals. */
  projectNames: string[]
  /** Distinct allowlisted literals. */
  allowlist: string[]
}

/**
 * Validate and detach the provider configuration.
 * @param config - Loader-normalized plugin configuration.
 * @returns the enabled rules and the distinct literal lists.
 * @throws {Error} when a key, rule, or literal is invalid.
 */
export function resolveRulesConfig(config: RulesRedactionConfig = {}): ResolvedRulesConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`RulesRedactionConfig: unknown key "${key}"`)
  }
  const rules = config.rules ?? [...RULE_NAMES]
  if (!Array.isArray(rules)) throw new Error('RulesRedactionConfig: rules must be an array')
  for (const rule of rules) {
    if (!RULE_NAMES.includes(rule)) throw new Error(`RulesRedactionConfig: unknown rule ${JSON.stringify(rule)}`)
  }
  return {
    rules: RULE_NAMES.filter(rule => rules.includes(rule)),
    terms: resolveLiterals(config.terms, [], 'terms'),
    projectNames: resolveLiterals(config.projectNames, [], 'projectNames'),
    allowlist: resolveLiterals(config.allowlist, DEFAULT_ALLOWLIST, 'allowlist'),
  }
}

/**
 * Rules detector. Every rule runs over the submitted text and over its NFKC
 * projection, overlapping ranges are resolved here rather than by start order,
 * and each detected value is masked wherever else it occurs in the same call.
 */
export class RulesDetector implements RedactionDetector {
  readonly detectorVersion = DETECTOR_VERSION
  readonly policyDigest: RedactionPolicyDigest
  readonly categories: readonly string[]
  private readonly rules: ReadonlySet<RedactionRuleName>
  private readonly terms: readonly ConfiguredTerm[]
  private readonly allowlist: ReadonlySet<string>

  /**
   * @param config - rule selection and literal lists; validated here.
   * @throws {Error} when a key, rule, or literal is invalid.
   */
  constructor(config: RulesRedactionConfig = {}) {
    const resolved = resolveRulesConfig(config)
    this.rules = new Set(resolved.rules)
    this.terms = [
      ...resolved.projectNames.map(value => ({ value, category: 'PROJECT' })),
      ...resolved.terms.map(value => ({ value, category: 'TERM' })),
    ]
    this.allowlist = new Set(resolved.allowlist.map(value => value.toLowerCase()))
    this.categories = [...new Set([
      ...resolved.rules.flatMap(rule => RULE_CATEGORIES[rule]),
      ...resolved.projectNames.length === 0 ? [] : ['PROJECT'],
      ...resolved.terms.length === 0 ? [] : ['TERM'],
    ])]
    // Literal text stays out of the digest: a hash of a short name is guessable,
    // and the digest is persisted in the Session's span index.
    this.policyDigest = RedactionPolicyDigest(`sha256:${createHash('sha256')
      .update(JSON.stringify({
        detectorVersion: DETECTOR_VERSION,
        rules: resolved.rules,
        termCount: resolved.terms.length,
        projectNameCount: resolved.projectNames.length,
        allowlistCount: resolved.allowlist.length,
      }))
      .digest('hex')}`)
  }

  /**
   * Run every enabled rule over one text.
   * @param text - the text or its NFKC projection.
   * @param out - candidate sink.
   * @param skipTerms - whether to skip configured literals, which project themselves.
   */
  private collect(text: string, out: Candidate[], skipTerms: boolean): void {
    const push: PushCandidate = (start, end, category, priority) => {
      if (this.allowlist.has(text.slice(start, end).toLowerCase())) return
      out.push({ start, end, category, priority })
    }
    if (this.rules.has('user-path')) collectPathCandidates(text, push)
    if (this.rules.has('email')) collectEmailCandidates(text, push)
    collectNumberCandidates(text, this.rules, push)
    if (this.rules.has('card')) collectCardCandidates(text, push)
    collectNetworkCandidates(text, this.rules, push)
    if (this.rules.has('api-key')) collectSecretCandidates(text, push)
    if (this.rules.has('entropy')) collectEntropyCandidates(text, push)
    if (!skipTerms) collectTermCandidates(text, this.terms, push)
  }

  /**
   * Find sensitive ranges in one text.
   * @param text - one complete string without placeholder delimiters.
   * @returns disjoint ranges in start order.
   * @throws {RedactionError} `unsupported` when the text holds a character the rules cannot reason about.
   */
  detect(text: string): RedactionDetection[] {
    const refusal = screenText(text)
    if (refusal !== undefined) {
      throw new RedactionError(
        'unsupported',
        `text holds a ${refusal.reason} at offset ${String(refusal.at)} and cannot be masked in part`,
      )
    }
    const candidates: Candidate[] = []
    this.collect(text, candidates, false)
    // A second pass over the NFKC projection: without it a full-width digit or a
    // zero-width character inserted mid-value hides an address, a card, or a
    // credential. Configured literals already project themselves.
    const projection = projectNfkc(text)
    if (projection.norm !== text) {
      const folded: Candidate[] = []
      this.collect(projection.norm, folded, true)
      for (const candidate of folded) {
        candidates.push({
          ...candidate,
          // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
          start: projection.startMap[candidate.start]!,
          // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
          end: projection.endMap[candidate.end - 1]!,
        })
      }
    }
    return mergeCandidates(candidates)
  }

  /**
   * Find further occurrences of every value already bound.
   * @param texts - every submitted string.
   * @param values - bound originals mapped to their category.
   * @returns ranges naming their text by index.
   */
  propagate(
    texts: readonly string[],
    values: ReadonlyMap<string, string>,
  ): RedactionPropagation[] {
    return propagateValues(texts, values)
  }
}

