/**
 * Development check of non-standard spellings: phones, national IDs, addresses,
 * emails, cards, and IBANs written the way people type them, scored with the
 * proxy's default rules. The author of these cases also edits the rules, so this
 * is a development set, not a held-out one; its numbers do not belong in the README.
 *
 * Each case marks a sensitive value as `{{CATEGORY:style|value}}` and a value no
 * detector should mask as `{{-kind|value}}`. Every value is fictional.
 *
 * Usage: `pnpm run bench:variants` (prints a table; writes nothing).
 * @module bench/variants/main
 */

import { RulesDetector } from '../../src/core/index.ts'
import { PROXY_DEFAULT_RULES } from '../../src/proxy/config.ts'
import type { Sample } from '../public/dataset.ts'
import { classify } from '../public/metrics.ts'
import type { MaskOutcome } from '../public/metrics.ts'
import { runCoreDetector } from '../public/systems.ts'

/** [language, text with markers]. */
const CASES: ReadonlyArray<readonly [string, string]> = [
  // PHONE
  ['zh-TW', '我的手機是 {{PHONE:std|0912-345-678}}，晚上打。'],
  ['zh-TW', '手機 {{PHONE:spaces|0912 345 678}} 找我'],
  ['zh-TW', '打 {{PHONE:bare|0912345678}} 就好'],
  ['zh-TW', '國外請撥 {{PHONE:intl|+886 912 345 678}}'],
  ['zh-TW', '或 {{PHONE:intl|+886-912-345-678}}'],
  ['zh-TW', '號碼 {{PHONE:intl|(+886) 912345678}}'],
  ['zh-TW', '公司電話 {{PHONE:landline|(02) 2345-6789}}'],
  ['zh-TW', '總機 {{PHONE:ext|02-2345-6789 轉 123}}，找會計'],
  ['zh-TW', '分機：{{PHONE:ext|02-2345-6789#123}}'],
  ['en', 'Call me at {{PHONE:std|(415) 555-0132}} tomorrow.'],
  ['en', 'My number is {{PHONE:dots|415.555.0132}}.'],
  ['en', 'Reach the desk at {{PHONE:ext|(415) 555-0132 ext. 45}}.'],
  ['en', 'Office: {{PHONE:ext|415-555-0132 x45}}'],
  ['en', 'From abroad: {{PHONE:intl|+1 415 555 0132}}'],
  ['en', 'text {{PHONE:bare|4155550132}} if urgent'],
  ['ja', '携帯は {{PHONE:std|090-1234-5678}} です。'],
  ['ja', '代表 {{PHONE:ext|03-1234-5678（内線 12）}}'],
  ['ja', '海外から {{PHONE:intl|+81 90 1234 5678}}'],
  ['zh-CN', '手机 {{PHONE:std|138-1234-5678}}'],
  ['zh-CN', '电话 {{PHONE:spaces|138 1234 5678}}'],
  ['zh-CN', '加区号 {{PHONE:intl|+86 138 1234 5678}}'],
  // NATIONAL_ID
  ['zh-TW', '身分證 {{NATIONAL_ID:std|A123456789}}'],
  ['zh-TW', '我身分證字號是 {{NATIONAL_ID:lower|a123456789}}'],
  ['zh-TW', 'ID：{{NATIONAL_ID:spaces|A 123 456 789}}'],
  ['zh-TW', '身分證 {{NATIONAL_ID:dashes|A12-345-6789}}'],
  ['zh-TW', '證號{{NATIONAL_ID:glued|A123456789}}請核對'],
  ['zh-CN', '身份证号 {{NATIONAL_ID:std|11010519491231002X}}'],
  ['zh-CN', '身份证 {{NATIONAL_ID:spaces|110105 19491231 002X}}'],
  ['zh-CN', '证件号：{{NATIONAL_ID:lower|11010519491231002x}}'],
  ['en', 'SSN {{NATIONAL_ID:std|123-45-6789}} on file'],
  ['en', 'my social is {{NATIONAL_ID:spaces|123 45 6789}}'],
  ['en', 'social security number {{NATIONAL_ID:bare|123456789}}'],
  // ADDRESS
  ['zh-TW', '寄到 {{ADDRESS:std|台北市大安區復興南路一段390號3樓}}'],
  ['zh-TW', '地址：{{ADDRESS:alley|新北市板橋區文化路二段100巷5弄8號}}'],
  ['zh-TW', '我住 {{ADDRESS:no-city|大安區和平東路三段12號5樓之1}}'],
  ['zh-TW', '收件 {{ADDRESS:zip|106台北市大安區復興南路一段390號}}'],
  ['zh-CN', '收货地址 {{ADDRESS:std|北京市朝阳区建国路88号院3号楼1201室}}'],
  ['zh-CN', '寄 {{ADDRESS:std|上海市浦东新区世纪大道100号}}'],
  ['ja', '住所は {{ADDRESS:std|東京都千代田区丸の内1-9-1}} です'],
  ['ja', '{{ADDRESS:zip|〒100-0005 東京都千代田区丸の内一丁目9番1号}}'],
  ['en', 'Ship it to {{ADDRESS:std|1600 Example Avenue, Springfield, IL 62704}}.'],
  ['en', 'I live at {{ADDRESS:apt|Apt 4B, 350 Fictional Street, Brooklyn, NY 11201}}.'],
  ['en', 'Send the letter to {{ADDRESS:uk|221B Fictional Road, London NW1 6XE}}.'],
  ['en', 'address: {{ADDRESS:short|42 Wallaby Way}}'],
  ['en', 'Office is at {{ADDRESS:dir-ordinal|500 W 5th St, Suite 200}}.'],
  ['en', 'Meet at {{ADDRESS:abbr|12 Maple Ave.}} at noon'],
  ['en', 'Deliver to {{ADDRESS:unit-after|7 Fictional Lane, Apt. 3}} please'],
  ['en', 'Mail it to {{ADDRESS:pobox|P.O. Box 1234, Springfield, IL 62704}}.'],
  ['en', 'Visit {{ADDRESS:directional|1600 Example Avenue NW, Washington, DC 20500}} today'],
  ['en', 'Return to {{ADDRESS:uk-flat|Flat 2, 10 Fictional Close, Leeds LS1 4AP}}'],
  ['en', 'ship to {{ADDRESS:lower-tail|350 fictional street, brooklyn, ny 11201}}'],
  ['en', 'send it to {{ADDRESS:lower-bare|350 fictional street}} tomorrow'],
  ['en', 'My address is {{ADDRESS:hash-unit|88 Fictional Blvd #12, Austin, TX 78701}}.'],
  ['en', 'Pick up at {{ADDRESS:city-state|19 Fictional Drive, Portland, OR}}'],
  ['zh-TW', '寄到 {{ADDRESS:numbered-road|高雄市苓雅區四維三路2號}}'],
  ['zh-TW', '公司在 {{ADDRESS:avenue|台中市西屯區台灣大道三段99號}}'],
  ['zh-TW', '地址 {{ADDRESS:dir-section|新竹縣竹北市光明六路東一段10號}}'],
  ['zh-TW', '學校 {{ADDRESS:std|台南市東區大學路1號}}'],
  ['zh-TW', '地址是 {{ADDRESS:spaced|台北市大安區忠孝東路四段 100 號 5 樓}}'],
  ['zh-TW', '寄 {{ADDRESS:digit-section|新北市三重區重新路5段609巷4號}}'],
  ['zh-TW', '送到 {{ADDRESS:hyphen-number|台北市大安區復興南路一段390-1號}}'],
  ['zh-TW', '香港分店 {{ADDRESS:hk|九龍旺角彌敦道123號}}'],
  ['zh-CN', '公司在 {{ADDRESS:province|浙江省杭州市西湖区文三路90号}}'],
  ['zh-CN', '寄到 {{ADDRESS:std|广州市天河区天河路385号}}'],
  ['zh-CN', '地址 {{ADDRESS:landmark|深圳市南山区科技园科苑路15号}}'],
  // EMAIL
  ['en', 'mail {{EMAIL:std|lin.fictional@example.test}}'],
  ['en', 'mail {{EMAIL:upper|LIN.FICTIONAL@EXAMPLE.TEST}}'],
  ['en', 'mail {{EMAIL:spaced|lin.fictional @ example.test}}'],
  ['en', 'mail {{EMAIL:at-word|lin.fictional at example dot test}}'],
  ['en', 'mail {{EMAIL:bracket|lin.fictional[at]example.test}}'],
  ['en', 'mail {{EMAIL:paren|lin.fictional(at)example.test}}'],
  ['zh-TW', '信箱 {{EMAIL:fullwidth|lin.fictional＠example.test}}'],
  ['zh-TW', '寄到 {{EMAIL:zh-word|lin.fictional 小老鼠 example.test}}'],
  // CARD
  ['en', 'card {{CARD:std|4111 1111 1111 1111}}'],
  ['en', 'card {{CARD:dashes|4111-1111-1111-1111}}'],
  ['en', 'card {{CARD:dots|4111.1111.1111.1111}}'],
  ['en', 'card {{CARD:bare|4111111111111111}}'],
  ['en', 'card {{CARD:regroup|4111 11 1111 111 111}}'],
  ['zh-TW', '卡號{{CARD:glued|4111111111111111}}到期 12/29'],
  // IBAN
  ['en', 'IBAN {{IBAN:std|DE89 3704 0044 0532 0130 00}}'],
  ['en', 'IBAN {{IBAN:bare|DE89370400440532013000}}'],
  ['en', 'iban {{IBAN:lower|de89 3704 0044 0532 0130 00}}'],
  ['en', 'account {{IBAN:dashes|DE89-3704-0044-0532-0130-00}}'],
  // Values no detector should mask.
  ['zh-TW', '訂單編號 {{-order-number|20261105-0012}} 已出貨'],
  ['zh-TW', '總價 {{-price|NT$ 1,234,567}}'],
  ['en', 'ISBN {{-isbn|978-3-16-148410-0}}'],
  ['en', 'released on {{-date|2026-11-05}} as {{-version|v1.2.3.4}}'],
  ['en', 'tracking {{-tracking-number|1Z999AA10123456784}}'],
  ['zh-TW', '會議在 {{-room|大安會議室 3 樓}}'],
  ['en', 'room {{-room|Building 42, Floor 3}}'],
  ['en', 'the {{-court|9 Supreme Court}} justices ruled'],
  ['en', 'I bought {{-hardware|1 hard drive}} and two cables'],
  ['en', 'take {{-route|Route 66}} west, then {{-route|Highway 1}}'],
  ['en', 'runs on {{-product|Windows 11 Home}} and {{-product|Studio 54}}'],
  ['en', 'see {{-section|Chapter 3 Section 2}} of the {{-plan|Version 2 Road Map}}'],
  ['en', 'she won {{-title|3 Grand Slam}} titles'],
  ['en', 'grab {{-drink|2 Dr Pepper}} cans'],
  ['zh-TW', '{{-ordinal|第3號議案}}通過'],
  ['zh-TW', '搭{{-mrt|3號線}}到站'],
  ['zh-TW', '{{-street|中山路上}}有很多店'],
  ['zh-TW', '{{-freeway|高速公路3號出口}}下'],
  ['zh-TW', '他{{-verb|知道3號}}要開會'],
  ['zh-TW', '在{{-date|2026年11月5號}}出發'],
]

