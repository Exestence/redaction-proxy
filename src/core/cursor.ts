/**
 * Position facts about a text read so far, one code unit at a time, so chunk
 * boundaries never matter: whether the next character is inside a URL and,
 * for JSON text, which JSON pointer it belongs to.
 *
 * Inside a URL means: after a `scheme://` (any letter, digit, `+`, `.`, or `-`
 * right before `://`) or a `www.` that starts a token, and before the next
 * whitespace, quote (`"`, `'`, `` ` ``), `<`, or `>`. Query, fragment, and
 * userinfo are part of the URL. JSON text is read as the string values it
 * encodes: `\/` is `/`, `:` is `:`, `\n` and `\"` end the URL, and
 * anything outside a string literal ends it. `mailto:` and `tel:` have no
 * `//` and do not count.
 *
 * @module redaction-proxy/core/cursor
 */

/** Characters that end a URL. */
const URL_END = /[\s"'`<>]/

/** A character that can sit right before `://`, the tail of a scheme. */
const SCHEME_CHAR = /[A-Za-z0-9+.-]/

/** A character of a host name, which a `www.` must not follow to start a URL. */
const HOST_CHAR = /[A-Za-z0-9.-]/

/** Characters of an object key kept for {@link TextCursor.path}; a longer key is cut there. */
const KEY_KEPT = 128

/** One open JSON container. */
type Frame = { kind: 'object'; key: string | undefined } | { kind: 'array'; index: number }

/** Tracks a text's URL and JSON position across any chunking. */
export class TextCursor {
  /** Last few characters of the current token, enough to see `://` or `www.` end. */
  private tail = ''
  private tokenLength = 0
  private url = false
  private readonly frames: Frame[] = []
  private inString = false
  private inKey = false
  private expectKey = false
  /** `undefined` outside an escape, `\\` right after a backslash, else the `\u` digits read so far. */
  private escape: string | undefined
  private key = ''

  /**
   * @param json - whether the text is JSON text rather than a plain string.
   */
  constructor(private readonly json: boolean) {}

  /** Whether the next character would be inside a URL. */
  get inUrl(): boolean {
    return this.url
  }

  /**
   * JSON pointer segments of the next character: keys and array indices.
   * `undefined` stands for a key still being read. Empty for plain text.
   * @returns the segments, outermost first.
   */
  path(): Array<string | number | undefined> {
    return this.frames.map(frame => frame.kind === 'array' ? frame.index : this.inKey && frame === this.frames.at(-1) ? undefined : frame.key)
  }

  /**
   * Read the next part of the text.
   * @param text - characters that follow everything read so far.
   */
  feed(text: string): void {
    for (const char of text) {
      if (this.json) this.readJson(char)
      else this.readChar(char)
    }
  }

  private readJson(char: string): void {
    if (!this.inString) {
      this.endToken()
      const top = this.frames.at(-1)
      if (char === '"') {
        this.inString = true
        this.inKey = top?.kind === 'object' && this.expectKey
        this.key = ''
      } else if (char === '{') {
        this.frames.push({ kind: 'object', key: undefined })
        this.expectKey = true
      } else if (char === '[') {
        this.frames.push({ kind: 'array', index: 0 })
      } else if (char === '}' || char === ']') {
        this.frames.pop()
        this.expectKey = false
      } else if (char === ',') {
        if (top?.kind === 'array') top.index += 1
        else this.expectKey = true
      } else if (char === ':') {
        this.expectKey = false
      }
      return
    }
    if (this.escape === '\\') {
      this.escape = char === 'u' ? '' : undefined
      if (char !== 'u') this.readChar({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[char] ?? char)
      return
    }
    if (this.escape !== undefined) {
      this.escape += char
      if (this.escape.length < 4) return
      const code = Number.parseInt(this.escape, 16)
      this.escape = undefined
      // A malformed escape reads as a URL character, so it cannot end a URL early.
      this.readChar(Number.isNaN(code) ? 'x' : String.fromCharCode(code))
      return
    }
    if (char === '\\') {
      this.escape = '\\'
    } else if (char === '"') {
      this.inString = false
      this.endToken()
      const top = this.frames.at(-1)
      if (this.inKey && top?.kind === 'object') top.key = this.key
      this.inKey = false
    } else {
      this.readChar(char)
    }
  }

  /** Read one character of string content. */
  private readChar(char: string): void {
    if (this.inKey && this.key.length < KEY_KEPT) this.key += char
    if (URL_END.test(char)) {
      this.endToken()
      return
    }
    this.tail = (this.tail + char).slice(-5)
    this.tokenLength += 1
    if (this.url) return
    if (this.tail.endsWith('://') && SCHEME_CHAR.test(this.tail.at(-4) ?? '')) this.url = true
    else if (this.tail.slice(-4).toLowerCase() === 'www.' && (this.tokenLength === 4 || !HOST_CHAR.test(this.tail.at(-5) ?? ''))) this.url = true
  }

  private endToken(): void {
    this.tail = ''
    this.tokenLength = 0
    this.url = false
  }
}
