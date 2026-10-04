/**
 * Stand-ins for the DeepSeek Harness adapter surface, so the rule and engine
 * suites carried over from dsh-addons run against the core unchanged.
 */
import { RulesDetector, mask, restore } from '../src/core/index.ts'
import type {
  RedactionDetection,
  RedactionIndex,
  RedactionMaskResult,
  RedactionPolicyDigest,
  RedactionPropagation,
  RedactionRegistry,
  RedactionRestoreResult,
  RedactionText,
  RulesRedactionConfig,
} from '../src/core/index.ts'

export class Context {}

export function SessionSeq(value: number): number {
  return value
}

/** Engine adapter with the host service's protected detector hooks. */
export abstract class RedactionService {
  abstract readonly policyDigest: RedactionPolicyDigest
  abstract readonly detectorVersion: string
  abstract readonly categories: readonly string[]
  constructor(_ctx: Context) {}
  protected abstract detect(text: string): readonly RedactionDetection[] | Promise<readonly RedactionDetection[]>
  protected propagate(_texts: readonly string[], _values: ReadonlyMap<string, string>): readonly RedactionPropagation[] | Promise<readonly RedactionPropagation[]> {
    return []
  }
  protected identityKey(value: string, _category: string): string {
    return value
  }

  mask(texts: readonly RedactionText[], index: RedactionIndex): Promise<RedactionMaskResult> {
    return mask({
      policyDigest: this.policyDigest,
      detectorVersion: this.detectorVersion,
      categories: this.categories,
      detect: text => this.detect(text),
      propagate: (all, values) => this.propagate(all, values),
      identityKey: (value, category) => this.identityKey(value, category),
    }, texts, index)
  }

  restore(output: string, registry: RedactionRegistry): RedactionRestoreResult {
    return restore(output, registry)
  }
}

/** Rules detector behind the host service's constructor signature. */
export class RulesRedactionService extends RedactionService {
  private readonly detector: RulesDetector
  readonly policyDigest: RedactionPolicyDigest
  readonly detectorVersion: string
  readonly categories: readonly string[]
  constructor(ctx: Context, config?: RulesRedactionConfig) {
    super(ctx)
    this.detector = new RulesDetector(config)
    this.policyDigest = this.detector.policyDigest
    this.detectorVersion = this.detector.detectorVersion
    this.categories = this.detector.categories
  }

  protected detect(text: string): readonly RedactionDetection[] {
    return this.detector.detect(text)
  }

  protected override propagate(texts: readonly string[], values: ReadonlyMap<string, string>): readonly RedactionPropagation[] {
    return this.detector.propagate(texts, values)
  }

  protected override identityKey(value: string, category: string): string {
    return this.detector.identityKey(value, category)
  }
}

export default RulesRedactionService
