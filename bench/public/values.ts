/**
 * Synthetic values for the public benchmark: personal data and secrets that
 * belong to no one, and hard negatives that look like them. Identification
 * and card numbers carry valid check digits so a checksum-verifying detector
 * is tested on its real work; every e-mail domain is a reserved example domain.
 *
 * @module bench/public/values
 */

import type { Random } from './random.ts'

/** Prompt languages the dataset covers. */
export type Language = 'en' | 'zh-TW' | 'zh-CN' | 'ja'

/** Every language, in report order. */
export const LANGUAGES: readonly Language[] = ['en', 'zh-TW', 'zh-CN', 'ja']

const HEX = '0123456789abcdef'
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER_ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const BASE64URL = `${ALPHANUMERIC}-_`
const PASSWORD_CHARACTERS = `${ALPHANUMERIC}!#%&*+?@^`

// Reserved second-level domains under real top-level domains, so TLD-validating detectors accept them.
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net', 'mail.example.com', 'corp.example.org']
const HOST_WORDS = ['db', 'nas', 'build', 'vault', 'grafana', 'ci-runner', 'files', 'kafka']
const INTERNAL_SUFFIXES = ['internal', 'local', 'lan']

/** Names in the language's script, and romanized name parts for addresses and user names. */
interface LocaleNames {
  family: readonly string[]
  given: readonly string[]
  romanFamily: readonly string[]
  romanGiven: readonly string[]
}

