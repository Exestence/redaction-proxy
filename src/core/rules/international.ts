/**
 * Opt-in rules for identifiers issued outside Taiwan: IBANs, international
 * telephone numbers, EU VAT numbers, and national identification numbers of
 * the United States, the United Kingdom, Germany, France, Spain, Italy,
 * mainland China, Hong Kong, Japan, and Korea, plus Chinese and Japanese
 * mobile numbers. Every rule with a check digit verifies it. A value with no
 * check digit, or one whose bare digits read like any log identifier, is
 * matched only in its grouped spelling or right after a keyword.
 *
 * @module redaction-proxy/core/rules/international
 */

import type { PushCandidate } from './candidate.ts'
import { PRIORITY_PII } from './candidate.ts'
import {
  isChinaResidentIdChecksumValid,
  isEuVatNumber,
  isFrenchNir,
  isGermanTaxId,
  isHongKongIdentityNumber,
  isIbanChecksumValid,
  isItalianFiscalCode,
  isKoreaResidentNumberChecksumValid,
  isMyNumber,
  isSpanishIdentityNumber,
} from './checksum.ts'

/** Names of the opt-in international rules. */
export type InternationalRuleName =
  | 'iban'
  | 'e164-phone'
  | 'eu-vat'
  | 'us-ssn'
  | 'us-itin'
  | 'uk-nino'
  | 'de-tax-id'
  | 'fr-nir'
  | 'es-dni'
  | 'it-fiscal-code'
  | 'cn-resident-id'
  | 'cn-mobile'
  | 'hk-id'
  | 'jp-my-number'
  | 'jp-mobile'
  | 'kr-rrn'

/** Every international rule name, in declaration order. */
export const INTERNATIONAL_RULE_NAMES: readonly InternationalRuleName[] = [
  'iban', 'e164-phone', 'eu-vat', 'us-ssn', 'us-itin', 'uk-nino', 'de-tax-id', 'fr-nir', 'es-dni',
  'it-fiscal-code', 'cn-resident-id', 'cn-mobile', 'hk-id', 'jp-my-number', 'jp-mobile', 'kr-rrn',
]

/**
 * Whether a rule name names an international rule.
 * @param rule - a built-in rule name.
 * @returns whether it is one of {@link INTERNATIONAL_RULE_NAMES}.
 */
export function isInternationalRule(rule: string): rule is InternationalRuleName {
  return (INTERNATIONAL_RULE_NAMES as readonly string[]).includes(rule)
}

/**
 * Version of the international rules, appended to the detector version while
 * any of them is enabled; changes whenever one of their matches changes.
 */
export const INTERNATIONAL_RULES_VERSION = 'intl-1'

/** Placeholder category of national identification numbers outside Taiwan. */
const NATIONAL_ID = 'NATID'

/** Category each international rule reports. */
export const INTERNATIONAL_RULE_CATEGORIES: Readonly<Record<InternationalRuleName, string>> = {
  'iban': 'IBAN',
  'e164-phone': 'PHONE',
  'eu-vat': 'TAXID',
  'us-ssn': NATIONAL_ID,
  'us-itin': NATIONAL_ID,
  'uk-nino': NATIONAL_ID,
  'de-tax-id': NATIONAL_ID,
  'fr-nir': NATIONAL_ID,
  'es-dni': NATIONAL_ID,
  'it-fiscal-code': NATIONAL_ID,
  'cn-resident-id': NATIONAL_ID,
  'cn-mobile': 'PHONE',
  'hk-id': NATIONAL_ID,
  'jp-my-number': NATIONAL_ID,
  'jp-mobile': 'PHONE',
  'kr-rrn': NATIONAL_ID,
}

/** No ASCII letter or digit right before a value, so it is not the tail of a longer token. */
const LEFT_EDGE = '(?<![A-Za-z0-9])'
/** No ASCII letter or digit right after a value. */
const RIGHT_EDGE = '(?![A-Za-z0-9])'
/**
 * Like {@link LEFT_EDGE}, and not a group of a longer hyphenated run such as a
 * UUID or of a longer run of space-separated digit groups such as a table row.
 */
