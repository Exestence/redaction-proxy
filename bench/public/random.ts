/**
 * Seeded pseudo-random source, so one seed always yields the same dataset.
 *
 * @module bench/public/random
 */

const UINT32_RANGE = 0x1_0000_0000
const DECIMAL_DIGITS = '0123456789'

/** Deterministic random choices drawn from one seed. */
export interface Random {
  /**
   * @param min - smallest result.
   * @param max - largest result, inclusive.
   * @returns an integer in `min..max`.
   */
  int(min: number, max: number): number
  /**
   * @param items - non-empty list.
   * @returns one item.
   */
  pick<T>(items: readonly T[]): T
  /**
   * @param alphabet - characters to draw from.
   * @param length - number of characters.
   * @returns a string of `length` characters from `alphabet`.
   */
  string(alphabet: string, length: number): string
  /**
   * @param length - number of digits.
   * @returns a string of decimal digits.
   */
  digits(length: number): string
}

/**
 * Create a random source (mulberry32).
 * @param seed - any 32-bit integer.
 * @returns the random source.
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE
  }
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1))
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T
  const string = (alphabet: string, length: number): string =>
    Array.from({ length }, () => alphabet[int(0, alphabet.length - 1)]).join('')
  return { int, pick, string, digits: length => string(DECIMAL_DIGITS, length) }
}
