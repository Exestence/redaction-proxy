/**
 * Position facts about a text read so far, one code unit at a time, so chunk
 * boundaries never matter: whether the next character is inside a URL and,
 * for JSON text, which JSON pointer it belongs to.
 *
 * Inside a URL means: after two slashes, where a backslash counts as a slash
 * as WHATWG URL parsing reads it (`//`, `\\`, `/\`, `\/`), at the start of
 * a token or after a character that is not a {@link PATH_CHAR} (`https://`,
 * `git+ssh://`, `![](//host/…)`, `\\host\…`), or after a `www.` that starts
 * a token, and before the next whitespace. Outside a URL a quote (`"`, `'`,
 * `` ` ``), `<`, or `>` also ends a token. A URL that starts its token right
 * after a quote or `<` (a scheme may come first) ends only at the same quote
 * or at `>` (`href="…"`, `<https://…>`), not at whitespace: browsers strip a
 * tab or newline from such a URL and percent-encode other whitespace, so an
 * `<img src="…?e=\t⟦EMAIL_1⟧">` would fetch the original without a click.
 * An unclosed quote therefore keeps every later placeholder of its text or
 * JSON string unrestored. In tool input, a URL that starts the text or a JSON
 * string with a scheme (`https://`) or `www.` ends only at the end of that
 * text or string: a tool given `https://…?p=\t⟦PATH_1⟧` would strip the tab
 * and fetch the original. URL parsing strips leading whitespace and every
 * tab or line break, so they are skipped while the token read so far is still
 * the start of an `http://`, `https://`, `ftp://`, `ws://`, `wss://`,
 * `file://`, or `www.` (` https://`, `h\tttps://`, `https:\n//`); a token that
 * skipped one and then leaves those prefixes starts no URL there
 * (`Notes:\nhttps://…`, ` mailto:`). A leading `//` or `\\` does not
 * (`// header`).
 * Every other quote or bracket is part of the URL, as browsers and CommonMark
 * keep it. Placeholders inside a UNC
 * path (`\\host\share\…`) or after an escaped `C:\\` therefore stay
 * unrestored, while `C:\Users\…` is not a URL. Query, fragment, and userinfo
 * are part of the URL. JSON text is read as the string values it encodes:
 * `\/` is `/`, `\u003a` is `:`, `\n` ends the URL, and anything outside a
 * string literal ends it. `mailto:` and `tel:` have no `//` and do not count.
 *
 * @module redaction-proxy/core/cursor
 */

/** Characters that end a token outside a URL. */
const URL_END = /[\s"'`<>]/

/** The character that ends a URL starting right after each delimiter. */
const CLOSER: Partial<Record<string, string>> = { '"': '"', "'": "'", '`': '`', '<': '>' }

/** The closer of a URL that starts tool-input text or a JSON string in it, which no character equals: only the end of the text or string ends it. */
const FIELD_END = ''

/** URL starts a tool-input text or JSON string may spell with whitespace URL parsing strips. */
const FIELD_URL_STARTS = ['http://', 'https://', 'ftp://', 'ws://', 'wss://', 'file://', 'www.']

/** A slash or a backslash, which URL parsing reads as a slash. */
const SLASH = /[/\\]/

/** A character of a scheme or its colon, which may come before a URL's slashes. */
const SCHEME_CHAR = /[A-Za-z0-9+.:-]/

/** A character that can sit right before `//` inside a path (`/Users/x//y`), where it starts no URL. */
const PATH_CHAR = /[A-Za-z0-9+._~%/\\-]/

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
  /** The token's first characters, lowercased with `\\` read as `/`, while it may still start a tool-input URL. */
  private head = ''
  /** Whether whitespace URL parsing strips was skipped inside the current token. */
  private stripped = false
  /** How many characters the token starts with that are {@link SCHEME_CHAR}s. */
  private schemeLength = 0
  private url = false
  /** The character that ends the current URL instead of whitespace, if any. */
  private closer: string | undefined
  private readonly frames: Frame[] = []
  private inString = false
  private inKey = false
  private expectKey = false
  /** `undefined` outside an escape, `\\` right after a backslash, else the `\u` digits read so far. */
  private escape: string | undefined
  private key = ''

  /**
   * @param json - whether the text is JSON text rather than a plain string.
   * @param toolInput - whether the text is tool input, where a URL that starts the text or a JSON string ends only at its end.
   */
  constructor(private readonly json: boolean, private readonly toolInput: boolean) {
    if (toolInput) this.closer = FIELD_END
  }

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
        if (this.toolInput) this.closer = FIELD_END
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
    if (this.closer === FIELD_END && !this.url && (this.tokenLength === 0 ? /\s/ : /[\t\n\r]/).test(char) && this.mayStartFieldUrl()) {
      this.stripped = true
      return
    }
    if (this.url ? char === this.closer || (this.closer === undefined && /\s/.test(char)) : URL_END.test(char)) {
      this.endToken(CLOSER[char])
      return
    }
    this.tail = (this.tail + char).slice(-5)
    this.tokenLength += 1
    if (this.url) return
    if (this.closer === FIELD_END) {
      this.head = (this.head + (char === '\\' ? '/' : char.toLowerCase())).slice(0, 9)
      if (this.stripped && !this.mayStartFieldUrl()) this.closer = undefined
    }
    // Only a scheme or `www.` makes a field-start URL; a leading `//` or `\\` does not.
    if (this.tokenLength === 1 && this.closer === FIELD_END && !/[A-Za-z]/.test(char)) this.closer = undefined
    if (this.schemeLength === this.tokenLength - 1 && SCHEME_CHAR.test(char)) this.schemeLength = this.tokenLength
    if (SLASH.test(char) && SLASH.test(this.tail.at(-2) ?? '') && !PATH_CHAR.test(this.tail.at(-3) ?? '')) this.startUrl(this.schemeLength === this.tokenLength - 2)
    else if (this.tail.slice(-4).toLowerCase() === 'www.' && (this.tokenLength === 4 || !HOST_CHAR.test(this.tail.at(-5) ?? ''))) this.startUrl(this.tokenLength === 4)
  }

  /** @returns whether the token read so far may still start one of {@link FIELD_URL_STARTS}. */
  private mayStartFieldUrl(): boolean {
    return FIELD_URL_STARTS.some(start => start.startsWith(this.head))
  }

  /** @param tokenStart - whether the URL starts the token, so the delimiter before the token closes it. */
  private startUrl(tokenStart: boolean): void {
    this.url = true
    if (!tokenStart) this.closer = undefined
  }

  /** @param closer - the character that ends a URL starting the next token. */
  private endToken(closer?: string): void {
    this.tail = ''
    this.tokenLength = 0
    this.head = ''
    this.stripped = false
    this.schemeLength = 0
    this.url = false
    this.closer = closer
  }
}