const GROUPED_LEFT_EDGE = '(?<![A-Za-z0-9-]|\\d )'
/** Characters between a keyword and its value: a colon, a space, a short word such as `is`. */
const KEYWORD_GAP = '[^\\n]{0,8}?'
/** Separators removed from a matched value before its check runs. */
const VALUE_SEPARATORS = /[\s().-]/g

/** IBAN length of each country in the SWIFT IBAN registry. */
const IBAN_LENGTHS: ReadonlyMap<string, number> = new Map(
  ('AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DK18 DO28 EE20 EG29 '
    + 'ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 '
    + 'LB28 LC32 LI21 LT20 LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 '
    + 'RO24 RS22 SA24 SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20')
    .split(' ')
    .map(entry => [entry.slice(0, 2), Number(entry.slice(2))]),
)
const IBAN = new RegExp(
  `${LEFT_EDGE}[A-Z]{2}\\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)${RIGHT_EDGE}`,
  'g',
)

/** Fewest and most digits, country code included, an international number is accepted with. */
const E164_DIGITS_MIN = 10
const E164_DIGITS_MAX = 15
/** One-digit ITU country codes: North America and Russia/Kazakhstan. */
const E164_ONE_DIGIT_CODES = new Set(['1', '7'])
/** Assigned two-digit ITU country codes. */
const E164_TWO_DIGIT_CODES = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
])
/** Leading digit pairs of the zones whose ITU country codes have three digits. */
const E164_THREE_DIGIT_ZONES = new Set([
  '21', '22', '23', '24', '25', '26', '29', '35', '37', '38', '42', '50', '59', '67', '68', '69', '85', '87', '88', '96', '97', '99',
])
/**
 * `+`, a country code, and digits with at most one space, dot, or hyphen
 * between them, where a bracketed area code (`(415)`, `(0)`) counts as one
 * step. Not after a letter, digit, `+`, `)`, `]`, or `.`, so `1e+10` and
 * `f(x)+12345678` are arithmetic, not a number; `offset=+86400000` has too
 * few digits to be one.
 */
const E164 = /(?<![A-Za-z0-9+)\].])\+[1-9](?:[ .-]?(?:\(\d{1,4}\)|\d)){6,16}(?![A-Za-z0-9]|[.-]\d)/g

/** United States SSN or ITIN with its usual separators: `123-45-6789`, `123 45 6789`. */
const US_TAXPAYER_GROUPED = new RegExp(`${GROUPED_LEFT_EDGE}\\d{3}([- ])\\d{2}\\1\\d{4}(?![A-Za-z0-9]|\\1\\d)`, 'g')
const US_TAXPAYER_KEYWORDS = ['ssn', 'social security(?: number)?', 'itin', 'taxpayer identification number']
/** SSN areas the Social Security Administration never assigns. */
const SSN_UNASSIGNED_AREAS = new Set(['000', '666'])
const SSN_ZERO_GROUP = '00'
const SSN_ZERO_SERIAL = '0000'
/** ITIN area numbers start with 9, the area range the SSA never assigns. */
const ITIN_AREA_PREFIX = '9'
/** ITIN group numbers the IRS issues. */
const ITIN_GROUP_RANGES: readonly (readonly [number, number])[] = [[50, 65], [70, 88], [90, 92], [94, 99]]

/**
 * UK National Insurance number: two prefix letters (never D, F, I, Q, U, or V;
 * O not second; not BG, GB, KN, NK, NT, TN, or ZZ), six digits, and a suffix
 * A to D, written whole or as `AB 12 34 56 C`. It has no check character.
 */
const UK_NINO = new RegExp(
  `${LEFT_EDGE}(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z](?:\\d{6}| \\d{2} \\d{2} \\d{2} )[A-D]${RIGHT_EDGE}`,
  'g',
)

