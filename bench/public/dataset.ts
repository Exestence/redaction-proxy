/**
 * Seeded dataset builder for the public benchmark. Each sample is one filled
 * template with the exact UTF-16 offsets of every sensitive value (gold
 * spans) and of every hard negative.
 *
 * @module bench/public/dataset
 */

import { createRandom } from './random.ts'
import type { Random } from './random.ts'
import { FORMATS, TEMPLATES } from './templates.ts'
import * as values from './values.ts'
import { LANGUAGES } from './values.ts'
import type { Language } from './values.ts'

/** What a sensitive value is, independent of how any detector names it. */
export type GoldCategory =
  | 'PERSON' | 'EMAIL' | 'PHONE' | 'NATIONAL_ID' | 'CARD' | 'SECRET' | 'HOME_PATH' | 'PRIVATE_IP' | 'INTERNAL_HOST'

/** Every gold category, in report order. */
export const GOLD_CATEGORIES: readonly GoldCategory[] = [
  'PERSON', 'EMAIL', 'PHONE', 'NATIONAL_ID', 'CARD', 'SECRET', 'HOME_PATH', 'PRIVATE_IP', 'INTERNAL_HOST',
]

/** What a hard negative is: a value no detector should mask. */
export type NegativeKind =
  | 'commit-hash' | 'sha256' | 'uuid' | 'version' | 'order-number' | 'tracking-number' | 'epoch-millis' | 'code-identifier'

/** A range of a sample's text; `end` is exclusive, offsets are UTF-16 code units. */
export interface Span {
  start: number
  end: number
}

/** A sensitive value inside a sample. */
export interface GoldSpan extends Span {
  category: GoldCategory
  /** The part of the value that identifies someone, such as the user name of a home path; absent when the set gives none. */
  core?: Span
}

/** A hard negative inside a sample; `kind` names what it is, such as `uuid`. */
export interface NegativeSpan extends Span {
  kind: string
}

/** One benchmark prompt with its ground truth. Language and format are free text so a held-out set may add its own. */
export interface Sample {
  id: string
  language: string
  format: string
  text: string
  gold: GoldSpan[]
  negatives: NegativeSpan[]
}

/** What a template slot produces and how the ground truth labels it. */
type SlotDefinition =
  | { gold: GoldCategory; generate: (random: Random, language: Language) => string }
  | { negative: NegativeKind; generate: (random: Random, language: Language) => string }

const SLOTS: Readonly<Record<string, SlotDefinition>> = {
  person: { gold: 'PERSON', generate: values.personName },
  email: { gold: 'EMAIL', generate: values.emailAddress },
  phone: { gold: 'PHONE', generate: values.phoneNumber },
  nationalId: { gold: 'NATIONAL_ID', generate: values.nationalId },
  card: { gold: 'CARD', generate: values.cardNumber },
  secret: { gold: 'SECRET', generate: values.apiCredential },
  password: { gold: 'SECRET', generate: values.password },
  homePath: { gold: 'HOME_PATH', generate: values.homeDirectory },
  privateIp: { gold: 'PRIVATE_IP', generate: values.privateIp },
  internalHost: { gold: 'INTERNAL_HOST', generate: values.internalHost },
  commit: { negative: 'commit-hash', generate: values.commitHash },
  sha256: { negative: 'sha256', generate: values.sha256Digest },
  uuid: { negative: 'uuid', generate: values.uuid },
  version: { negative: 'version', generate: values.semanticVersion },
  order: { negative: 'order-number', generate: values.orderNumber },
  tracking: { negative: 'tracking-number', generate: values.trackingNumber },
  epoch: { negative: 'epoch-millis', generate: values.epochMillis },
  identifier: { negative: 'code-identifier', generate: values.codeIdentifier },
}

const SLOT_PATTERN = /\{(\w+)\}/g

// Capture group 1 is the part that identifies a person or machine; the rest is a fixed prefix or suffix
// that a detector may leave unmasked without exposing anyone.
const CORE_PATTERNS: Readonly<Partial<Record<GoldCategory, RegExp>>> = {
  PHONE: /^(?:\+\d+ )?(.+)$/d,
  HOME_PATH: /^\/(?:Users|home)\/(.+)$/d,
  INTERNAL_HOST: /^([^.]+)\./d,
}

/** Dataset size and seed. */
export interface DatasetOptions {
  seed: number
  /** Samples per language and format pair. */
  samplesPerCell: number
}

/**
 * Build the dataset: `samplesPerCell` samples for every language and format.
 * @param options - seed and size.
 * @returns the samples, in language, format, index order.
 */
export function buildDataset(options: DatasetOptions): Sample[] {
  const random = createRandom(options.seed)
  return LANGUAGES.flatMap(language => FORMATS.flatMap(format =>
    Array.from({ length: options.samplesPerCell }, (_, index) => {
      const template = random.pick(TEMPLATES[language][format])
      return { id: `${language}/${format}/${index}`, language, format, ...fillTemplate(template, random, language) }
    })))
}

/**
 * Replace every slot of a template with a generated value and record where it landed.
 * @param template - text with `{slot}` markers.
 * @param random - random source.
 * @param language - language the values are generated for.
 * @returns the filled text and its labelled spans.
 * @throws {Error} on a slot name `SLOTS` does not define.
 */
export function fillTemplate(template: string, random: Random, language: Language): Pick<Sample, 'text' | 'gold' | 'negatives'> {
  const gold: GoldSpan[] = []
  const negatives: NegativeSpan[] = []
  let text = ''
  let cursor = 0
  for (const match of template.matchAll(SLOT_PATTERN)) {
    const name = match[1] ?? ''
    const slot = SLOTS[name]
    if (slot === undefined) throw new Error(`template slot {${name}} is not defined`)
    text += template.slice(cursor, match.index)
    const value = slot.generate(random, language)
    const span = { start: text.length, end: text.length + value.length }
    if ('gold' in slot) gold.push({ ...span, category: slot.gold, ...coreOf(slot.gold, value, span.start) })
    else negatives.push({ ...span, kind: slot.negative })
    text += value
    cursor = match.index + match[0].length
  }
  return { text: text + template.slice(cursor), gold, negatives }
}

function coreOf(category: GoldCategory, value: string, valueStart: number): Pick<GoldSpan, 'core'> {
  const range = CORE_PATTERNS[category]?.exec(value)?.indices?.[1]
  return range === undefined ? {} : { core: { start: valueStart + range[0], end: valueStart + range[1] } }
}
