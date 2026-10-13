/**
 * How a configuration error names a key or value it rejects. Config files can
 * hold tokens, so an error quotes only short identifiers.
 *
 * @module redaction-proxy/core/printable
 */

/**
 * Name a rejected configuration key or value without echoing what may be a secret.
 * @param value - the key or value.
 * @param stand - the stand-in for a string that is not a short identifier, such as `key`.
 * @returns a short identifier quoted (`"sms"`), `<stand>` for any other string, or `<type>` (`<number>`, `<array>`, `<date>`, `<null>`) for a non-string.
 */
export function printable(value: unknown, stand = 'value'): string {
  if (typeof value === 'string') return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) && !/^sk-/i.test(value) ? JSON.stringify(value) : `<${stand}>`
  return `<${value === null ? 'null' : Array.isArray(value) ? 'array' : value instanceof Date ? 'date' : typeof value}>`
}
