// Config files: TOML or JSON by extension, validated the same way, and parse
// failures that never quote the file.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { printable } from '../src/core/printable.ts'
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
    expect(() => loadConfig(file('config.yaml', 'port: 1'), {})).toThrow(/config .*config\.yaml: unsupported file extension; use \.toml, \.json, or none for JSON/)
  })

  it('reads a path without an extension as JSON', () => {
    expect(loadConfig(file('config', '{"port": 9002}'), {}).port).toBe(9002)
    expect(() => loadConfig(file('bare-toml', 'port = 9002'), {})).toThrow(/bare-toml: invalid JSON$/)
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

  it('skips a leading UTF-8 BOM in JSON as in TOML', () => {
    expect(loadConfig(file('bom.json', '\uFEFF{"port": 9003}'), {}).port).toBe(9003)
    expect(loadConfig(file('bom.toml', '\uFEFFport = 9003'), {}).port).toBe(9003)
  })

  it('reads a dotfile named .toml or .json in that format', () => {
    expect(loadConfig(file('.toml', 'port = 9004'), {}).port).toBe(9004)
    expect(loadConfig(file('.json', '{"port": 9005}'), {}).port).toBe(9005)
  })

  it('refuses a file whose top level is not a table', () => {
    expect(() => loadConfig(file('array.json', '[]'), {})).toThrow('must hold an object')
  })
})

describe('tables', () => {
  it.each(['redaction', 'toolRestore', 'nameModel'])('refuses a TOML date or a JSON number as %s', key => {
    expect(() => loadConfig(file(`${key}-date.toml`, `${key} = 1979-05-27`), {})).toThrow(`${key} must be a table (a JSON object), not <date>`)
    expect(() => loadConfig(file(`${key}-number.json`, `{"${key}": 7}`), {})).toThrow(`${key} must be a table (a JSON object), not <number>`)
    expect(() => loadConfig(file(`${key}-array.json`, `{"${key}": []}`), {})).toThrow(`${key} must be a table (a JSON object), not <array>`)
    expect(() => loadConfig(file(`${key}-string.json`, `{"${key}": "a b"}`), {})).toThrow(`${key} must be a table (a JSON object), not <value>`)
  })

  it('refuses a TOML date as toolRestore.tools, and as nameModel when the environment sets its directory', () => {
    expect(() => loadConfig(file('tools-date.toml', '[toolRestore]\ntools = 1979-05-27'), {})).toThrow('toolRestore.tools must be a table')
    expect(() => loadConfig(file('model-date.toml', 'nameModel = 1979-05-27'), { REDACTION_PROXY_NAME_MODEL_DIR: '/models/nym' })).toThrow('nameModel must be a table')
  })
})

describe('error messages', () => {
  const SECRET = 'sk-fictional0123456789abcdefABCDEF'

  it('name a key that is not a short identifier as <key>', () => {
    const messages = [
      { [SECRET]: 1 },
      { redaction: { [SECRET]: 1 } },
      { toolRestore: { [SECRET]: 1 } },
      { toolRestore: { tools: { [SECRET]: ['NOPE'] } } },
      { nameModel: { dir: '/models/nym', [SECRET]: 1 } },
    ].map(content => {
      try {
        loadConfig(file('secret-key.json', JSON.stringify(content)), {})
      } catch (error) {
        return (error as Error).message
      }
      return 'loaded'
    })
    for (const message of messages) {
      expect(message).toMatch(/<key>|<tool>/)
      expect(message).not.toContain('fictional')
    }
    expect(() => loadConfig(file('short-secret-key.json', '{"sk-short": 1}'), {})).toThrow('config: unknown key <key>')
  })

  it('name a rejected value by its type unless it is a short identifier', () => {
    expect(() => loadConfig(file('rule.json', JSON.stringify({ redaction: { rules: [SECRET] } })), {})).toThrow('RulesRedactionConfig: unknown rule <value>')
    expect(() => loadConfig(file('rule-num.json', '{"redaction": {"rules": [5]}}'), {})).toThrow('RulesRedactionConfig: unknown rule <number>')
    expect(() => loadConfig(file('category.json', JSON.stringify({ toolRestore: { categories: [SECRET] } })), {})).toThrow('toolRestore.categories: unknown category <value>;')
    expect(() => loadConfig(file('category-obj.json', '{"toolRestore": {"categories": [{"a": 1}]}}'), {})).toThrow('toolRestore.categories: unknown category <object>;')
    expect(() => loadConfig(file('model-category.json', JSON.stringify({ nameModel: { dir: '/models/nym', categories: [SECRET] } })), {})).toThrow('nameModel: unknown category <value>')
  })
})

