/**
 * Redaction core: rule-based detection (with Taiwan identifiers and
 * checksums), placeholder masking, strict and streaming restoration. It has no
 * runtime dependency beyond Node's standard library and no host types; the
 * proxy and the DeepSeek Harness adapters both build on it.
 *
 * @module redaction-proxy/core
 */

export type * from './types.ts'
export {
  PLACEHOLDER_CLOSE,
  PLACEHOLDER_OPEN,
  REDACTION_ID_PATTERN,
  RedactionError,
  RedactionId,
  RedactionPolicyDigest,
  applySpans,
  emptyRedactionIndex,
  foldRedactionScan,
  mask,
  placeholder,
  restore,
} from './engine.ts'
export type { RedactionErrorCode } from './engine.ts'
export { createStreamRestorer, restoreLenient } from './restore.ts'
export type { StreamRestoreOptions, StreamRestorer } from './restore.ts'
export {
  DEFAULT_ALLOWLIST,
  DETECTOR_VERSION,
  RULE_NAMES,
  RulesDetector,
  isTaiwanNationalId,
  resolveRulesConfig,
} from './rules/index.ts'
export type { RedactionRuleName, ResolvedRulesConfig, RulesRedactionConfig } from './rules/index.ts'
