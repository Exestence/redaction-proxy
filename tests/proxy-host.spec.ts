// The proxy has no authentication, so it binds loopback unless the configuration names another address.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/proxy/config.ts'
import { createProxyServer, listen } from '../src/proxy/server.ts'

function configFile(content: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'proxy-host-')), 'config.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

describe('host', () => {
  it('defaults to 127.0.0.1 and takes the file key, overridden by REDACTION_PROXY_HOST', () => {
    expect(loadConfig(undefined, {}).host).toBe('127.0.0.1')
    const file = configFile({ host: '::1' })
    expect(loadConfig(file, {}).host).toBe('::1')
    expect(loadConfig(file, { REDACTION_PROXY_HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
  })

  it('refuses a host that is not a non-empty string', () => {
    expect(() => loadConfig(configFile({ host: 8787 }), {})).toThrow('host must be a non-empty string')
    expect(() => loadConfig(undefined, { REDACTION_PROXY_HOST: '' })).toThrow('host must be a non-empty string')
  })

  it('listen binds 127.0.0.1 by default', async () => {
    const server = createProxyServer(loadConfig(undefined, {}))
    await listen(server, 0)
    expect(server.address()).toMatchObject({ address: '127.0.0.1' })
    server.close()
  })
})
