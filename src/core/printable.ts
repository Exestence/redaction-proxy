/**
 * How a configuration error names a key or value it rejects. Config files can
 * hold tokens, so an error quotes only short name-like words.
 *
 * @module redaction-proxy/core/printable
 */

/**
 * Name a rejected configuration key or value without echoing what may be a secret.
 * @param value - the key or value.
 * @param stand - the stand-in for a string that is not name-like, such as `key`.
 * @returns a name-like word quoted (`"sms"`), `<stand>` for any other string, or `<type>` (`<number>`, `<array>`, `<date>`, `<null>`) for a non-string.
 */
export function printable(value: unknown, stand = 'value'): string {
  if (typeof value === 'string') return isNameLike(value) ? JSON.stringify(value) : `<${stand}>`
  return `<${value === null ? 'null' : Array.isArray(value) ? 'array' : value instanceof Date ? 'date' : typeof value}>`
}

/** Prefixes of common token formats (OpenAI, GitHub, Slack, AWS, JWT, GitLab). */
const TOKEN_PREFIX = /^(?:sk-|ghp_|gho_|github_pat_|xox|akia|asia|eyj|glpat-)/i

/**
 * Whether a string is a short name-like word: a letter, then letters, digits,
 * `_`, or `-`; at most 24 characters and 2 digits; no known token prefix.
 * @param value - the string.
 * @returns whether an error message may quote it.
 */
function isNameLike(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(value) && (value.match(/\d/g) ?? []).length <= 2 && !TOKEN_PREFIX.test(value)
}
