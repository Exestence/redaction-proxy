// International rules: opt-in detection of identifiers issued outside Taiwan.
// Every value is synthetic: registry or specification examples, or numbers
// built from sequential digits with their check digit computed independently.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULE_NAMES,
  DETECTOR_VERSION,
  EXTENDED_RULE_NAMES,
  INTERNATIONAL_RULE_NAMES,
  RULE_NAMES,
  RulesDetector,
  emptyRedactionIndex,
  mask,
  resolveRulesConfig,
  restore,
} from '../src/core/index.ts'
import { loadConfig } from '../src/proxy/config.ts'

/** Policy digest of the default rules before the international rules existed. */
const LEGACY_DEFAULT_DIGEST = 'sha256:49cba7ce69b8961ec8f8e056240beb401c8b8eba1d2f98a4a4e16460712239ff'

const everyRule = new RulesDetector({ rules: [...RULE_NAMES] })

async function maskWith(detector: RulesDetector, text: string): Promise<string> {
  const result = await mask(detector, [{ seq: 1, path: '', text }], emptyRedactionIndex())
  const back = restore(result.masked[0] ?? '', result.registry)
  expect(back.ok && back.text).toBe(text)
  return result.masked[0] ?? ''
}

describe('international rules', () => {
  it.each([
    ['IBAN DE89 3704 0044 0532 0130 00', 'IBAN ⟦IBAN_1⟧'],
    ['to GB82WEST12345698765432 today', 'to ⟦IBAN_1⟧ today'],
    ['NL91ABNA0417164300', '⟦IBAN_1⟧'],
    ['FR1420041010050500013M02606', '⟦IBAN_1⟧'],
    ['RU02 0445 2560 0407 0281 0412 3456 7890 1', '⟦IBAN_1⟧'],
    ['OM810180000001299123456', '⟦IBAN_1⟧'],
    ['call +44 20 7946 0958 now', 'call ⟦PHONE_1⟧ now'],
    ['US office +1 (415) 555-0132', 'US office ⟦PHONE_1⟧'],
    ['phone=+8613812345678', 'phone=⟦PHONE_1⟧'],
    ['VAT DE123456788', 'VAT ⟦TAXID_1⟧'],
    ['TVA FR32123456789', 'TVA ⟦TAXID_1⟧'],
    ['P.IVA IT12345678903', 'P.IVA ⟦TAXID_1⟧'],
    ['btw NL123456782B01', 'btw ⟦TAXID_1⟧'],
    ['BE0123456749 PL1234567802 ATU12345675 ES12345678Z', '⟦TAXID_1⟧ ⟦TAXID_2⟧ ⟦TAXID_3⟧ ⟦TAXID_4⟧'],
    ['SSN 123-45-6789', 'SSN ⟦NATID_1⟧'],
    ['SSNs 123-45-6789 234-56-7890', 'SSNs ⟦NATID_1⟧ ⟦NATID_2⟧'],
    ['row 12 123-45-6789', 'row 12 ⟦NATID_1⟧'],
    ['ssn: 123456789', 'ssn: ⟦NATID_1⟧'],
    ['ITIN 912 70 1234', 'ITIN ⟦NATID_1⟧'],
    ['NINO AB123456C', 'NINO ⟦NATID_1⟧'],
    ['NI number AB 12 34 56 C.', 'NI number ⟦NATID_1⟧.'],
    ['Steuer-ID: 86095742719', 'Steuer-ID: ⟦NATID_1⟧'],
    ['IdNr 12 345 678 911', 'IdNr ⟦NATID_1⟧'],
    ['carte vitale 1 85 05 78 006 084 91', 'carte vitale ⟦NATID_1⟧'],
    ['numéro de sécu 185057800608491', 'numéro de sécu ⟦NATID_1⟧'],
    ['NIR 1 85 05 2A 006 084 35', 'NIR ⟦NATID_1⟧'],
    ['DNI 12345678Z, NIE X1234567L', 'DNI ⟦NATID_1⟧, NIE ⟦NATID_2⟧'],
    ['codice fiscale RSSMRA85T10A562S', 'codice fiscale ⟦NATID_1⟧'],
    ['身份证号 11010519491231002X', '身份证号 ⟦NATID_1⟧'],
    ['手机 13812345678', '手机 ⟦PHONE_1⟧'],
    ['联系 138-1234-5678', '联系 ⟦PHONE_1⟧'],
    ['call 138-1234-5678 139-1234-5678', 'call ⟦PHONE_1⟧ ⟦PHONE_2⟧'],
    ['HKID A123456(3)', 'HKID ⟦NATID_1⟧'],
    ['香港身份證 AB9876543', '香港身份證 ⟦NATID_1⟧'],
    ['マイナンバー：1234 5678 9018', 'マイナンバー：⟦NATID_1⟧'],
    ['my number is 987654321093', 'my number is ⟦NATID_1⟧'],
    ['携帯 090-1234-5678', '携帯 ⟦PHONE_1⟧'],
    ['+81 90-1234-5678', '⟦PHONE_1⟧'],
    ['주민등록번호 900101-1234568', '주민등록번호 ⟦NATID_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(everyRule, text)).toBe(expected)
  })

  it.each([
    ['IBAN with a wrong check', 'DE88 3704 0044 0532 0130 00'],
    ['IBAN of the wrong length', 'DE89370400440532013'],
    ['lower-case IBAN', 'de89370400440532013000'],
    ['E.164 number too short', '+44 20 7946'],
    ['E.164 number with an unassigned country code', '+80 2079 460958'],
    ['VAT number with a wrong check', 'DE123456789 FR33123456789 IT12345678904'],
    ['SSN in an unassigned area', '666-45-6789 000-12-3456 123-00-6789 123-45-0000'],
    ['ITIN in an unissued group', '912-93-1234'],
    ['bare nine digits without a keyword', 'record 123456789'],
    ['NINO with an excluded prefix', 'GB123456C QQ123456C'],
    ['Steuer-ID with a wrong check', 'Steuer-ID 86095742718'],
    ['Steuer-ID without a repeated digit', 'Steuer-ID 65412378908'],
    ['Steuer-ID without a keyword', 'id 86095742719'],
    ['NIR with a wrong key', '1 85 05 78 006 084 92'],
    ['DNI with a wrong letter', '12345678A'],
    ['fiscal code with a wrong check', 'RSSMRA85T10A562T'],
    ['resident ID with a wrong check', '110105194912310021'],
    ['resident ID with an impossible birth date', '110105194902301234'],
    ['Chinese mobile number without a keyword or groups', 'order 13812345678'],
    ['Japanese mobile number without a keyword or groups', 'order 09012345678'],
    ['HKID with a wrong check', 'A123456(4)'],
    ['My Number with a wrong check', 'マイナンバー 123456789019'],
    ['My Number without a keyword', 'order 1234 5678 9018'],
    ['RRN with a wrong check', '900101-1234567'],
    ['RRN with an impossible birth date', '901301-1234561'],
  ])('leaves a %s alone', async (_name, text) => {
    expect(await maskWith(everyRule, text)).toBe(text)
  })

  it.each([
    ['millisecond timestamp', 'ts=1700000000123 level=info'],
    ['ISO timestamp with an offset', '2026-10-05T10:00:00+08:00'],
    ['semantic version with build metadata', 'v1.2.3+20261005123456'],
    ['scientific notation', 'x = 6.02e+23 and 1e+10'],
    ['arithmetic', 'total = f(x)+12345678901; offset=+86400000'],
    ['git digest', 'commit 9f86d081884c7d659a2feaea0c55ad015a3bf4f8'],
    ['upper-case hash', 'SHA256 9F86D081884C7D659A2FEAEA0C55AD015A3BF4F8'],
    ['UUID', 'id 123e4567-e89b-12d3-a456-426614174000'],
    ['order number', 'ORD-123456789012 shipped, invoice INV2026100512345'],
    ['dated build number', 'build 20261005-1234567'],
    ['digit table row', '| 123 | 45 | 6789 |'],
    ['grouped digits in a longer run', '1 123 45 6789 12'],
    ['upper-case constant', 'const DESCRIPTION = ATTRIBUTES_MAX'],
    ['code identifier', 'ESLINT12345678Z and fooAB123456C'],
  ])('leaves a %s alone', async (_name, text) => {
    expect(await maskWith(everyRule, text)).toBe(text)
  })

  it('reports an identity number that is also a Luhn-valid card number as the identity number', async () => {
    const text = 'ID 440304199001011049'
    expect(await maskWith(everyRule, text)).toBe('ID ⟦NATID_1⟧')
    expect(await maskWith(new RulesDetector(), text)).toBe('ID ⟦CARD_1⟧')
  })

  it('finds full-width and percent-encoded spellings through the shared projections', async () => {
    expect(await maskWith(everyRule, 'ＩＢＡＮ ＤＥ８９３７０４００４４０５３２０１３０００')).toBe('ＩＢＡＮ ⟦IBAN_1⟧')
    expect(await maskWith(everyRule, '?tel=%2B44%2020%207946%200958&x=1')).toBe('?tel=⟦PHONE_1⟧&x=1')
  })
})

// Numbers in the 555-01xx range, Ofcom drama ranges, and sequential digits: none is assigned to anyone.
describe('national telephone formats', () => {
  const phoneRules = new RulesDetector({
    rules: ['e164-phone', 'us-phone', 'uk-phone', 'fr-phone', 'jp-phone', 'kr-mobile', 'br-phone', 'phone-keyword'],
  })

  it.each([
    ['Call me at (415) 555-0132 tomorrow.', 'Call me at ⟦PHONE_1⟧ tomorrow.'],
    ['office 415-555-0132, lab 415.555.0199', 'office ⟦PHONE_1⟧, lab ⟦PHONE_2⟧'],
    ['toll free 1-800-555-0199', 'toll free ⟦PHONE_1⟧'],
    ['London 020 7946 0958, Leeds 0113 496 0000', 'London ⟦PHONE_1⟧, Leeds ⟦PHONE_2⟧'],
    ['mobile 07700 900123 or 07700 900 123', 'mobile ⟦PHONE_1⟧ or ⟦PHONE_2⟧'],
    ['appelez le 01 23 45 67 89 ou 06.12.34.56.78', 'appelez le ⟦PHONE_1⟧ ou ⟦PHONE_2⟧'],
    ['本社 03-1234-5678、横浜 045-123-4567、0120-123-456', '本社 ⟦PHONE_1⟧、横浜 ⟦PHONE_2⟧、⟦PHONE_3⟧'],
    ['연락 010-1234-5678', '연락 ⟦PHONE_1⟧'],
    ['celular (11) 91234-5678, fixo (21) 3456-7890', 'celular ⟦PHONE_1⟧, fixo ⟦PHONE_2⟧'],
    ['Telefon: 030 12345678, Handy 0151/23456789', 'Telefon: ⟦PHONE_1⟧, Handy ⟦PHONE_2⟧'],
    ['phone 98765 43210', 'phone ⟦PHONE_1⟧'],
    ['tel 4155550132, phone_number: 4155550199', 'tel ⟦PHONE_1⟧, phone_number: ⟦PHONE_2⟧'],
    ['Tél : (0)1 23 45 67 89', 'Tél : ⟦PHONE_1⟧'],
    ['電話 02 2345 6789', '電話 ⟦PHONE_1⟧'],
    ['WhatsApp +55 11 91234-5678', 'WhatsApp ⟦PHONE_1⟧'],
    ['tel 02.123.45.67', 'tel ⟦PHONE_1⟧'],
  ])('masks %j', async (text, expected) => {
    expect(await maskWith(phoneRules, text)).toBe(expected)
  })

  it.each([
    ['a number after a keyword that is too short', 'Phone: 3 retries, tel 1234567'],
    ['a number after a field that starts with a keyword', 'cell_id 123456789 tel_ext 12345678 mobile2 12345678'],
    ['a date after a keyword', 'phone: 2026-10-07 and mobile 2026/10/07, Tel. 2026 10 07'],
    ['an IPv4 address after a keyword', 'SIP phone 10.20.30.40, cell 192.168.100.200'],
    ['bare ten digits', 'order 4155550132'],
    ['space-separated groups without a keyword', 'row 415 555 0132'],
    ['a North American shape with a 0 or 1 area code', '015-555-0132 115-555-0132'],
    ['mixed separators', '415-555.0132'],
    ['a dotted version', 'version 1.415.555.0132'],
    ['a group of a longer hyphenated run', 'id 123-415-555-0132 and 415-555-0132-77'],
    ['arithmetic with spaced operators', 'x = 415 - 555 - 0132'],
    ['a timestamp', '2026-10-07 12:34:56.789'],
    ['an ISBN', 'ISBN 978-3-16-148410-0'],
    ['an SSN', 'id 123-45-6789'],
    ['an IPv4 address', 'host 10.20.30.40'],
    ['a digit table row', '| 415 | 555 | 0132 |'],
    ['a hex dump', '00 01 02 03 04 05 06 07 08'],
    ['two-digit pairs in a longer run', '01 23 45 67 89 10'],
    ['a zero-led date', '0001-01-2026'],
    ['a Japanese shape with too many digits', '03-1234-56789'],
    ['a UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['a CSV row', '2026,415,555,0132'],
    ['an international number at the start of a line, a diff marker', '+44 20 7946 0958'],
  ])('leaves %s alone', async (_name, text) => {
    expect(await maskWith(phoneRules, text)).toBe(text)
  })
})

describe('international rule configuration', () => {
  it('keeps the default rules, detector version, and policy digest of detectors built before the international rules', () => {
    const detector = new RulesDetector()
    expect(resolveRulesConfig().rules).toEqual([...DEFAULT_RULE_NAMES])
    expect(detector.detectorVersion).toBe(DETECTOR_VERSION)
    expect(detector.policyDigest).toBe(LEGACY_DEFAULT_DIGEST)
  })

  it('versions and digests a detector with any international rule apart from the default', () => {
    const withIban = new RulesDetector({ rules: [...DEFAULT_RULE_NAMES, 'iban'] })
    expect(withIban.detectorVersion).toBe(`${DETECTOR_VERSION}+intl-2`)
    expect(withIban.policyDigest).not.toBe(LEGACY_DEFAULT_DIGEST)
    expect(withIban.categories).toContain('IBAN')
  })

  it('lists every international rule after the default rules and refuses an unknown one', () => {
    expect(RULE_NAMES).toEqual([...DEFAULT_RULE_NAMES, ...INTERNATIONAL_RULE_NAMES, ...EXTENDED_RULE_NAMES])
    expect(new RulesDetector({ rules: [...INTERNATIONAL_RULE_NAMES] }).categories).toEqual(['IBAN', 'PHONE', 'TAXID', 'NATID'])
    expect(() => resolveRulesConfig({ rules: ['br-cpf'] } as never)).toThrow('unknown rule "br-cpf"')
  })

  it('enables every rule, with the strict card and entropy rules in place of the default ones, unless the config file names its own', () => {
    expect(loadConfig(undefined, {}).redaction.rules).toEqual(RULE_NAMES.filter(rule => rule !== 'card' && rule !== 'entropy'))
    const dir = mkdtempSync(join(tmpdir(), 'proxy-config-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ redaction: { rules: ['e164-phone'] } }))
    try {
      expect(loadConfig(path, {}).redaction.rules).toEqual(['e164-phone'])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('leaves a diff line that starts with a timestamp or a number alone, and a dated `+` mid-line too', async () => {
    const proxyDefault = new RulesDetector(loadConfig(undefined, {}).redaction)
    for (const line of ['+2026-02-27 17:06:23 INFO started\n+1792055696732,7623,ok', 'at +2026-10-05 12:00 UTC']) {
      expect(await maskWith(proxyDefault, line)).toBe(line)
      expect(await maskWith(everyRule, line)).toBe(line)
    }
    expect(await maskWith(proxyDefault, '+ call +1 415 555 0132')).toBe('+ call ⟦PHONE_1⟧')
  })
})
