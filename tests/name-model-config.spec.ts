// The name model is opt-in: without a `nameModel` block nothing about detection changes, and with one the policy
// digest names the model files and every detection setting.
import { describe, expect, it } from 'vitest'
import { RulesDetector } from '../src/core/index.ts'
import { DEFAULT_NAME_MODEL_ALLOWLIST, resolveNameModelConfig } from '../src/core/model/config.ts'
import { NameModelDetector } from '../src/core/model/detector.ts'
import { loadNameModel } from '../src/core/model/name-model.ts'
import { loadConfig } from '../src/proxy/config.ts'
import { fakeNameModel } from './name-model-fake.ts'

const RULES_ONLY_DIGEST = 'sha256:49cba7ce69b8961ec8f8e056240beb401c8b8eba1d2f98a4a4e16460712239ff'

describe('nameModel configuration', () => {
  it('is absent by default, and the rules detector keeps rules-6 and its digest', () => {
    const config = loadConfig(undefined, {})
    expect(config.nameModel).toBeUndefined()
    const rules = new RulesDetector(config.redaction)
    expect(rules.detectorVersion).toBe('rules-6')
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
    expect(loadConfig(undefined, { REDACTION_PROXY_NAME_MODEL_DIR: '/models/nym' }).nameModel).toEqual({ dir: '/models/nym' })
  })

  it('fails at load, naming every missing file', async () => {
    await expect(loadNameModel({ dir: '/nonexistent/nym' })).rejects.toThrow(
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
    expect(detector.detectorVersion).toBe('rules-6+nym-edge-int8-2')
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
