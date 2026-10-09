// The real nym model, end to end. Runs only when REDACTION_PROXY_TEST_NAME_MODEL_DIR names a directory prepared by
// scripts/fetch-name-model.mjs; skipped otherwise. Every name is fictional.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RulesDetector, emptyRedactionIndex, mask, restore } from '../src/core/index.ts'
import { createRandom } from '../bench/public/random.ts'
import type { Random } from '../bench/public/random.ts'
import { resolveNameModelConfig } from '../src/core/model/config.ts'
import { NameModelDetector } from '../src/core/model/detector.ts'
import { loadNameModel } from '../src/core/model/name-model.ts'
import type { NameModel } from '../src/core/model/name-model.ts'

const MODEL_DIR = process.env.REDACTION_PROXY_TEST_NAME_MODEL_DIR
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const STARTUP_TIMEOUT_MS = 30_000

/**
 * Start the CLI with the model, wait until it listens, send SIGTERM, and collect how it ended.
 * @param dir - the model directory.
 * @returns the exit code and everything written to stderr.
 */
function runCliUntilSigterm(dir: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CLI], {
      env: { ...process.env, REDACTION_PROXY_PORT: '0', REDACTION_PROXY_NAME_MODEL_DIR: dir },
    })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), STARTUP_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.includes('name model on')) child.kill('SIGTERM')
    })
    child.on('error', reject)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

const LATIN_NAMES: Record<string, [string, string][]> = {
  en: [['Jordan', 'Whitfield'], ['Emily', 'Carter'], ['Marcus', 'Lee'], ['Hannah', 'Brooks']],
  de: [['Lukas', 'Becker'], ['Annika', 'Vogel'], ['Jürgen', 'Müller']],
  fr: [['Camille', 'Dubois'], ['Théo', 'Lefèvre'], ['Élodie', 'Moreau']],
}
const CJK_NAMES: Record<string, { names: [string, string, string][]; honorifics: string[] }> = {
  'zh-TW': { names: [['許', '雅雯', 'Hsu Ya-wen'], ['陳', '志明', 'Chen Chih-ming'], ['林', '佳蓉', 'Lin Chia-jung']], honorifics: ['先生', '經理', '小姐'] },
  'zh-CN': { names: [['王', '晓燕', 'Wang Xiaoyan'], ['张', '伟', 'Zhang Wei'], ['刘', '芳', 'Liu Fang']], honorifics: ['先生', '经理', '女士'] },
  ja: { names: [['田中', '美咲', 'Tanaka Misaki'], ['佐藤', '健太', 'Sato Kenta'], ['鈴木', '花子', 'Suzuki Hanako']], honorifics: ['さん', '様', '先生'] },
  ko: { names: [['김', '민준', 'Kim Min-jun'], ['이', '서연', 'Lee Seo-yeon'], ['박', '지훈', 'Park Ji-hoon']], honorifics: ['님', '씨', ' 선생님'] },
}
const FRAMES: Record<string, string[]> = {
  en: ['Please email {} about the invoice {e}.', 'Meeting with {} tomorrow {a}; call {p}.', 'Notes: {} said {} would join.', '{a} cc {} and {}'],
  de: ['Bitte schreiben Sie {} wegen der Rechnung {a}.', 'Termin mit {} morgen; Telefon {p}.', '{} und {} kommen.'],
  fr: ['Merci d’écrire à {} au sujet de la facture {a}.', 'Réunion avec {} demain, tél. {p}.', '{} et {} arrivent.'],
  'zh-TW': ['請聯絡{}，電話{p}{a}。', '{}和{}明天開會。', '請轉告 {} 寄信到 {e}'],
  'zh-CN': ['请联系{}，电话{p}{a}。', '{}和{}明天开会。', '请告诉 {} 发邮件到 {e}'],
  ja: ['{}に連絡してください。電話{p}{a}', '{}と{}は明日会議です。', '{} から {e} へ'],
  ko: ['{}에게 연락해 주세요 {p}{a}.', '{}와 {}는 내일 회의합니다.', '{} 메일 {e}'],
}
const fullWidth = (text: string): string => text.replace(/[0-9A-Za-z]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0))

/**
 * One synthetic prompt that names the same fictional people in several spellings: case, `Surname, Given`,
 * honorifics, initials, nicknames, spaced and romanised CJK, full-width forms, and astral characters.
 * @param random - the generator.
 * @returns the prompt.
 */
