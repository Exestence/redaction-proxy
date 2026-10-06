/**
 * Which parts of one user-written text the name model reads: prose
 * paragraphs, never code. The model misses names in code and log lines and
 * reports identifiers as names there, so those lines are skipped; names that
 * also occur in skipped text are still masked through propagation.
 *
 * ponytail: line heuristics, not a parser; unfenced code that reads like prose is scanned, and the span filters still apply.
 *
 * @module redaction-proxy/core/model/prose
 */

/** One half-open UTF-16 range. */
export interface TextRange {
  start: number
  end: number
}

/** Prose paragraphs of one text and the inline code inside them. */
export interface ProseLayout {
  /** Runs of prose lines, cut at blank lines; one model pass each. */
  paragraphs: TextRange[]
  /** Backtick-quoted inline code inside the paragraphs; spans overlapping it are dropped. */
  inlineCode: TextRange[]
}

/** How one line is read. */
type LineKind = 'prose' | 'code' | 'blank' | 'yaml'

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INDENTED = /^( {4}|\t)/
const INLINE_CODE = /`[^`\n]+`/g

const CODE_LINE: readonly RegExp[] = [
  /[;{}[(]\s*$/, /=>\s*$/, /^\s*[}\])]/,
  /^\s*(\/\/|\/\*|\*\/|\* |\*$|<!--|#!|\$ |>>> )/,
  /^\s*@\w+\(/, /^\s*<\/?[A-Za-z][\w.-]*[\s/>]/,
  // A keyword starts code only when one token follows it and then code punctuation or the line end, so chat that
  // starts lower-case (`let me know`, `return the laptop`, `done, ...`) stays prose.
  /^\s*((import|export|default|const|let|var|function|def|class|return|package|public|private|protected|static|fn|func|declare|readonly|interface|enum|type|echo|exit)\s+)+([{*"'([]|[\w$.-]+(\s*[=:;,(<{]|\s*$|\s+(as|from|extends|implements)\b))/,
  /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE)\s/, /^\s*(fi|then|done|esac|else|do)\s*;?\s*$/,
  /^\s*(if|for|while|switch|catch|elif)\s*\(/,
  // Two or more spaces of indent that do not start a nested list item.
  /^ {2,}(?![-*+] |\d+\. )\S/,
  /^\s*from\s+\S+\s+import\s/, /^\s*[\w.$[\]"']+\s*[-+*/]?=\s*\S/, /(=>|===|!==|&&|\|\||::)/,
  /^\s*[{[]/, /^\s*"[^"]+"\s*:/,
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d/, /^\s*\[?(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\]?\s/, /^\s*level=\w+\s/,
]

// A lower-case key keeps e-mail headers such as `Subject:` prose.
const YAML_KEY = /^\s*(- )?[a-z_][\w.-]*:(\s|$)/
const YAML_QUOTED = /^\s*(- )?[a-z_][\w.-]*:\s*["']/

/**
 * Split a text into lines with their offsets.
 * @param text - the text.
 * @returns each line without its newline.
 */
function splitLines(text: string): { range: TextRange; line: string }[] {
  const lines: { range: TextRange; line: string }[] = []
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    lines.push({ range: { start, end }, line: text.slice(start, end) })
    start = end + 1
  }
  return lines
}

/**
 * Classify one line outside a fence.
 * @param line - the line.
 * @returns its kind; `yaml` is decided later from its neighbours.
 */
function classifyLine(line: string): LineKind {
  if (line.trim() === '') return 'blank'
  if (INDENTED.test(line) || YAML_QUOTED.test(line) || CODE_LINE.some(pattern => pattern.test(line))) return 'code'
  return YAML_KEY.test(line) ? 'yaml' : 'prose'
}

/**
 * Classify every line, tracking fenced blocks.
 * @param lines - the lines in order.
 * @returns one kind per line.
 */
function classifyLines(lines: readonly string[]): LineKind[] {
  let fence: string | undefined
  return lines.map(line => {
    const opener = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      const closes = opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener
      if (closes) fence = undefined
      return 'code'
    }
    if (opener !== undefined) {
      fence = opener
      return 'code'
    }
    return classifyLine(line)
  })
}

/**
 * Resolve `yaml` lines: one next to code or another YAML-like line is code;
 * a lone one is prose.
 * @param kinds - line kinds with `yaml` still open.
 * @returns line kinds without `yaml`.
 */
function resolveYamlLines(kinds: readonly LineKind[]): LineKind[] {
  const neighbour = (at: number, step: number): LineKind | undefined => {
    for (let i = at + step; i >= 0 && i < kinds.length; i += step) if (kinds[i] !== 'blank') return kinds[i]
    return undefined
  }
  const codeLike = (kind: LineKind | undefined): boolean => kind === 'yaml' || kind === 'code'
  return kinds.map((kind, at) => kind !== 'yaml' ? kind : codeLike(neighbour(at, -1)) || codeLike(neighbour(at, 1)) ? 'code' : 'prose')
}

/**
 * Find the prose paragraphs of one user-written text.
 * @param text - one user-role text.
 * @returns paragraph ranges (whole lines) and inline-code ranges inside them.
 */
export function proseLayout(text: string): ProseLayout {
  const lines = splitLines(text)
  const kinds = resolveYamlLines(classifyLines(lines.map(({ line }) => line)))
  const paragraphs: TextRange[] = []
  let open: TextRange | undefined
  kinds.forEach((kind, at) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- one kind per line.
    const { range } = lines[at]!
    if (kind !== 'prose') open = undefined
    else if (open !== undefined) open.end = range.end
    else paragraphs.push(open = { ...range })
  })
  const inlineCode: TextRange[] = []
  for (const paragraph of paragraphs) {
    for (const match of text.slice(paragraph.start, paragraph.end).matchAll(INLINE_CODE)) {
      const start = paragraph.start + match.index
      inlineCode.push({ start, end: start + match[0].length })
    }
  }
  return { paragraphs, inlineCode }
}