/** VAT prefix of each EU country whose check this module implements, then the number. */
const EU_VAT = new RegExp(`${LEFT_EDGE}(?:AT|BE|DE|ES|FR|IT|NL|PL) ?[A-Z0-9]{8,12}${RIGHT_EDGE}`, 'g')
const EU_VAT_PREFIX_LENGTH = 2

const GERMAN_TAX_ID_KEYWORDS = [
  'steuer-?id', 'steuer-?identifikationsnummer', 'identifikationsnummer', 'idnr', 'tax id', 'tin',
]
/** Eleven digits, whole or grouped 2-3-3-3 as printed on the tax notice. */
const GERMAN_TAX_ID_VALUE = '\\d{11}|\\d{2} \\d{3} \\d{3} \\d{3}'

/** French NIR spaced as printed on the Carte Vitale: `1 85 05 78 006 084 91`. */
const FRENCH_NIR_SPACED = new RegExp(
  `${LEFT_EDGE}[12] \\d{2} (?:0[1-9]|1[0-2]|[2-9]\\d) (?:\\d{2}|2[AB]) \\d{3} \\d{3} \\d{2}${RIGHT_EDGE}`,
  'g',
)
const FRENCH_NIR_KEYWORDS = ['nir', 'insee', 'sécurité sociale', 'securite sociale', 'numéro de sécu', 'numero de secu']
const FRENCH_NIR_VALUE = '[12]\\d{4}(?:\\d{2}|2[AB])\\d{8}'

/** Spanish DNI (`12345678Z`) or NIE (`X1234567L`), with an optional hyphen before the letter. */
const SPANISH_ID = new RegExp(`${LEFT_EDGE}(?:\\d{8}|[XYZ]\\d{7})-?[A-Z]${RIGHT_EDGE}`, 'g')

/** A digit, or an omocode letter standing in for one in an Italian fiscal code. */
const FISCAL_DIGIT = '[\\dLMNPQRSTUV]'
/** Italian fiscal code: surname, name, birth year, month letter, day, place, check. */
const ITALIAN_FISCAL_CODE = new RegExp(
  `${LEFT_EDGE}[A-Z]{6}${FISCAL_DIGIT}{2}[A-EHLMPRST]${FISCAL_DIGIT}{2}[A-Z]${FISCAL_DIGIT}{3}[A-Z]${RIGHT_EDGE}`,
  'g',
)

const CHINA_RESIDENT_ID = new RegExp(`${LEFT_EDGE}[1-9]\\d{16}[\\dXx]${RIGHT_EDGE}`, 'g')
/** Leading two digits of the mainland, Taiwan, Hong Kong, and Macau region codes in GB/T 2260. */
const CHINA_PROVINCE_CODES = new Set([
  '11', '12', '13', '14', '15', '21', '22', '23', '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46', '50', '51', '52', '53', '54', '61', '62', '63', '64', '65',
  '71', '81', '82', '83',
])
const CHINA_BIRTH_DATE_START = 6
const CHINA_BIRTH_DATE_END = 14
const BIRTH_YEAR_MIN = 1900
const BIRTH_YEAR_MAX = 2099

/** Hong Kong identity card number with its bracketed check character: `A123456(3)`. */
const HONG_KONG_ID_BRACKETED = new RegExp(`${LEFT_EDGE}[A-Z]{1,2}\\d{6}\\([\\dA]\\)`, 'g')
const HONG_KONG_ID_KEYWORDS = ['hkid', '香港身份證', '香港身分證', '身份證', 'identity card']
const HONG_KONG_ID_VALUE = '[A-Z]{1,2}\\d{6}[\\dA]'

const MY_NUMBER_KEYWORDS = ['マイナンバー', '個人番号', 'my ?number']
const MY_NUMBER_VALUE = '\\d{4}[- ]?\\d{4}[- ]?\\d{4}'

