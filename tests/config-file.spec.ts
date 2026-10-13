// Config files: TOML or JSON by extension, validated the same way, and parse
// failures that never quote the file.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/proxy/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'config-file-'))

function file(name: string, text: string): string {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

const TOML = `
port = 9001
allowedOrigins = ["app://client"]
sendWhenMaskFails = true
knownOriginalsTtlSeconds = 60

[redaction]
terms = ["Denise Whitlock"]
projectNames = ["Nimbus"]

[nameModel]
dir = "/models/nym"
threshold = 0.4
required = true

[toolRestore]
categories = ["PATH"]

[toolRestore.tools]
git_commit = ["PATH", "EMAIL"]
bash = "*"
`

const JSON_SAME = {
  port: 9001,
  allowedOrigins: ['app://client'],
  sendWhenMaskFails: true,
  knownOriginalsTtlSeconds: 60,
  redaction: { terms: ['Denise Whitlock'], projectNames: ['Nimbus'] },
  nameModel: { dir: '/models/nym', threshold: 0.4, required: true },
  toolRestore: { categories: ['PATH'], tools: { git_commit: ['PATH', 'EMAIL'], bash: '*' } },
}

describe('config file formats', () => {
  it('resolves a TOML file and a JSON file with the same content to the same configuration', () => {
    const fromToml = loadConfig(file('same.toml', TOML), {})
    expect(fromToml).toEqual(loadConfig(file('same.json', JSON.stringify(JSON_SAME)), {}))
    expect(fromToml.port).toBe(9001)
    expect(fromToml.toolRestore.tools.get('bash')).toBe('*')
  })

  it('loads config.example.toml, whose active lines are the defaults', () => {
    expect(loadConfig(join(import.meta.dirname, '..', 'config.example.toml'), {})).toEqual(loadConfig(undefined, {}))
  })

  it('applies the same validation to TOML', () => {
    expect(() => loadConfig(file('key.toml', 'openaiApiKey = "x"'), {})).toThrow('config: unknown key "openaiApiKey" (upstream API keys belong in the environment, not the file)')
    expect(() => loadConfig(file('port.toml', 'port = "8787"'), {})).toThrow('port must be an integer in 0..65535')
    expect(() => loadConfig(file('nested.toml', '[toolRestore]\nwhat = 1'), {})).toThrow('toolRestore: unknown key "what"')
    expect(() => loadConfig(file('date.toml', 'host = 1979-05-27'), {})).toThrow('host must be a non-empty string')
  })

  it('refuses a file that is neither .toml nor .json', () => {
    expect(() => loadConfig(file('config.yaml', 'port: 1'), {})).toThrow(/config .*config\.yaml: unsupported file extension; use \.toml or \.json/)
  })

  it('reports a TOML syntax error by path, line, and column without quoting the file', () => {
    const path = file('broken.toml', 'port = 8787\nauthToken = "fictional-secret-0123456789" x\n')
    let message = ''
    try {
      loadConfig(path, {})
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(new RegExp(`^config ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2:\\d+: invalid TOML: `))
    expect(message).not.toContain('fictional-secret')
  })

  it('reports a JSON syntax error by path without quoting the file', () => {
    expect(() => loadConfig(file('broken.json', '{"authToken": fictional-secret-0123456789}'), {})).toThrow(/^config .*broken\.json: invalid JSON$/)
  })

  it('refuses a file whose top level is not a table', () => {
    expect(() => loadConfig(file('array.json', '[]'), {})).toThrow('must hold an object')
  })
})

describe('sendWhenMaskFails', () => {
  it('defaults to false and takes the file value, overridden both ways by the environment', () => {
    expect(loadConfig(undefined, {}).sendWhenMaskFails).toBe(false)
    const on = file('on.toml', 'sendWhenMaskFails = true')
    const off = file('off.json', '{"sendWhenMaskFails": false}')
    expect(loadConfig(on, {}).sendWhenMaskFails).toBe(true)
    expect(loadConfig(off, {}).sendWhenMaskFails).toBe(false)
    expect(loadConfig(on, { REDACTION_PROXY_SEND_WHEN_MASK_FAILS: '0' }).sendWhenMaskFails).toBe(false)
    expect(loadConfig(off, { REDACTION_PROXY_SEND_WHEN_MASK_FAILS: '1' }).sendWhenMaskFails).toBe(true)
  })

  it('accepts only a boolean in a file and only 1 or 0 in the environment', () => {
    expect(() => loadConfig(file('str.toml', 'sendWhenMaskFails = "true"'), {})).toThrow('sendWhenMaskFails must be true or false')
    expect(() => loadConfig(file('num.json', '{"sendWhenMaskFails": 1}'), {})).toThrow('sendWhenMaskFails must be true or false')
    expect(() => loadConfig(undefined, { REDACTION_PROXY_SEND_WHEN_MASK_FAILS: 'yes' })).toThrow('REDACTION_PROXY_SEND_WHEN_MASK_FAILS must be 1 or 0')
  })
})
