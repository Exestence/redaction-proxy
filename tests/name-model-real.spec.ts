// The real nym model, end to end. Runs only when REDACTION_PROXY_TEST_NAME_MODEL_DIR names a directory prepared by
// scripts/fetch-name-model.mjs; skipped otherwise. Every name is fictional.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RulesDetector, emptyRedactionIndex, mask } from '../src/core/index.ts'
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
    expect(result.masked).toEqual(['Ask ⟦NAME_1⟧ to mail ⟦EMAIL_1⟧', 'Tool output: ⟦NAME_1⟧ approved'])
  })

  it('exits cleanly on SIGTERM after releasing the session', async () => {
    const { code, stderr } = await runCliUntilSigterm(MODEL_DIR as string)
    expect(stderr).not.toContain('libc++abi')
    expect(code).toBe(0)
  }, STARTUP_TIMEOUT_MS)
})
