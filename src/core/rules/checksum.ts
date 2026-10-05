/**
 * Check-digit algorithms of the identifiers the rules detect. Each function
 * takes the identifier's characters with separators already removed and
 * answers whether its check digit or check character holds.
 *
 * @module redaction-proxy/core/rules/checksum
 */

const CHAR_CODE_ZERO = 48
const DECIMAL_BASE = 10
const MOD_97 = 97
/** ISO 13616: a valid IBAN leaves this remainder modulo 97. */
const IBAN_REMAINDER = 1
/** Country code and check digits, which ISO 13616 moves behind the BBAN before the check. */
const IBAN_HEADER_LENGTH = 4
/** IBAN letters count from 10, so `A` is 10 and `Z` is 35. */
const LETTER_VALUE_OFFSET = 10
/** Digits per step when a long decimal string is reduced modulo 97, so every intermediate value fits a double. */
const MOD_97_CHUNK = 9
/** ISO 7064 MOD 11,10 and MOD 11-2 work modulo eleven. */
const MOD_11 = 11

/** Check letters of a Spanish DNI or NIE, indexed by the number modulo 23. */
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'
/** Digits the leading NIE letters `X`, `Y`, and `Z` stand for. */
const NIE_PREFIX_DIGITS: Readonly<Record<string, string>> = { X: '0', Y: '1', Z: '2' }

/** Weights of the first seventeen digits of a Chinese resident identity number (GB 11643). */
const CHINA_RESIDENT_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
/** Check characters of a Chinese resident identity number, indexed by the weighted sum modulo 11. */
const CHINA_RESIDENT_ID_CHECKS = '10X98765432'

/** Value of the blank first position of a one-letter Hong Kong identity card number. */
const HKID_BLANK_VALUE = 36
/** Weights of the eight positions before the Hong Kong check character. */
const HKID_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2]

/** Weights of the first twelve digits of a Korean resident registration number. */
const KOREA_RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]

/** My Number weights, applied from the digit nearest the check digit outwards. */
const MY_NUMBER_WEIGHTS = [2, 3, 4, 5, 6, 7, 2, 3, 4, 5, 6]
/** A My Number remainder at or below this value gives check digit zero. */
const MY_NUMBER_ZERO_CHECK_MAX = 1

/** Values of the odd (1st, 3rd, ...) characters of an Italian fiscal code, for `0`-`9` then `A`-`Z`. */
const FISCAL_CODE_ODD_VALUES = [
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21,
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23,
]
const ALPHABET_SIZE = 26

/** Weights of the nine digits before a Polish NIP check digit. */
const POLAND_NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7]
/** Weights of the nine digits of a Dutch VAT number under the eleven test; the check digit counts negative. */
const NETHERLANDS_ELEVEN_TEST_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2, -1]
/** Offset added to an Austrian UID's weighted digit sum before the check digit is taken. */
const AUSTRIA_UID_OFFSET = 4
/** Two check digits: the French VAT key before the SIREN, the Belgian check at the end. */
const VAT_CHECK_PAIR_LENGTH = 2
/** French VAT keys are computed as `(12 + 3 × (SIREN mod 97)) mod 97`. */
const FRANCE_VAT_KEY_BASE = 12
const FRANCE_VAT_KEY_FACTOR = 3
/** Offsets of the NIR department code and of its two-digit key. */
const NIR_DEPARTMENT_START = 5
const NIR_DEPARTMENT_END = 7
const NIR_KEY_START = 13
/** Corsican department codes `2A` and `2B` count as these numbers in the NIR key. */
const NIR_CORSICA_DEPARTMENTS: Readonly<Record<string, string>> = { '2A': '19', '2B': '18' }

/**
 * Numeric value of one decimal digit character.
 * @param char - one character `0`-`9`.
 * @returns the digit's value.
 */
function digitValue(char: string): number {
  return char.charCodeAt(0) - CHAR_CODE_ZERO
}

