/**
 * Rule-based redaction provider: home paths, email addresses, Taiwan
 * identification and business numbers, telephone numbers, payment card
 * numbers, credentials, high-entropy runs, private addresses, internal host
 * names, configured literal terms, and, when enabled, identifiers issued
 * outside Taiwan, with every rule run again over an NFKC
 * projection, over a percent-decoded projection, and over the NFKC projection
 * of the decoded text, and every detected value propagated to its other
 * occurrences.
 *
 * @module redaction-proxy/core/rules
 */

import { createHash } from 'node:crypto'
import { RedactionError, RedactionPolicyDigest } from '../engine.ts'
import type { RedactionDetection, RedactionDetector, RedactionPropagation } from '../types.ts'
import type { Candidate, PushCandidate } from './candidate.ts'
import { mergeCandidates } from './candidate.ts'
import type { OffsetProjection } from './normalize.ts'
import { HIGH_ESCAPE, composeProjections, projectNfkc, projectPercent } from './normalize.ts'
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
  termIdentityKey,
} from './rules.ts'
import { collectSecretCandidates } from './secret.ts'
import type { InternationalRuleName } from './international.ts'
import {
  INTERNATIONAL_COLLECTORS,
  INTERNATIONAL_RULE_CATEGORIES,
  INTERNATIONAL_RULE_NAMES,
  INTERNATIONAL_RULES_VERSION,
  isInternationalRule,
} from './international.ts'

export { isTaiwanBusinessNumber, isTaiwanNationalId } from './checksum.ts'

export type { InternationalRuleName } from './international.ts'

/** Names of the rules enabled by default. */
export type DefaultRuleName =
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

/** Built-in rule names. */
export type RedactionRuleName = DefaultRuleName | InternationalRuleName

/** Rules-provider configuration. */
export interface RulesRedactionConfig {
  /**
   * Enabled built-in rules; defaults to {@link DEFAULT_RULE_NAMES}, which
   * leaves the international rules off. An empty list disables built-in detection.
   */
  rules?: RedactionRuleName[]
  /** Literal strings masked case-insensitively under category `TERM`, for example personal names. */
  terms?: string[]
  /** Literal strings masked case-insensitively under category `PROJECT`, for example internal code names. */
  projectNames?: string[]
  /** Literal values every built-in rule leaves alone; an empty list allows nothing. */
  allowlist?: string[]
}

/** Detector version recorded with every scan; changes whenever a rule's matches change. */
export const DETECTOR_VERSION = 'rules-6'

/** Shared addresses that are public by construction and carry no private value. */
export const DEFAULT_ALLOWLIST: readonly string[] = ['git@github.com', 'noreply@github.com']

/**
 * Rules enabled when the configuration names none. Enabling any other rule
 * changes the detector version and so the policy digest; this default keeps
 * both equal to those of detectors built before the international rules.
 */
export const DEFAULT_RULE_NAMES: readonly DefaultRuleName[] = [
  'email', 'user-path', 'api-key', 'tw-national-id', 'phone', 'tax-id', 'card', 'ip', 'host', 'entropy',
]

/** Every built-in rule name, in declaration order: the default rules, then the international ones. */
export const RULE_NAMES: readonly RedactionRuleName[] = [...DEFAULT_RULE_NAMES, ...INTERNATIONAL_RULE_NAMES]

const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/

const CONFIG_KEYS: ReadonlySet<string> = new Set(['rules', 'terms', 'projectNames', 'allowlist'])

