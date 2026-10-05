/**
 * Loader for a frozen held-out set: a JSONL file written without running any
 * detector on it, checked against the SHA-256 recorded in its MANIFEST so a
 * result always names the exact file it measured.
 *
 * One JSON object per line; offsets are UTF-16 code units, `end` exclusive:
 *
 * ```json
 * {"id": "…", "lang": "en", "format": "chat", "text": "…",
 *  "spans": [{"start": 0, "end": 5, "category": "PHONE", "value": "…", "core": {"start": 2, "end": 5}}],
 *  "negatives": [{"start": 9, "end": 12, "kind": "uuid", "value": "…"}]}
 * ```
 *
 * `category` is one of {@link GOLD_CATEGORIES}. `core` is optional: absolute
 * offsets inside the span, or the core's text when it occurs once in `value`.
 * A negative names what it is in `kind` (or `category`); its `value` is optional.
 * MANIFEST holds `sha256sum` lines (`<hex>  <file name>`) beside the JSONL file.
 *
 * @module bench/public/heldout
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { GOLD_CATEGORIES } from './dataset.ts'
import type { GoldCategory, GoldSpan, NegativeSpan, Sample, Span } from './dataset.ts'

/** A loaded held-out set and the file it came from. */
export interface HeldOutSet {
  fileName: string
  sha256: string
  samples: Sample[]
}

const MANIFEST_FILE = 'MANIFEST'
const MANIFEST_LINE = /^([0-9a-f]{64})\s+\*?(.+)$/

/**
 * Load a held-out set after checking its hash against the MANIFEST beside it.
 * @param path - the JSONL file.
 * @returns its samples, file name, and SHA-256.
 * @throws {Error} when the file is not in the MANIFEST, its hash differs, or a record is malformed.
 */
export function loadHeldOutSet(path: string): HeldOutSet {
  const contents = readFileSync(path)
  const fileName = basename(path)
  const sha256 = createHash('sha256').update(contents).digest('hex')
  const expected = manifestHash(join(dirname(path), MANIFEST_FILE), fileName)
  if (sha256 !== expected) throw new Error(`${fileName} has SHA-256 ${sha256}, but ${MANIFEST_FILE} records ${expected}`)
  const lines = contents.toString('utf8').split('\n').filter(line => line.trim() !== '')
  return { fileName, sha256, samples: lines.map((line, i) => parseRecord(line, `${fileName}:${i + 1}`)) }
}

function manifestHash(manifestPath: string, fileName: string): string {
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    const [, hash, name] = MANIFEST_LINE.exec(line.trim()) ?? []
    if (name === fileName && hash !== undefined) return hash
  }
  throw new Error(`${manifestPath} has no SHA-256 line for ${fileName}`)
}

/**
 * Parse and validate one held-out record.
 * @param line - one JSONL line.
 * @param where - file and line number for error messages.
 * @returns the sample.
 * @throws {Error} naming `where` when a field is missing or an offset does not match its value.
 */
export function parseRecord(line: string, where: string): Sample {
  const record = JSON.parse(line) as Record<string, unknown>
  const text = requireString(record.text, `${where} text`)
  return {
    id: requireString(record.id, `${where} id`),
    language: requireString(record.lang, `${where} lang`),
    format: requireString(record.format, `${where} format`),
    text,
    gold: requireArray(record.spans, `${where} spans`).map((span, i) => parseGoldSpan(span, text, `${where} spans[${i}]`)),
    negatives: requireArray(record.negatives, `${where} negatives`).map((span, i) => parseNegativeSpan(span, text, `${where} negatives[${i}]`)),
  }
}

function parseGoldSpan(raw: unknown, text: string, where: string): GoldSpan {
  const fields = raw as Record<string, unknown>
  const span = parseSpan(fields, text, where)
  const value = requireString(fields.value, `${where} value`)
  requireSliceEquals(text, span, value, where)
  const category = requireString(fields.category, `${where} category`)
  if (!(GOLD_CATEGORIES as readonly string[]).includes(category)) throw new Error(`${where} category ${category} is not one of ${GOLD_CATEGORIES.join(', ')}`)
  return { ...span, category: category as GoldCategory, ...(fields.core === undefined ? {} : { core: parseCore(fields.core, span, value, text, where) }) }
}

function parseCore(raw: unknown, span: Span, value: string, text: string, where: string): Span {
  if (typeof raw === 'string') {
    const offset = value.indexOf(raw)
    if (raw === '' || offset < 0 || value.indexOf(raw, offset + 1) >= 0) throw new Error(`${where} core "${raw}" must occur exactly once in the value`)
    return { start: span.start + offset, end: span.start + offset + raw.length }
  }
  const core = parseSpan(raw as Record<string, unknown>, text, `${where} core`)
  if (core.start < span.start || core.end > span.end) throw new Error(`${where} core must lie inside the span`)
  return core
}

function parseNegativeSpan(raw: unknown, text: string, where: string): NegativeSpan {
  const fields = raw as Record<string, unknown>
  const span = parseSpan(fields, text, where)
  if (fields.value !== undefined) requireSliceEquals(text, span, requireString(fields.value, `${where} value`), where)
  return { ...span, kind: requireString(fields.kind ?? fields.category, `${where} kind`) }
}

function parseSpan(fields: Record<string, unknown>, text: string, where: string): Span {
  const { start, end } = fields
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`${where} needs integer start and end`)
  const span = { start: start as number, end: end as number }
  if (span.start < 0 || span.end <= span.start || span.end > text.length) throw new Error(`${where} offsets ${span.start}..${span.end} are out of range`)
  return span
}

function requireSliceEquals(text: string, span: Span, value: string, where: string): void {
  const actual = text.slice(span.start, span.end)
  if (actual !== value) throw new Error(`${where} offsets ${span.start}..${span.end} hold "${actual}", not the value "${value}"`)
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value
}