/**
 * Sum of a digit string's digits, each multiplied by the weight at its position.
 * @param digits - decimal digits, at least as many as `weights`.
 * @param weights - weight of each leading digit.
 * @returns the weighted sum.
 */
function weightedSum(digits: string, weights: readonly number[]): number {
  return weights.reduce((sum, weight, i) => sum + digitValue(digits.charAt(i)) * weight, 0)
}

/**
 * Value of one upper-case letter counted from 10, as ISO 13616 and the Hong
 * Kong identity card number count them.
 * @param letter - one character `A`-`Z`.
 * @returns 10 for `A` through 35 for `Z`.
 */
function letterValue(letter: string): number {
  return letter.charCodeAt(0) - 'A'.charCodeAt(0) + LETTER_VALUE_OFFSET
}

/**
 * Replace every upper-case letter by its two-digit {@link letterValue}.
 * @param text - digits and upper-case letters.
 * @returns a decimal string.
 */
function lettersToDigits(text: string): string {
  return text.replaceAll(/[A-Z]/g, letter => String(letterValue(letter)))
}

/**
 * Value of a digit or upper-case letter: 0-9 for digits, 10-35 for letters.
 * @param char - one character `0`-`9` or `A`-`Z`.
 * @returns the character's value.
 */
function alphanumericValue(char: string): number {
  return /\d/.test(char) ? digitValue(char) : letterValue(char)
}

/**
 * Remainder of a decimal string of any length modulo 97, reduced in chunks.
 * @param digits - decimal digits.
 * @returns the remainder.
 */
function mod97(digits: string): number {
  let remainder = 0
  for (let at = 0; at < digits.length; at += MOD_97_CHUNK) {
    remainder = Number(`${remainder}${digits.slice(at, at + MOD_97_CHUNK)}`) % MOD_97
  }
  return remainder
}

/**
 * Whether a digit run passes the Luhn checksum.
 * @param digits - decimal digits only.
 * @returns whether the checksum is divisible by ten.
 */
export function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digitValue(digits.charAt(i))
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % DECIMAL_BASE === 0
}

/**
 * Whether the last digit is the ISO 7064 MOD 11,10 check digit of the others.
 * @param digits - decimal digits, the check digit last.
 * @returns whether the check digit holds.
 */
function iso7064Mod11Of10(digits: string): boolean {
  let product = DECIMAL_BASE
  for (const char of digits.slice(0, -1)) {
    const sum = (digitValue(char) + product) % DECIMAL_BASE || DECIMAL_BASE
    product = (sum * 2) % MOD_11
  }
  return (MOD_11 - product) % DECIMAL_BASE === digitValue(digits.slice(-1))
}

/**
 * Whether an IBAN passes the ISO 13616 mod-97 check.
 * @param iban - country code, check digits, and BBAN, upper case, without spaces.
 * @returns whether the rearranged number leaves remainder 1 modulo 97.
 */
export function isIbanChecksumValid(iban: string): boolean {
  return mod97(lettersToDigits(iban.slice(IBAN_HEADER_LENGTH) + iban.slice(0, IBAN_HEADER_LENGTH))) === IBAN_REMAINDER
}

/**
 * Whether a Spanish DNI (`12345678Z`) or NIE (`X1234567L`) carries its check letter.
 * @param value - eight digits, or `X`, `Y`, or `Z` and seven digits, then the letter.
 * @returns whether the letter matches the number modulo 23.
 */
export function isSpanishIdentityNumber(value: string): boolean {
  const number = (NIE_PREFIX_DIGITS[value.charAt(0)] ?? value.charAt(0)) + value.slice(1, -1)
  return DNI_LETTERS.charAt(Number(number) % DNI_LETTERS.length) === value.slice(-1)
}

/**
 * Whether an Italian fiscal code carries its check character. Omocode letters
 * standing in for digits are valued as the letters they are.
 * @param code - sixteen upper-case characters.
 * @returns whether the last character matches the other fifteen.
 */