/** Korean resident registration number: birth date, hyphen, gender-century digit, six digits. */
const KOREA_RRN = new RegExp(`${GROUPED_LEFT_EDGE}\\d{6}-[1-8]\\d{6}(?![A-Za-z0-9]|-\\d)`, 'g')
/** First year of the birth century each gender-century digit encodes. */
const KOREA_RRN_CENTURY_START: Readonly<Record<string, number>> = {
  1: 1900, 2: 1900, 5: 1900, 6: 1900, 3: 2000, 4: 2000, 7: 2000, 8: 2000,
}
/** Position, counted from one, of the digit that encodes gender and birth century. */
const KOREA_RRN_GENDER_DIGIT = 7

/** Words that introduce a telephone number in the languages the mobile rules serve. */
const PHONE_KEYWORDS = [
  '手机', '手機', '电话', '電話', '联系', '聯繫', '联络', '聯絡', '携帯', 'ケータイ', 'mobile', 'phone', 'telephone', 'tel', 'cell',
]

/** How one country writes a mobile number. */
interface MobileNumberFormat {
  /** ITU country code without `+`. */
  countryCode: string
  /** The first three digits as dialled at home, as a pattern. */
  domesticPrefix: string
  /** The digits after the country code that replace the domestic prefix, as a pattern. */
  internationalPrefix: string
}

/** Chinese mobile numbers: `138-1234-5678`, `+86 138 1234 5678`. */
const CHINA_MOBILE: MobileNumberFormat = { countryCode: '86', domesticPrefix: '1[3-9]\\d', internationalPrefix: '1[3-9]\\d' }
/** Japanese mobile numbers: `090-1234-5678`, `+81 90-1234-5678`. */
const JAPAN_MOBILE: MobileNumberFormat = { countryCode: '81', domesticPrefix: '0[789]0', internationalPrefix: '[789]0' }

/** How one rule finds and checks its values. */
interface ValidatedRule {
  /** Global patterns; a `value` group, when present, is the value, otherwise the whole match is. */
  patterns: readonly RegExp[]
  /**
   * Check on the value with spaces, hyphens, dots, and brackets removed.
   * @param compact - the matched value without separators.
   * @returns whether the value is one this rule reports.
   */
  isValid: (compact: string) => boolean
}

/** One rule pass over one text. */
export type InternationalCollector = (text: string, push: PushCandidate) => void

/**
 * A keyword pattern that matches its ASCII letters in either case. The value
 * after a keyword keeps its case, which a case-insensitive flag on the whole
 * pattern would not.
 * @param keyword - lower-case keyword pattern without character classes.
 * @returns the pattern with each ASCII letter widened to both cases.
 */