/** Categories each default rule can report, in the order `categories` lists them. */
const DEFAULT_RULE_CATEGORIES: Readonly<Record<DefaultRuleName, readonly string[]>> = {
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
 * Categories one rule can report.
 * @param rule - a built-in rule name.
 * @returns the rule's categories, in the order `categories` lists them.
 */
function categoriesOf(rule: RedactionRuleName): readonly string[] {
  return isInternationalRule(rule) ? [INTERNATIONAL_RULE_CATEGORIES[rule]] : DEFAULT_RULE_CATEGORIES[rule]
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
  const rules = config.rules ?? [...DEFAULT_RULE_NAMES]
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
  readonly detectorVersion: string
  readonly policyDigest: RedactionPolicyDigest
  readonly categories: readonly string[]
  private readonly rules: ReadonlySet<RedactionRuleName>
  private readonly internationalRules: readonly InternationalRuleName[]
  private readonly terms: readonly ConfiguredTerm[]
  private readonly allowlist: ReadonlySet<string>

  /**
   * @param config - rule selection and literal lists; validated here.
   * @throws {Error} when a key, rule, or literal is invalid.
   */
  constructor(config: RulesRedactionConfig = {}) {
    const resolved = resolveRulesConfig(config)
    this.rules = new Set(resolved.rules)
    this.internationalRules = INTERNATIONAL_RULE_NAMES.filter(rule => this.rules.has(rule))
    this.detectorVersion = this.internationalRules.length === 0
      ? DETECTOR_VERSION
      : `${DETECTOR_VERSION}+${INTERNATIONAL_RULES_VERSION}`
    this.terms = [
      ...resolved.projectNames.map(value => ({ value, category: 'PROJECT' })),
      ...resolved.terms.map(value => ({ value, category: 'TERM' })),
    ]
    this.allowlist = new Set(resolved.allowlist.map(value => value.toLowerCase()))
    this.categories = [...new Set([
      ...resolved.rules.flatMap(categoriesOf),
      ...resolved.projectNames.length === 0 ? [] : ['PROJECT'],
      ...resolved.terms.length === 0 ? [] : ['TERM'],
    ])]
    // Literal text stays out of the digest: a hash of a short name is guessable,
    // and the digest is persisted in the Session's span index.
    this.policyDigest = RedactionPolicyDigest(`sha256:${createHash('sha256')
      .update(JSON.stringify({
        detectorVersion: this.detectorVersion,
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
   * @param originalAt - on a projection, the submitted character each offset came from.
   */
  private collect(
    text: string,
    out: Candidate[],
    skipTerms: boolean,
    originalAt?: (offset: number) => string,
  ): void {
    const push: PushCandidate = (start, end, category, priority) => {
      if (this.allowlist.has(text.slice(start, end).toLowerCase())) return
      out.push({ start, end, category, priority })
    }
    // A stray `%E6` or `%FF` right before a number or a token is a left boundary on every pass.
    const afterEscape = HIGH_ESCAPE.test(text)
    if (this.rules.has('user-path')) collectPathCandidates(text, push)
    if (this.rules.has('email')) collectEmailCandidates(text, push)
    collectNumberCandidates(text, this.rules, push, afterEscape)
    // Before cards: an identity number that is also a Luhn-valid digit run keeps its own category.
    for (const rule of this.internationalRules) INTERNATIONAL_COLLECTORS[rule](text, push)
    if (this.rules.has('card')) collectCardCandidates(text, push, afterEscape)
    collectNetworkCandidates(text, this.rules, push, originalAt, afterEscape)
    if (this.rules.has('api-key')) collectSecretCandidates(text, push, afterEscape)
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
    const nfkc = projectNfkc(text)
    if (nfkc.norm !== text) this.collectProjected(text, nfkc, candidates, true)
    // A third pass over the percent-decoded text, so `%40` in a mailto link or
    // `%E6...` in a query string hides nothing. Terms run here too: their own
    // NFKC projection is taken of the decoded text, and the map below carries
    // each span to the whole encoded range, which is what the registry binds.
    // A fourth pass folds the decoded text through NFKC, so an encoded zero-width
    // character or full-width digit hides nothing either.
    const percent = projectPercent(text)
    if (percent !== undefined) {
      this.collectProjected(text, percent, candidates, false)
      const folded = projectNfkc(percent.norm)
      if (folded.norm !== percent.norm) this.collectProjected(text, composeProjections(percent, folded), candidates, true)
    }
    return mergeCandidates(candidates)
  }

  /**
   * Run every enabled rule over one projection and map its candidates back.
   * @param text - the submitted text.
   * @param projection - a projection of `text` with its offset maps.
   * @param out - candidate sink, in submitted-text offsets.
   * @param skipTerms - whether to skip configured literals.
   */
  private collectProjected(text: string, projection: OffsetProjection, out: Candidate[], skipTerms: boolean): void {
    const found: Candidate[] = []
    this.collect(projection.norm, found, skipTerms, offset => text.charAt(projection.startMap[offset] ?? text.length))
    for (const candidate of found) {
      out.push({
        ...candidate,
        // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
        start: projection.startMap[candidate.start]!,
        // oxlint-disable-next-line typescript/no-non-null-assertion -- both offsets are inside the projection.
        end: projection.endMap[candidate.end - 1]!,
      })
    }
  }

  /**
   * Identity key of one value: every spelling of a configured term shares one
   * key, and so one placeholder; any other value is its own key.
   * @param value - one detected original.
   * @param category - the category it is masked under.
   * @returns the key its identity is allocated by.
   */
  identityKey(value: string, category: string): string {
    // A percent-encoded spelling keeps its own identity so restore writes it back byte for byte.
    return (category === 'TERM' || category === 'PROJECT') && !PERCENT_ESCAPE.test(value)
      ? termIdentityKey(value, category)
      : value
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