export function isItalianFiscalCode(code: string): boolean {
  let sum = 0
  for (const [i, char] of [...code.slice(0, -1)].entries()) {
    const value = alphanumericValue(char)
    const isOddPosition = i % 2 === 0
    // Even positions value digits 0-9 and letters 0-25, so a letter drops its offset of ten.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- value is in 0..35.
    sum += isOddPosition ? FISCAL_CODE_ODD_VALUES[value]! : value < DECIMAL_BASE ? value : value - LETTER_VALUE_OFFSET
  }
  return String.fromCharCode('A'.charCodeAt(0) + (sum % ALPHABET_SIZE)) === code.slice(-1)
}

/**
 * Whether a Chinese resident identity number carries its ISO 7064 MOD 11-2 check character.
 * @param value - seventeen digits and a digit or `X`.
 * @returns whether the check character holds.
 */
export function isChinaResidentIdChecksumValid(value: string): boolean {
  return CHINA_RESIDENT_ID_CHECKS.charAt(weightedSum(value, CHINA_RESIDENT_ID_WEIGHTS) % MOD_11) === value.slice(-1).toUpperCase()
}

/**
 * Whether a Hong Kong identity card number carries its check character.
 * @param value - one or two letters, six digits, and a digit or `A`, without brackets.
 * @returns whether the weighted sum including the check value is divisible by eleven.
 */
export function isHongKongIdentityNumber(value: string): boolean {
  const values = [...value.slice(0, -1)].map(alphanumericValue)
  if (values.length < HKID_WEIGHTS.length) values.unshift(HKID_BLANK_VALUE)
  // oxlint-disable-next-line typescript/no-non-null-assertion -- values holds one entry per weight.
  const sum = HKID_WEIGHTS.reduce((total, weight, i) => total + values[i]! * weight, 0)
  // The check character `A` stands for ten, its alphanumeric value.
  const check = alphanumericValue(value.slice(-1))
  return (sum + check) % MOD_11 === 0
}

/**
 * Whether a Korean resident registration number carries its check digit.
 * @param digits - thirteen digits.
 * @returns whether the thirteenth digit matches the weighted sum of the first twelve.
 */
export function isKoreaResidentNumberChecksumValid(digits: string): boolean {
  const check = (MOD_11 - (weightedSum(digits, KOREA_RRN_WEIGHTS) % MOD_11)) % DECIMAL_BASE
  return check === digitValue(digits.slice(-1))
}

/**
 * Whether a Japanese My Number (個人番号) carries its check digit.
 * @param digits - twelve digits.
 * @returns whether the twelfth digit matches the first eleven.
 */
export function isMyNumber(digits: string): boolean {
  const reversedBody = [...digits.slice(0, -1)].reverse().join('')
  const remainder = weightedSum(reversedBody, MY_NUMBER_WEIGHTS) % MOD_11
  const check = remainder <= MY_NUMBER_ZERO_CHECK_MAX ? 0 : MOD_11 - remainder
  return check === digitValue(digits.slice(-1))
}

/**
 * Whether a French NIR (social security number) carries its two-digit key.
 * @param value - thirteen characters (department `2A` or `2B` allowed) and the two key digits.
 * @returns whether the key equals 97 minus the number modulo 97.
 */
export function isFrenchNir(value: string): boolean {
  const department = value.slice(NIR_DEPARTMENT_START, NIR_DEPARTMENT_END)
  const numericDepartment = NIR_CORSICA_DEPARTMENTS[department] ?? department
  const number = value.slice(0, NIR_DEPARTMENT_START) + numericDepartment + value.slice(NIR_DEPARTMENT_END, NIR_KEY_START)
  return MOD_97 - mod97(number) === Number(value.slice(NIR_KEY_START))
}

/**
 * Whether a German tax identification number (Steuer-ID) is well formed: no
 * leading zero, exactly one digit repeated two or three times among the first
 * ten (never three in a row), and an ISO 7064 MOD 11,10 check digit.
 * @param digits - eleven digits.
 * @returns whether every rule holds.
 */
