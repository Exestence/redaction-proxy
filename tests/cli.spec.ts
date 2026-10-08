// The command line's startup failures: one `redaction-proxy: …` line on stderr and exit code 1.
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  // Both upstreams are an unused loopback port: no case here reaches them.
  const upstreams = { REDACTION_PROXY_OPENAI_UPSTREAM: 'http://127.0.0.1:1', REDACTION_PROXY_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:1' }
  try {
    await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env, ...upstreams, ...env }, timeout: 10_000 })
    return { code: 0, stderr: '' }
  } catch (error) {
    const { code, stderr } = error as { code: number; stderr: string }
    return { code, stderr }
  }
}

describe('cli', () => {
  it.each([
    [['--port', '19960'], /^redaction-proxy: Unknown option '--port'/],
    [['19960'], /^redaction-proxy: Unexpected argument '19960'/],
  ])('rejects %j in one line', async (args, message) => {
    const { code, stderr } = await run(args)
    expect(code).toBe(1)
    expect(stderr).toMatch(message)
    expect(stderr.trim().split('\n')).toHaveLength(1)
  })

  it('reports a port in use in one line', async () => {
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
    try {
      const { code, stderr } = await run([], { REDACTION_PROXY_PORT: String((holder.address() as { port: number }).port) })
      expect(code).toBe(1)
      expect(stderr).toMatch(/^redaction-proxy: listen EADDRINUSE/)
      expect(stderr.trim().split('\n')).toHaveLength(1)
    } finally {
      await new Promise(resolve => holder.close(resolve))
    }
  })
})