const MARKER = /\{\{(-?)([^:|}]+)(?::([^|}]+))?\|([^}]+)\}\}/g

/**
 * Turn one marked case into a sample with UTF-16 offsets.
 * @param id - sample id.
 * @param language - language tag.
 * @param marked - text with markers.
 * @returns the sample.
 */
function sampleOf(id: string, language: string, marked: string): Sample {
  const sample: Sample = { id, language, format: 'chat', text: '', gold: [], negatives: [] }
  let last = 0
  for (const match of marked.matchAll(MARKER)) {
    const [whole, negative, category, style, value] = match as unknown as [string, string, string, string | undefined, string]
    sample.text += marked.slice(last, match.index)
    const start = sample.text.length
    sample.text += value
    const span = { start, end: sample.text.length }
    if (negative === '-') sample.negatives.push({ ...span, kind: category })
    else sample.gold.push({ ...span, category, style: style ?? 'std' })
    last = match.index + whole.length
  }
  sample.text += marked.slice(last)
  return sample
}

const samples = CASES.map(([language, marked], i) => sampleOf(`v${i + 1}`, language, marked))
const run = await runCoreDetector({ name: 'rules, proxy default', detector: new RulesDetector({ rules: [...PROXY_DEFAULT_RULES] }) }, samples)