// Common name parts drawn independently; any match with a real person is coincidence.
const NAMES: Readonly<Record<Language, LocaleNames>> = {
  'en': {
    family: ['Carter', 'Nguyen', 'Patel', 'Brooks', 'Ramirez', 'Foster', 'Hughes', 'Kimball'],
    given: ['James', 'Olivia', 'Ethan', 'Mia', 'Lucas', 'Ava', 'Noah', 'Chloe'],
    romanFamily: ['carter', 'nguyen', 'patel', 'brooks', 'ramirez', 'foster', 'hughes', 'kimball'],
    romanGiven: ['james', 'olivia', 'ethan', 'mia', 'lucas', 'ava', 'noah', 'chloe'],
  },
  'zh-TW': {
    family: ['陳', '林', '黃', '張', '李', '王', '吳', '劉'],
    given: ['怡君', '雅婷', '志明', '家豪', '淑芬', '俊傑', '宜蓁', '冠宇'],
    romanFamily: ['chen', 'lin', 'huang', 'chang', 'lee', 'wang', 'wu', 'liu'],
    romanGiven: ['yichun', 'yating', 'chihming', 'chiahao', 'shufen', 'chunchieh', 'yichen', 'kuanyu'],
  },
  'zh-CN': {
    family: ['王', '李', '张', '刘', '陈', '杨', '赵', '周'],
    given: ['伟', '芳', '秀英', '静', '强', '磊', '洋', '艳'],
    romanFamily: ['wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'zhao', 'zhou'],
    romanGiven: ['wei', 'fang', 'xiuying', 'jing', 'qiang', 'lei', 'yang', 'yan'],
  },
  'ja': {
    family: ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村'],
    given: ['翔太', '美咲', '大輔', '陽菜', '健一', 'さくら', '拓海', '由美'],
    romanFamily: ['sato', 'suzuki', 'takahashi', 'tanaka', 'ito', 'watanabe', 'yamamoto', 'nakamura'],
    romanGiven: ['shota', 'misaki', 'daisuke', 'hina', 'kenichi', 'sakura', 'takumi', 'yumi'],
  },
}

/**
 * @param random - random source.
 * @param language - name script.
 * @returns a full name written the way the language writes it.
 */
export function personName(random: Random, language: Language): string {
  const names = NAMES[language]
  const family = random.pick(names.family)
  const given = random.pick(names.given)
  return language === 'en' ? `${given} ${family}` : `${family}${given}`
}

/**
 * @param random - random source.
 * @param language - name pool for the local part.
 * @returns an address at a reserved example domain.
 */
export function emailAddress(random: Random, language: Language): string {
  const names = NAMES[language]
  const separator = random.pick(['.', '_', ''])
  return `${random.pick(names.romanGiven)}${separator}${random.pick(names.romanFamily)}@${random.pick(EXAMPLE_DOMAINS)}`
}

/**
 * @param random - random source.
 * @param language - name pool for the user name.
 * @returns a macOS or Linux home directory, the part of a path that names a person.
 */
export function homeDirectory(random: Random, language: Language): string {
  const user = `${random.pick(NAMES[language].romanGiven)}${random.pick(['', '.', '-'])}${random.pick(NAMES[language].romanFamily)}`
  return `${random.pick(['/Users', '/home'])}/${user}`
}

/**
 * @param random - random source.
 * @param language - picks the country numbering plan.
 * @returns a mobile number in a format people write in that language.
 */
export function phoneNumber(random: Random, language: Language): string {
  switch (language) {
    case 'en': return `+1 (${random.int(201, 989)}) 555-01${random.digits(2)}`
    case 'zh-TW': return random.pick([`09${random.digits(2)}-${random.digits(3)}-${random.digits(3)}`, `+886 9${random.digits(2)} ${random.digits(3)} ${random.digits(3)}`])
    case 'zh-CN': return random.pick([`1${random.pick(['3', '5', '8'])}${random.digits(9)}`, `+86 13${random.digits(1)} ${random.digits(4)} ${random.digits(4)}`])
    case 'ja': return random.pick([`090-${random.digits(4)}-${random.digits(4)}`, `+81 80-${random.digits(4)}-${random.digits(4)}`])
  }
}

/**
 * @param random - random source.
 * @param language - picks the country's identification number.
 * @returns a US SSN, a Taiwan national ID, a PRC resident ID, or a Japanese My Number, each with a valid check digit where the scheme has one.
 */
export function nationalId(random: Random, language: Language): string {
  switch (language) {
    case 'en': return `${random.int(100, 665)}-${random.int(10, 99)}-${random.int(1000, 9999)}`
    case 'zh-TW': return taiwanNationalId(random)
    case 'zh-CN': return prcResidentId(random)
    case 'ja': return myNumber(random)
  }
}

const TW_LETTERS = 'ABCDEFGHJKLMNPQRSTUVXYWZIO'
const TW_FIRST_LETTER_VALUE = 10

function taiwanNationalId(random: Random): string {
  const letterIndex = random.int(0, TW_LETTERS.length - 1)
  const letterValue = TW_FIRST_LETTER_VALUE + letterIndex
  const body = `${random.pick(['1', '2'])}${random.digits(7)}`
  const weighted = [...body].reduce((sum, digit, i) => sum + Number(digit) * (body.length - i), 0)
  const sum = Math.floor(letterValue / 10) + (letterValue % 10) * 9 + weighted
  return `${TW_LETTERS[letterIndex]}${body}${(10 - (sum % 10)) % 10}`
}

const PRC_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const PRC_CHECK_CHARACTERS = '10X98765432'
const PRC_ISO_MODULUS = 11

function prcResidentId(random: Random): string {
  const birthDate = `${random.int(1960, 2005)}${String(random.int(1, 12)).padStart(2, '0')}${String(random.int(1, 28)).padStart(2, '0')}`
  const body = `${random.int(110000, 659000)}${birthDate}${random.digits(3)}`
  return `${body}${prcCheckCharacter(body)}`
}

/**
 * ISO 7064 MOD 11-2 check character of a PRC resident ID.
 * @param body - the first 17 digits.
 * @returns the 18th character, a digit or `X`.
 */
export function prcCheckCharacter(body: string): string {
  const sum = [...body].reduce((total, digit, i) => total + Number(digit) * (PRC_WEIGHTS[i] ?? 0), 0)
  return PRC_CHECK_CHARACTERS[sum % PRC_ISO_MODULUS] ?? ''
}

const MY_NUMBER_MODULUS = 11

function myNumber(random: Random): string {
  const body = `${random.int(1, 9)}${random.digits(10)}`
  return `${body}${myNumberCheckDigit(body)}`
}

/**
 * Check digit of a Japanese individual number (My Number).
 * @param body - the first 11 digits.
 * @returns the 12th digit.
 */
export function myNumberCheckDigit(body: string): number {
  const fromRight = [...body].reverse()
  const sum = fromRight.reduce((total, digit, i) => total + Number(digit) * (i < 6 ? i + 2 : i - 4), 0)
  const remainder = sum % MY_NUMBER_MODULUS
  return remainder <= 1 ? 0 : MY_NUMBER_MODULUS - remainder
}

/**
 * Luhn check digit of a partial number.
 * @param partial - every digit but the last.
 * @returns the digit that makes the whole number pass the Luhn check.
 */
export function luhnCheckDigit(partial: string): number {
  const sum = [...partial].reverse().reduce((total, digit, i) => {
    const doubled = i % 2 === 0 ? Number(digit) * 2 : Number(digit)
    return total + (doubled > 9 ? doubled - 9 : doubled)
  }, 0)
  return (10 - (sum % 10)) % 10
}

const CARD_LENGTH = 16
const CARD_GROUP = 4

/**
 * @param random - random source.
 * @returns a Luhn-valid Visa- or Mastercard-shaped number, plain or in groups of four.
 */
export function cardNumber(random: Random): string {
  const prefix = random.pick(['4', `5${random.int(1, 5)}`])
  const partial = `${prefix}${random.digits(CARD_LENGTH - 1 - prefix.length)}`
  const digits = `${partial}${luhnCheckDigit(partial)}`
  const separator = random.pick(['', ' ', '-'])
  return digits.match(new RegExp(`.{${CARD_GROUP}}`, 'g'))?.join(separator) ?? digits
}

/**
 * @param random - random source.
 * @returns a 16-digit number that fails the Luhn check, as a parcel tracking number would.
 */
export function trackingNumber(random: Random): string {
  const partial = `${random.int(1, 9)}${random.digits(CARD_LENGTH - 2)}`
  return `${partial}${(luhnCheckDigit(partial) + random.int(1, 9)) % 10}`
}

/**
 * @param random - random source.
 * @returns a credential with a vendor prefix: OpenAI, GitHub, AWS, Slack, or a JWT.
 */
export function apiCredential(random: Random): string {
  return random.pick([
    () => `sk-proj-${random.string(BASE64URL, 48)}`,
    () => `ghp_${random.string(ALPHANUMERIC, 36)}`,
    () => `AKIA${random.string(UPPER_ALPHANUMERIC, 16)}`,
    () => `xoxb-${random.digits(12)}-${random.digits(13)}-${random.string(ALPHANUMERIC, 24)}`,
    () => `eyJhbGciOiJIUzI1NiJ9.${random.string(BASE64URL, 40)}.${random.string(BASE64URL, 43)}`,
  ])()
}

/**
 * @param random - random source.
 * @returns a password a person might type.
 */
export function password(random: Random): string {
  return random.string(PASSWORD_CHARACTERS, random.int(10, 16))
}

/**
 * @param random - random source.
 * @returns an RFC 1918 address.
 */
export function privateIp(random: Random): string {
  return random.pick([
    () => `10.${random.int(0, 255)}.${random.int(0, 255)}.${random.int(1, 254)}`,
    () => `192.168.${random.int(0, 255)}.${random.int(1, 254)}`,
    () => `172.${random.int(16, 31)}.${random.int(0, 255)}.${random.int(1, 254)}`,
  ])()
}

/**
 * @param random - random source.
 * @returns a host name under a private-use suffix.
 */
export function internalHost(random: Random): string {
  return `${random.pick(HOST_WORDS)}-${random.int(1, 12)}.${random.pick(INTERNAL_SUFFIXES)}`
}

/**
 * @param random - random source.
 * @returns a 40-character git commit hash.
 */
export function commitHash(random: Random): string {
  return random.string(HEX, 40)
}

/**
 * @param random - random source.
 * @returns a 64-character SHA-256 digest.
 */
export function sha256Digest(random: Random): string {
  return random.string(HEX, 64)
}

/**
 * @param random - random source.
 * @returns a version 4 UUID.
 */
export function uuid(random: Random): string {
  return `${random.string(HEX, 8)}-${random.string(HEX, 4)}-4${random.string(HEX, 3)}-${random.pick(['8', '9', 'a', 'b'])}${random.string(HEX, 3)}-${random.string(HEX, 12)}`
}

/**
 * @param random - random source.
 * @returns a semantic version, sometimes with a prerelease tag.
 */
export function semanticVersion(random: Random): string {
  const core = `${random.int(0, 9)}.${random.int(0, 30)}.${random.int(0, 30)}`
  return random.pick([core, `v${core}`, `${core}-beta.${random.int(1, 9)}`])
}

/**
 * @param random - random source.
 * @returns an order number, prefixed or a bare ten-digit run that does not start with 0.
 */
export function orderNumber(random: Random): string {
  return random.pick([`ORD-2026${random.digits(4)}-${random.digits(5)}`, `${random.int(1, 8)}${random.digits(9)}`])
}

/**
 * @param random - random source.
 * @returns a Unix time in milliseconds from 2025–2027.
 */
export function epochMillis(random: Random): string {
  return `17${random.digits(11)}`
}

const CODE_IDENTIFIERS = [
  'getUserEmail', 'parsePhoneNumber', 'validate_id_number', 'MAX_PASSWORD_LENGTH', 'apiKeyHeaderName',
  'tokenizer_config', 'SecretManagerClient', 'card_last_four', 'resolveHomeDirectory', 'PRIVATE_IP_RANGES',
]

/**
 * @param random - random source.
 * @returns a code identifier whose name mentions a sensitive concept.
 */
export function codeIdentifier(random: Random): string {
  return random.pick(CODE_IDENTIFIERS)
}