describe('printable', () => {
  it.each(['AKIAIOSFODNN7EXAMPLE', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', 'eyJhbGciOiJIUzI1NiJ9', 'xoxb-1234-5678', 'sk-anything', 'ghp_abc', 'glpat-abc', 'abcdefghijklmnopqrstuvwxy', 'a b'])('does not quote %s', value => {
    expect(printable(value)).toBe('<value>')
  })

  it.each(['extra', 'sms', 'card-strict', 'git_commit', 'br-cpf', 'knownOriginalsTtlSeconds', 'ipv4', 'rules12'])('quotes %s', value => {
    expect(printable(value)).toBe(JSON.stringify(value))
  })

  it('does not print a token used as a rule name, a tool name, or a non-loopback host', () => {
    const token = 'AKIAIOSFODNN7EXAMPLE'
    expect(() => loadConfig(file('akia-rule.toml', `[redaction]\nrules = ["${token}"]`), {})).toThrow('unknown rule <value>')
    expect(() => loadConfig(file('akia-tool.toml', `[toolRestore.tools]\n${token} = ["NOPE"]`), {})).toThrow(/^toolRestore\.tools\.<tool>/)
    expect(() => loadConfig(undefined, { REDACTION_PROXY_HOST: token })).toThrow('host <host> is not loopback')
  })
})

describe('booleans', () => {
  it.each(['debugMasked', 'allowInsecureUpstream'])('accept only true or false for %s', key => {
    expect(() => loadConfig(file(`${key}.toml`, `${key} = "true"`), {})).toThrow(`${key} must be true or false`)
    expect(() => loadConfig(file(`${key}.json`, `{"${key}": 1}`), {})).toThrow(`${key} must be true or false`)
    expect(() => loadConfig(file(`${key}-ok.toml`, `${key} = true`), {})).not.toThrow()
  })
})

describe('environment flags', () => {
  it('REDACTION_PROXY_DEBUG_MASKED overrides the file both ways', () => {
    const on = file('debug-on.toml', 'debugMasked = true')
    const off = file('debug-off.toml', 'debugMasked = false')
    expect(loadConfig(on, {}).debugMasked).toBe(true)
    expect(loadConfig(on, { REDACTION_PROXY_DEBUG_MASKED: '0' }).debugMasked).toBe(false)
    expect(loadConfig(off, { REDACTION_PROXY_DEBUG_MASKED: '1' }).debugMasked).toBe(true)
  })

  it('REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM overrides the file both ways', () => {
    const insecure = { REDACTION_PROXY_OPENAI_UPSTREAM: 'http://api.example.test' }
    const on = file('insecure-on.toml', 'allowInsecureUpstream = true')
    const off = file('insecure-off.toml', 'allowInsecureUpstream = false')
    expect(loadConfig(on, insecure).openaiUpstream).toBe('http://api.example.test')
    expect(() => loadConfig(on, { ...insecure, REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM: '0' })).toThrow('openaiUpstream is plain http://')
    expect(loadConfig(off, { ...insecure, REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM: '1' }).openaiUpstream).toBe('http://api.example.test')
  })

  it.each(['REDACTION_PROXY_DEBUG_MASKED', 'REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM'])('%s accepts only 1 or 0', name => {
    expect(() => loadConfig(undefined, { [name]: 'true' })).toThrow(`${name} must be 1 or 0`)
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

describe('maskLocalUsername', () => {
  // A synthetic account; the tests never read the real one.
  const user = { username: 'fictionaluser', homedir: '/Users/fictionaluser' }

  it('adds the local user name to the terms by default, beside the configured ones', () => {
    expect(loadConfig(undefined, {}, user).redaction.terms).toEqual(['fictionaluser'])
    expect(loadConfig(file('terms.toml', 'redaction.terms = ["Denise Whitlock"]'), {}, user).redaction.terms).toEqual(['Denise Whitlock', 'fictionaluser'])
    expect(loadConfig(undefined, {}, { username: 'fictionaluser', homedir: '/home/fictional-home' }).redaction.terms).toEqual(['fictionaluser', 'fictional-home'])
    expect(loadConfig(undefined, {}).redaction.terms).toBeUndefined()
  })

  it('is turned off by the file or the environment, which overrides the file', () => {
    const off = file('user-off.toml', 'maskLocalUsername = false')
    expect(loadConfig(off, {}, user).redaction.terms).toBeUndefined()
    expect(loadConfig(off, {}, user).maskLocalUsername).toBe(false)
    expect(loadConfig(off, { REDACTION_PROXY_MASK_LOCAL_USERNAME: '1' }, user).redaction.terms).toEqual(['fictionaluser'])
    expect(loadConfig(undefined, { REDACTION_PROXY_MASK_LOCAL_USERNAME: '0' }, user).redaction.terms).toBeUndefined()
    expect(() => loadConfig(file('user-str.toml', 'maskLocalUsername = "false"'), {}, user)).toThrow('maskLocalUsername must be true or false')
    expect(() => loadConfig(undefined, { REDACTION_PROXY_MASK_LOCAL_USERNAME: 'no' }, user)).toThrow('REDACTION_PROXY_MASK_LOCAL_USERNAME must be 1 or 0')
  })

  it('skips names shorter than 3 characters and generic account names such as the container user node', () => {
    for (const username of ['ab', 'node', 'root', 'Admin', 'runner', 'user']) {
      expect(loadConfig(undefined, {}, { username, homedir: `/home/${username}` }).redaction.terms, username).toBeUndefined()
    }
    expect(loadConfig(undefined, {}, { username: 'node', homedir: '/' }).redaction.terms).toBeUndefined()
  })
})
