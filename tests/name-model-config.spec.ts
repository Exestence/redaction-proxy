// The name model is opt-in: without a `nameModel` block nothing about detection changes, and with one the policy
// digest names the model files and every detection setting.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RulesDetector } from '../src/core/index.ts'
import { DEFAULT_NAME_MODEL_ALLOWLIST, resolveNameModelConfig } from '../src/core/model/config.ts'
import { NameModelDetector } from '../src/core/model/detector.ts'
import { loadNameModel } from '../src/core/model/name-model.ts'
import { loadConfig } from '../src/proxy/config.ts'
import { fakeNameModel } from './name-model-fake.ts'

const RULES_ONLY_DIGEST = 'sha256:52d3676648dbe5c2e97bd8d115f76122ca8f3395c57aa03008ef3118f9f37fe2'

describe('nameModel configuration', () => {
  it('is absent by default, and the core rules detector keeps rules-7 and its digest', () => {
    expect(loadConfig(undefined, {}).nameModel).toBeUndefined()
    const rules = new RulesDetector({})
    expect(rules.detectorVersion).toBe('rules-7')
    expect(rules.policyDigest).toBe(RULES_ONLY_DIGEST)
  })

  it('fills defaults from the final evaluated configuration', () => {
    expect(resolveNameModelConfig({ dir: '/m' })).toEqual({
      dir: '/m',
      threshold: 0.3,
      categories: ['NAME', 'ORG', 'LOC', 'ADDR'],
      windowTokens: 512,
      windowOverlap: 128,
      allowlist: [...DEFAULT_NAME_MODEL_ALLOWLIST],
      required: false,
    })
  })

  it.each([
    [{}, 'dir must be an absolute path'],
    [{ dir: 'relative/model' }, 'dir must be an absolute path'],
    [{ dir: '/m', modelPath: '/x' }, 'unknown key "modelPath"'],
    [{ dir: '/m', threshold: 1 }, 'threshold must be a number between 0 and 1'],
    [{ dir: '/m', categories: ['PERSON'] }, 'unknown category "PERSON"'],
    [{ dir: '/m', categories: [] }, 'categories must be a non-empty array'],
    [{ dir: '/m', windowOverlap: 127 }, 'windowOverlap must be a non-negative even integer'],
    [{ dir: '/m', windowTokens: 130 }, 'windowTokens must exceed windowOverlap + 2'],
    [{ dir: '/m', windowTokens: 9000 }, 'windowTokens must be at most 8192'],
    [{ dir: '/m', allowlist: [' '] }, 'allowlist must be an array of non-blank strings'],
    [{ dir: '/m', required: 'yes' }, 'required must be a boolean'],
  ])('refuses %j', (config, message) => {
    expect(() => resolveNameModelConfig(config)).toThrow(message)
  })

  it('takes the model directory from the environment, which turns the model on', () => {
    expect(loadConfig(undefined, { REDACTION_PROXY_NAME_MODEL_DIR: '/models/nym' }).nameModel).toMatchObject({ dir: '/models/nym', threshold: 0.3 })
  })

  it('refuses a nameModel block that is not an object, also when the environment sets the directory', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'name-model-config-')), 'config.json')
    writeFileSync(file, JSON.stringify({ nameModel: '/models/nym' }))
    expect(() => loadConfig(file, {})).toThrow('nameModel: must be an object')
    expect(() => loadConfig(file, { REDACTION_PROXY_NAME_MODEL_DIR: '/models/nym' })).toThrow('nameModel: must be an object')
  })

  it('fails at load, naming every missing file', async () => {
    await expect(loadNameModel(resolveNameModelConfig({ dir: '/nonexistent/nym' }))).rejects.toThrow(
      'nameModel: /nonexistent/nym is missing model_int8.onnx, config.json, vocab.json, merges.txt, added_tokens.json',
    )
  })
})

describe('policy digest with the name model', () => {
  const rules = new RulesDetector()
  const digestOf = (config: Parameters<typeof fakeNameModel>[1] = {}, fingerprint?: string): string => {
    const { model, runtime } = fakeNameModel({}, config)
    if (fingerprint !== undefined) runtime.fingerprint = fingerprint
    return new NameModelDetector(rules, model).policyDigest
  }

  it('differs from the rules digest and names the detector version', () => {
    const { model } = fakeNameModel({})
    const detector = new NameModelDetector(rules, model)
    expect(detector.policyDigest).not.toBe(RULES_ONLY_DIGEST)
    expect(detector.detectorVersion).toBe('rules-7+nym-edge-int8-3')
    expect(detector.categories).toEqual([...rules.categories, 'NAME', 'ORG', 'LOC', 'ADDR'])
  })

  it('changes with the model files and with every detection setting, not with required', () => {
    const base = digestOf()
    expect(digestOf({}, 'sha256:other-model')).not.toBe(base)
    expect(digestOf({ threshold: 0.5 })).not.toBe(base)
    expect(digestOf({ windowTokens: 1024 })).not.toBe(base)
    expect(digestOf({ categories: ['NAME'] })).not.toBe(base)
    expect(digestOf({ allowlist: ['Kafka'] })).not.toBe(base)
    expect(digestOf({ required: true })).toBe(base)
  })
})