export function isGermanTaxId(digits: string): boolean {
  if (digits.startsWith('0')) return false
  const body = digits.slice(0, -1)
  const counts = new Map<string, number>()
  for (const char of body) counts.set(char, (counts.get(char) ?? 0) + 1)
  const repeated = [...counts].filter(([, count]) => count > 1)
  if (repeated.length !== 1) return false
  // oxlint-disable-next-line typescript/no-non-null-assertion -- exactly one entry.
  const [char, count] = repeated[0]!
  if (count > 3 || body.includes(char.repeat(3))) return false
  return iso7064Mod11Of10(digits)
}

/**
 * Whether the digits after an EU VAT number's country prefix pass that
 * country's check. Only the countries listed here have a check this module
 * implements; any other prefix fails.
 * @param country - two-letter VAT prefix.
 * @param number - the characters after the prefix.
 * @returns whether the number is valid for the country.
 */
export function isEuVatNumber(country: string, number: string): boolean {
  const check = EU_VAT_CHECKS[country]
  return check !== undefined && check(number)
}

/** Format and check of each supported EU VAT prefix. */
const EU_VAT_CHECKS: Readonly<Record<string, (number: string) => boolean>> = {
  AT: number => /^U\d{8}$/.test(number) && isAustrianUid(number.slice(1)),
  BE: number => /^[01]\d{9}$/.test(number) && MOD_97 - mod97(number.slice(0, -VAT_CHECK_PAIR_LENGTH)) === Number(number.slice(-VAT_CHECK_PAIR_LENGTH)),
  DE: number => /^[1-9]\d{8}$/.test(number) && iso7064Mod11Of10(number),
  ES: number => /^(?:\d{8}|[XYZ]\d{7})[A-Z]$/.test(number) && isSpanishIdentityNumber(number),
  FR: number => /^\d{11}$/.test(number) && isFrenchVatKey(number),
  IT: number => /^\d{11}$/.test(number) && luhn(number),
  NL: number => /^\d{9}B\d{2}$/.test(number) && isDutchVatNumber(number),
  PL: number => /^\d{10}$/.test(number) && weightedSum(number, POLAND_NIP_WEIGHTS) % MOD_11 === digitValue(number.slice(-1)),
}

/**
 * Whether an Austrian UID's eighth digit matches its first seven.
 * @param digits - the eight digits after `ATU`.
 * @returns whether the check digit holds.
 */
function isAustrianUid(digits: string): boolean {
  let sum = 0
  for (const [i, char] of [...digits.slice(0, -1)].entries()) {
    const product = digitValue(char) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / DECIMAL_BASE) + (product % DECIMAL_BASE)
  }
  return (DECIMAL_BASE - ((sum + AUSTRIA_UID_OFFSET) % DECIMAL_BASE)) % DECIMAL_BASE === digitValue(digits.slice(-1))
}

/**
 * Whether a French VAT number's numeric key matches its SIREN.
 * @param number - two key digits and the nine-digit SIREN.
 * @returns whether the key holds.
 */
function isFrenchVatKey(number: string): boolean {
  const siren = number.slice(VAT_CHECK_PAIR_LENGTH)
  return (FRANCE_VAT_KEY_BASE + FRANCE_VAT_KEY_FACTOR * mod97(siren)) % MOD_97 === Number(number.slice(0, VAT_CHECK_PAIR_LENGTH))
}

/**
 * Whether a Dutch VAT number passes the eleven test (numbers issued before
 * 2020) or the mod-97 check over `NL` and the whole number (numbers since).
 * @param number - nine digits, `B`, and two digits.
 * @returns whether either check holds.
 */
function isDutchVatNumber(number: string): boolean {
  return weightedSum(number, NETHERLANDS_ELEVEN_TEST_WEIGHTS) % MOD_11 === 0
    || mod97(lettersToDigits(`NL${number}`)) === IBAN_REMAINDER
}