function anyCase(keyword: string): string {
  return keyword.replaceAll(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`)
}

/**
 * A pattern that matches a value only within a few characters after one of
 * its keywords, for values whose bare digits read like any log identifier.
 * @param keywords - lower-case keyword patterns, matched in any case as whole words.
 * @param value - the value's pattern, captured as the `value` group.
 * @returns a global pattern with match indices.
 */
function valueAfterKeyword(keywords: readonly string[], value: string): RegExp {
  const keyword = `(?<![A-Za-z])(?:${keywords.map(anyCase).join('|')})(?![A-Za-z])`
  return new RegExp(`${keyword}${KEYWORD_GAP}${LEFT_EDGE}(?<value>${value})${RIGHT_EDGE}`, 'gd')
}

/**
 * The patterns of a mobile number format: grouped 3-4-4 with one consistent
 * separator, after `+` and the country code, or bare after a keyword.
 * @param format - the country's prefixes.
 * @returns the format's patterns.
 */
function mobilePatterns(format: MobileNumberFormat): RegExp[] {
  return [
    new RegExp(`${GROUPED_LEFT_EDGE}${format.domesticPrefix}([- ])\\d{4}\\1\\d{4}(?![A-Za-z0-9]|\\1\\d)`, 'g'),
    new RegExp(`(?<![A-Za-z0-9+])\\+${format.countryCode}[- ]?${format.internationalPrefix}([- ]?)\\d{4}\\1\\d{4}${RIGHT_EDGE}`, 'g'),
    valueAfterKeyword(PHONE_KEYWORDS, `${format.domesticPrefix}\\d{8}`),
  ]
}

/**
 * Whether eight digits name a real calendar date in the accepted birth years.
 * @param yyyymmdd - four-digit year, two-digit month, two-digit day.
 * @returns whether the date exists.
 */
function isBirthDate(yyyymmdd: string): boolean {
  const year = Number(yyyymmdd.slice(0, 4))
  const monthIndex = Number(yyyymmdd.slice(4, 6)) - 1
  const day = Number(yyyymmdd.slice(6, 8))
  if (year < BIRTH_YEAR_MIN || year > BIRTH_YEAR_MAX) return false
  const date = new Date(Date.UTC(year, monthIndex, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex && date.getUTCDate() === day
}

/**
 * Whether an IBAN has its country's registered length and a valid check.
 * @param iban - the IBAN without spaces.
 * @returns whether both hold.
 */
function isIban(iban: string): boolean {
  return IBAN_LENGTHS.get(iban.slice(0, 2)) === iban.length && isIbanChecksumValid(iban)
}

/**
 * Whether `+` and its digits form an international number of plausible length
 * whose leading digits are an assigned ITU country code.
 * @param compact - `+` and the digits.
 * @returns whether the number is plausible.
 */
function isInternationalPhoneNumber(compact: string): boolean {
  const digits = compact.slice(1)
  if (digits.length < E164_DIGITS_MIN || digits.length > E164_DIGITS_MAX) return false
  const leadingPair = digits.slice(0, 2)
  return E164_ONE_DIGIT_CODES.has(digits.charAt(0))
    || E164_TWO_DIGIT_CODES.has(leadingPair)
    || E164_THREE_DIGIT_ZONES.has(leadingPair)
}

/**
 * Whether nine digits are an SSN the Social Security Administration could
 * have issued: area not 000, 666, or 900-999, group not 00, serial not 0000.
 * @param digits - nine digits.
 * @returns whether every part is in an assigned range.
 */
function isUsSocialSecurityNumber(digits: string): boolean {
  const area = digits.slice(0, 3)
  if (SSN_UNASSIGNED_AREAS.has(area) || area.startsWith(ITIN_AREA_PREFIX)) return false
  return digits.slice(3, 5) !== SSN_ZERO_GROUP && digits.slice(5) !== SSN_ZERO_SERIAL
}

/**
 * Whether nine digits are an ITIN: area 900-999 and a group number the IRS issues.
 * @param digits - nine digits.
 * @returns whether both hold.
 */
function isUsItin(digits: string): boolean {
  const group = Number(digits.slice(3, 5))
  return digits.startsWith(ITIN_AREA_PREFIX) && ITIN_GROUP_RANGES.some(([low, high]) => group >= low && group <= high)
}

/**
 * Whether eighteen characters are a Chinese resident identity number: a known
 * province, a real birth date, and a valid check character.
 * @param value - seventeen digits and a digit or `X`.
 * @returns whether all three hold.
 */
function isChinaResidentId(value: string): boolean {
  if (!CHINA_PROVINCE_CODES.has(value.slice(0, 2))) return false
  return isBirthDate(value.slice(CHINA_BIRTH_DATE_START, CHINA_BIRTH_DATE_END)) && isChinaResidentIdChecksumValid(value)
}

/**
 * Whether thirteen digits are a Korean resident registration number with a
 * real birth date and a valid check digit. Numbers issued since October 2020
 * end in random digits and fail the check, so they are not reported.
 * @param digits - thirteen digits.
 * @returns whether both hold.
 */
function isKoreaResidentNumber(digits: string): boolean {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern admits gender digits 1-8 only.
  const century = KOREA_RRN_CENTURY_START[digits.charAt(KOREA_RRN_GENDER_DIGIT - 1)]!
  const year = century + Number(digits.slice(0, 2))
  return isBirthDate(`${year}${digits.slice(2, 6)}`) && isKoreaResidentNumberChecksumValid(digits)
}

/**
 * The pass that runs one rule's patterns and reports each checked value.
 * @param rule - the rule's patterns and check.
 * @param category - the placeholder category the pass reports.
 * @returns the pass.
 */
function collectorOf(rule: ValidatedRule, category: string): InternationalCollector {
  return (text, push) => {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        const [start, end] = match.indices?.groups?.value ?? [match.index, match.index + match[0].length]
        if (rule.isValid(text.slice(start, end).replaceAll(VALUE_SEPARATORS, ''))) push(start, end, category, PRIORITY_PII)
      }
    }
  }
}

const usTaxpayerPatterns = [US_TAXPAYER_GROUPED, valueAfterKeyword(US_TAXPAYER_KEYWORDS, '\\d{9}')]
/** Check of a rule whose pattern alone carries every constraint the identifier has. */
const acceptsEveryMatch = (): boolean => true

/** Patterns and check of every international rule. */
const INTERNATIONAL_RULES: Readonly<Record<InternationalRuleName, ValidatedRule>> = {
  'iban': { patterns: [IBAN], isValid: isIban },
  'e164-phone': { patterns: [E164], isValid: isInternationalPhoneNumber },
  'eu-vat': {
    patterns: [EU_VAT],
    isValid: compact => isEuVatNumber(compact.slice(0, EU_VAT_PREFIX_LENGTH), compact.slice(EU_VAT_PREFIX_LENGTH)),
  },
  'us-ssn': { patterns: usTaxpayerPatterns, isValid: isUsSocialSecurityNumber },
  'us-itin': { patterns: usTaxpayerPatterns, isValid: isUsItin },
  'uk-nino': { patterns: [UK_NINO], isValid: acceptsEveryMatch },
  'de-tax-id': { patterns: [valueAfterKeyword(GERMAN_TAX_ID_KEYWORDS, GERMAN_TAX_ID_VALUE)], isValid: isGermanTaxId },
  'fr-nir': {
    patterns: [FRENCH_NIR_SPACED, valueAfterKeyword(FRENCH_NIR_KEYWORDS, FRENCH_NIR_VALUE)],
    isValid: isFrenchNir,
  },
  'es-dni': { patterns: [SPANISH_ID], isValid: isSpanishIdentityNumber },
  'it-fiscal-code': { patterns: [ITALIAN_FISCAL_CODE], isValid: isItalianFiscalCode },
  'cn-resident-id': { patterns: [CHINA_RESIDENT_ID], isValid: isChinaResidentId },
  'cn-mobile': { patterns: mobilePatterns(CHINA_MOBILE), isValid: acceptsEveryMatch },
  'hk-id': {
    patterns: [HONG_KONG_ID_BRACKETED, valueAfterKeyword(HONG_KONG_ID_KEYWORDS, HONG_KONG_ID_VALUE)],
    isValid: isHongKongIdentityNumber,
  },
  'jp-my-number': { patterns: [valueAfterKeyword(MY_NUMBER_KEYWORDS, MY_NUMBER_VALUE)], isValid: isMyNumber },
  'jp-mobile': { patterns: mobilePatterns(JAPAN_MOBILE), isValid: acceptsEveryMatch },
  'kr-rrn': { patterns: [KOREA_RRN], isValid: isKoreaResidentNumber },
}

/** The pass of every international rule, keyed by rule name. */
export const INTERNATIONAL_COLLECTORS: Readonly<Record<InternationalRuleName, InternationalCollector>> = Object.fromEntries(
  INTERNATIONAL_RULE_NAMES.map(name => [name, collectorOf(INTERNATIONAL_RULES[name], INTERNATIONAL_RULE_CATEGORIES[name])]),
) as Record<InternationalRuleName, InternationalCollector>