type Row = Record<MaskOutcome, number>
const rows = new Map<string, Row>()
const misses: string[] = []
const falsePositives: string[] = []
for (const sample of samples) {
  const { detected } = run.outcomes.get(sample.id)!
  for (const gold of sample.gold) {
    const outcome = classify(gold, detected)
    const key = `${gold.category} ${gold.style}`
    const row = rows.get(key) ?? { fullyMasked: 0, partlyMasked: 0, untouched: 0 }
    row[outcome]++
    rows.set(key, row)
    if (outcome !== 'fullyMasked') misses.push(`${outcome === 'untouched' ? 'missed' : 'partly'}  ${key.padEnd(24)} ${sample.text.slice(gold.start, gold.end)}`)
  }
  for (const negative of sample.negatives) {
    if (classify(negative, detected) !== 'untouched') falsePositives.push(`${negative.kind.padEnd(16)} ${sample.text.slice(negative.start, negative.end)}`)
  }
}

const total = { fullyMasked: 0, partlyMasked: 0, untouched: 0 }
console.log('| category style | n | fully | partly | untouched |\n| --- | --- | --- | --- | --- |')
for (const [key, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
  for (const outcome of Object.keys(total) as MaskOutcome[]) total[outcome] += row[outcome]
  console.log(`| ${key} | ${row.fullyMasked + row.partlyMasked + row.untouched} | ${row.fullyMasked} | ${row.partlyMasked} | ${row.untouched} |`)
}
const n = total.fullyMasked + total.partlyMasked + total.untouched
console.log(`\nfully masked ${total.fullyMasked}/${n}, partly ${total.partlyMasked}, untouched ${total.untouched}`)
console.log(`negatives masked: ${falsePositives.length}/${samples.reduce((sum, s) => sum + s.negatives.length, 0)}`)
if (misses.length > 0) console.log(`\n${misses.join('\n')}`)
if (falsePositives.length > 0) console.log(`\nmasked negatives:\n${falsePositives.join('\n')}`)