function variantPrompt(random: Random): string {
  const language = random.pick(Object.keys(FRAMES))
  const spellings = (): string[] => {
    const latin = LATIN_NAMES[language]
    if (latin !== undefined) {
      const [given, surname] = random.pick(latin)
      const full = `${given} ${surname}`
      return [full, full.toLowerCase(), full.toUpperCase(), `${surname}, ${given}`, `Dr. ${surname}`, `Mr. ${full}`, `${given.charAt(0)}. ${surname}`,
        given, surname, surname.toUpperCase(), given.slice(0, 3), fullWidth(full)]
    }
    const { names, honorifics } = CJK_NAMES[language] as { names: [string, string, string][]; honorifics: string[] }
    const [surname, given, roman] = random.pick(names)
    const joined = `${surname}${language === 'ko' ? ' ' : ''}${given}`
    const [romanSurname, ...romanGiven] = roman.split(' ')
    return [joined, [...`${surname}${given}`].join(' '), `${surname}${random.pick(honorifics)}`, `${joined}${random.pick(honorifics)}`,
      roman, roman.toUpperCase(), roman.toLowerCase(), `${romanSurname}, ${romanGiven.join(' ')}`, given]
  }
  const people = Array.from({ length: random.int(1, 2) }, spellings)
  return Array.from({ length: random.int(1, 3) }, () => random.pick(FRAMES[language] as string[])
    .replace(/\{\}/g, () => random.pick(random.pick(people)))
    .replace('{a}', random.pick(['😀', '𠮷', '👩‍💻', '']))
    .replace('{e}', random.pick(['ops@example.test', 'j.doe@example.org']))
    .replace('{p}', random.pick(['+1 415 555 0134', '(02) 2345-6789', '０９０-１２３４-５６７８'])))
    .join(random.pick(['\n', ' ']))
}

describe.skipIf(MODEL_DIR === undefined)('real name model', () => {
  let model: NameModel

  beforeAll(async () => {
    model = await loadNameModel(resolveNameModelConfig({ dir: MODEL_DIR as string }))
  })

  afterAll(async () => {
    await model.release()
  })

  const found = async (text: string): Promise<string[]> => (await model.find(text)).map(span => `${span.category}:${text.slice(span.start, span.end)}`)

  // A span may run past the name to the end of its token: `佐藤美咲さんに` is one NAME span, as in the evaluation.
  it.each([
    ['Please send the contract to Margaret Holloway before Friday.', 'Margaret Holloway'],
    ['明天請林佳蓉把會議紀錄寄給我。', '林佳蓉'],
    ['明日、佐藤美咲さんに資料を送ってください。', '佐藤美咲'],
  ])('covers the name in %j', async (text, name) => {
    expect((await found(text)).some(span => span.startsWith('NAME:') && span.includes(name))).toBe(true)
  })

  it('reports nothing for allowlisted tool and setting words', async () => {
    expect(await found('Set the Kafka retention to Default and restart Podman.')).toEqual([])
  })

  it('skips code blocks and keeps offsets right after astral characters', async () => {
    const text = '𠮷 👋🏽 Margaret Holloway wrote:\n\n```\nconst owner = "Margaret Holloway"\n```'
    const spans = await model.find(text)
    expect(spans.map(span => text.slice(span.start, span.end))).toEqual(['Margaret Holloway'])
    expect(spans[0]?.start).toBe(text.indexOf('Margaret'))
  })

  it('masks a request through the combined detector', async () => {
    const detector = new NameModelDetector(new RulesDetector(), model).forRequest(new Set(['Ask 林佳蓉 to mail ops@example.test']), () => {})
    const result = await mask(detector, [
      { seq: 0, path: '', text: 'Ask 林佳蓉 to mail ops@example.test' },
      { seq: 1, path: '', text: 'Tool output: 林 佳 蓉 approved' },
    ], emptyRedactionIndex())
    expect(result.masked).toEqual(['Ask ⟦NAME_1⟧ to mail ⟦EMAIL_1⟧', 'Tool output: ⟦NAME_2⟧ approved'])
  })

  it('restores every synthetic variant-spelling prompt exactly', async () => {
    const random = createRandom(9)
    const prompts = new Set(Array.from({ length: 3000 }, () => variantPrompt(random)))
    const altered: string[] = []
    for (const text of prompts) {
      const detector = new NameModelDetector(new RulesDetector(), model).forRequest(new Set([text]), error => { throw error })
      const result = await mask(detector, [{ seq: 0, path: '', text }], emptyRedactionIndex())
      const restored = restore(result.masked[0] as string, result.registry)
      if (!restored.ok || restored.text !== text) altered.push(text)
    }
    expect(prompts.size).toBeGreaterThan(500)
    expect(altered).toEqual([])
  }, 120_000)

  it('exits cleanly on SIGTERM after releasing the session', async () => {
    const { code, stderr } = await runCliUntilSigterm(MODEL_DIR as string)
    expect(stderr).not.toContain('libc++abi')
    expect(code).toBe(0)
  }, STARTUP_TIMEOUT_MS)
})
