// Writes docs/media/how-it-works.{en,zh-TW,zh-CN,ja}.svg (README "How it
// works") and docs/media/details-flow.zh-TW.svg (DETAILS.md §1) from one
// layout and per-language labels:
//
//   node docs/media/src/how-it-works.mjs

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const media = fileURLToPath(new URL('..', import.meta.url))

const LABELS = {
  en: {
    lang: 'en',
    font: '"Segoe UI", "Helvetica Neue", Arial',
    title: 'How redaction-proxy handles a request',
    local: 'Your computer', cloud: 'Cloud', proxy: 'redaction-proxy (127.0.0.1:8787)',
    tool: ['Your tool', 'Claude Code, SDK…', 'with its own API key'],
    row: [
      ['gate', 'Gate checks', 'origin, host', 'auth token', 'route, size'],
      ['act', 'Collect text', 'skip ids, URLs, files', 'screen control chars'],
      ['act', 'Detect', 'rules, your terms,', 'name model,', 'memory'],
      ['act', 'Mask', 'each value becomes', '⟦EMAIL_1⟧ …'],
    ],
    rowRefusals: [[0, '403 / 401 / 404 / 413, not sent']],
    note: 'GET: relayed as is, not masked',
    leak: ['Leak scan', 'detected value', 'still in the request?'],
    leakRefusal: ['422, not sent (default)', 'sendWhenMaskFails: sent anyway'],
    llm: ['Cloud LLM', 'OpenAI or', 'Anthropic API'],
    out: ['placeholders only'],
    back: ['reply with', 'placeholders'],
    restore: ['Restore the reply', 'whole JSON, or SSE as it streams'],
    rules: [
      'reply text → restored',
      'inside a URL → stays a placeholder',
      'tool-call arguments → allowed categories only',
      '   (default PATH, TERM, PROJECT)',
    ],
    returned: 'restored reply',
    legend: ['only placeholders leave your computer', 'check', 'action', 'refused, not sent', 'privacy boundary'],
  },
  'zh-TW': {
    lang: 'zh-Hant-TW',
    font: '"PingFang TC", "Hiragino Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei"',
    title: 'redaction-proxy 如何處理一個請求',
    local: '你的電腦', cloud: '雲端', proxy: 'redaction-proxy（127.0.0.1:8787）',
    tool: ['你的工具', 'Claude Code 等', '帶自己的 API 金鑰'],
    row: [
      ['gate', '入口檢查', '來源、主機', '權杖', '路由、大小'],
      ['act', '收集文字', '略過 id、網址、檔案', '篩檢控制字元'],
      ['act', '偵測', '規則、你列的詞、', '人名模型、記住的值'],
      ['act', '遮罩', '每個值換成佔位符', '⟦EMAIL_1⟧ …'],
    ],
    rowRefusals: [[0, '403 / 401 / 404 / 413，不轉送']],
    note: 'GET：原樣轉送，不遮罩',
    leak: ['外洩檢查', '偵測到的值', '還在請求裡？'],
    leakRefusal: ['422，不轉送（預設）', 'sendWhenMaskFails：照樣送出'],
    llm: ['雲端 LLM', 'OpenAI 或', 'Anthropic 相容'],
    out: ['只有佔位符'],
    back: ['含佔位符的回覆'],
    restore: ['還原回覆', '整份 JSON，或 SSE 邊收邊還原'],
    rules: [
      '回覆文字 → 還原',
      'URL 內 → 保留佔位符',
      '工具呼叫參數 → 只還原允許的類別',
      '   （預設 PATH、TERM、PROJECT）',
    ],
    returned: '已還原的回覆',
    legend: ['只有佔位符離開你的電腦', '檢查', '處理', '拒絕，不轉送', '隱私邊界'],
  },
  'zh-CN': {
    lang: 'zh-Hans-CN',
    font: '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei"',
    title: 'redaction-proxy 如何处理一个请求',
    local: '你的电脑', cloud: '云端', proxy: 'redaction-proxy（127.0.0.1:8787）',
    tool: ['你的工具', 'Claude Code 等', '带自己的 API 密钥'],
    row: [
      ['gate', '入口检查', '来源、主机', '令牌', '路由、大小'],
      ['act', '收集文本', '跳过 id、网址、文件', '筛查控制字符'],
      ['act', '检测', '规则、你列的词、', '人名模型、记住的值'],
      ['act', '脱敏', '每个值换成占位符', '⟦EMAIL_1⟧ …'],
    ],
    rowRefusals: [[0, '403 / 401 / 404 / 413，不转发']],
    note: 'GET：原样转发，不脱敏',
    leak: ['泄露检查', '检测到的值', '还在请求里？'],
    leakRefusal: ['422，不转发（默认）', 'sendWhenMaskFails：照样发送'],
    llm: ['云端 LLM', 'OpenAI 或', 'Anthropic 兼容'],
    out: ['只有占位符'],
    back: ['含占位符的回复'],
    restore: ['还原回复', '整份 JSON，或 SSE 边收边还原'],
    rules: [
      '回复文本 → 还原',
      'URL 内 → 保留占位符',
      '工具调用参数 → 只还原允许的类别',
      '   （默认 PATH、TERM、PROJECT）',
    ],
    returned: '已还原的回复',
    legend: ['只有占位符离开你的电脑', '检查', '处理', '拒绝，不转发', '隐私边界'],
  },
  ja: {
    lang: 'ja',
    font: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Yu Gothic", "Meiryo"',
    title: 'redaction-proxy がリクエストを処理する流れ',
    local: 'あなたのコンピューター', cloud: 'クラウド', proxy: 'redaction-proxy（127.0.0.1:8787）',
    tool: ['あなたのツール', 'Claude Code など', '自分の API キー付き'],
    row: [
      ['gate', '入口チェック', '送信元・ホスト', 'トークン', 'ルート・サイズ'],
      ['act', 'テキスト収集', 'id・URL などは除外', '制御文字を置換'],
      ['act', '検出', 'ルール・指定の語・', '人名モデル・記憶'],
      ['act', 'マスク', '値ごとにプレース', 'ホルダーへ置換'],
    ],
    rowRefusals: [[0, '403 / 401 / 404 / 413、転送しない']],
    note: 'GET：そのまま転送、マスクなし',
    leak: ['漏えい検査', '検出した値が', 'まだ残っている？'],
    leakRefusal: ['422、転送しない（既定）', 'sendWhenMaskFails：そのまま送信'],
    llm: ['クラウド LLM', 'OpenAI または', 'Anthropic 互換'],
    out: ['プレースホルダー', 'のみ'],
    back: ['プレースホルダー', '付きの応答'],
    restore: ['応答を復元', 'JSON 全体、または SSE を受信しながら'],
    rules: [
      '応答テキスト → 復元',
      'URL の中 → プレースホルダーのまま',
      'ツール呼び出しの引数 → 許可カテゴリだけ復元',
      '   （既定は PATH、TERM、PROJECT）',
    ],
    returned: '復元済みの応答',
    legend: ['プレースホルダーだけが外に出る', 'チェック', '処理', '拒否、転送しない', 'プライバシー境界'],
  },
}

// DETAILS.md §1 shows the internal order of one masked POST, after the gate.
const DETAILS = {
  ...LABELS['zh-TW'],
  title: 'redaction-proxy 處理一個遮罩請求的順序',
  proxy: 'redaction-proxy',
  tool: ['用戶端', 'POST 到遮罩路由', '帶自己的金鑰'],
  row: [
    ['gate', '解析 JSON', '請求本文', '必須是 JSON'],
    ['act', '收集字串', '依序收集可遮字串', '略過 id、網址等鍵'],
    ['gate', '篩檢', '控制字元與 ⟦ ⟧', '預設換成替代字元'],
    ['act', '偵測與遮罩', '先接上先前輸入', '含此憑證記住的值', '編號、擴散'],
  ],
  rowRefusals: [[0, '400，不轉送'], [2, 'refuse 模式：422']],
  note: null,
  leak: ['外洩檢查', '序列化後搜尋', '每個原始值'],
  leakRefusal: ['422，指出欄位路徑（預設）', 'sendWhenMaskFails：照樣送出'],
  llm: ['上游 LLM', '帶用戶端', '自己的標頭'],
  back: ['含佔位符的回應'],
  restore: ['還原回應', '依回應類型'],
  rules: [
    'JSON → 整份還原',
    'SSE → 逐事件、逐欄位串流還原',
    'URL 內保留佔位符',
    '工具參數只還原允許的類別',
  ],
  returned: '已還原的回應',
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (x, y, cls, s, anchor = 'middle') =>
  `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`
// Rough width at 12.5px, only for spacing the legend; render.mjs checks real overlap.
const width = (s) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e7f ? 12.5 : 7), 0)

function svg(L) {
  const W = 980, H = 556
  const o = []
  const box = (cls, x, y, w, h, lines) => {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="${cls}"/>`)
    const top = y + h / 2 - ((lines.length - 1) * 19) / 2 + 5
    lines.forEach((s, i) => o.push(text(x + w / 2, top + i * 19, i ? 's' : 't', s)))
  }
  const arrow = (d, cls, m) => o.push(`<path d="${d}" class="${cls}" marker-end="url(#${m})"/>`)

  o.push(`<rect width="${W}" height="${H}" rx="12" class="bg"/>`)
  o.push(`<rect x="20" y="20" width="770" height="490" rx="14" class="zone"/>`, text(36, 44, 'zl', L.local, 'start'))
  o.push(`<rect x="820" y="20" width="140" height="490" rx="14" class="cloudz"/>`, text(836, 44, 'zl', L.cloud, 'start'))
  o.push(`<line x1="805" y1="30" x2="805" y2="500" class="wall"/>`)
  o.push(`<rect x="186" y="58" width="592" height="440" rx="10" class="zone2"/>`, text(200, 80, 'zl', L.proxy, 'start'))

  box('box', 36, 96, 134, 86, L.tool)

  // Row: gate and request-side steps, left to right.
  const xs = [200, 346, 492, 638]
  L.row.forEach(([cls, ...lines], i) => box(cls, xs[i], 100, 132, 90, lines))
  arrow('M170 145 H198', 'ln', 'a')
  for (const i of [1, 2, 3]) arrow(`M${xs[i - 1] + 132} 145 H${xs[i] - 2}`, 'ln', 'a')
  for (const [i, s] of L.rowRefusals) {
    arrow(`M${xs[i] + 40} 190 V210`, 'stopln', 'as')
    o.push(text(xs[i], 229, 'wl', s, 'start'))
  }
  if (L.note) o.push(text(200, 251, 'nl', L.note, 'start'))

  // Leak scan, then the only arrow that leaves the computer.
  arrow('M704 190 V240', 'ln', 'a')
  box('gate', 638, 242, 132, 80, L.leak)
  arrow('M638 282 H600', 'stopln', 'as')
  o.push(text(592, 278, 'wl', L.leakRefusal[0], 'end'), text(592, 298, 'nl', L.leakRefusal[1], 'end'))
  box('cbox', 830, 238, 120, 88, L.llm)
  arrow('M770 282 H828', 'out', 'ag')
  L.out.forEach((s, i) => o.push(text(890, 226 - (L.out.length - 1 - i) * 19, 'gl', s)))

  // Reply back through restore to the tool.
  arrow('M890 326 V412 H652', 'out', 'ag')
  L.back.forEach((s, i) => o.push(text(662, 402 - (L.back.length - 1 - i) * 19, 'lbl', s, 'start')))
  o.push(`<rect x="300" y="344" width="350" height="144" rx="8" class="act"/>`)
  o.push(text(475, 368, 't', L.restore[0]), text(475, 388, 's', L.restore[1]))
  L.rules.forEach((s, i) => o.push(text(s.startsWith(' ') ? 332 : 318, 412 + i * 19, 'lbl', s.trim(), 'start')))
  arrow('M300 412 H103 V184', 'ln', 'a')
  o.push(text(196, 402, 'lbl', L.returned, 'start'))

  // Legend.
  let x = 24
  const y = 532
  const item = (sw, s) => {
    o.push(sw(x), text(x + 30, y + 4, 'lg', s, 'start'))
    x += 30 + width(s) + 26
  }
  item((x) => `<line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" class="out"/>`, L.legend[0])
  item((x) => `<rect x="${x}" y="${y - 7}" width="22" height="14" rx="3" class="gate"/>`, L.legend[1])
  item((x) => `<rect x="${x}" y="${y - 7}" width="22" height="14" rx="3" class="act"/>`, L.legend[2])
  item((x) => `<line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" class="stopln"/>`, L.legend[3])
  item((x) => `<line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" class="wall"/>`, L.legend[4])

  const font = `${L.font}, system-ui, -apple-system, "PingFang TC", "PingFang SC", "Hiragino Sans", "Noto Sans CJK TC", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft JhengHei", "Microsoft YaHei", sans-serif`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" lang="${L.lang}" aria-labelledby="title">
<title id="title">${esc(L.title)}</title>
<style>
text{font-family:${font};font-size:12.5px;fill:#1c2120}
.t{font-size:15px;font-weight:600}
.s,.nl{fill:#5b6562}
.zl{font-size:13px;font-weight:600;fill:#5b6562}
.wl{fill:#a3352b;font-weight:600}
.gl{fill:#2f8a4e;font-weight:600}
.bg{fill:#f6f7f6}
.zone{fill:#eef2f0;stroke:#c9d1ce;stroke-width:1.5}
.zone2{fill:#e6ece9;stroke:#c9d1ce;stroke-width:1.2}
.cloudz{fill:#e9f0fb;stroke:#5b7fb8;stroke-width:1.5}
.box{fill:#fff;stroke:#c9d1ce;stroke-width:1.5}
.gate{fill:#fdf6ea;stroke:#b9771b;stroke-width:1.8}
.act{fill:#eef4fb;stroke:#3f6fa6;stroke-width:1.8}
.cbox{fill:#fff;stroke:#5b7fb8;stroke-width:1.8}
.ln{stroke:#5b6562;stroke-width:1.6;fill:none}
.out{stroke:#2f8a4e;stroke-width:3.5;fill:none}
.stopln{stroke:#a3352b;stroke-width:1.6;fill:none}
.wall{stroke:#a3352b;stroke-width:2;stroke-dasharray:8 6;fill:none}
.ah{fill:#5b6562}.ahg{fill:#2f8a4e}.ahs{fill:#a3352b}
@media (prefers-color-scheme: dark){
text{fill:#e2e7e5}
.s,.nl,.zl{fill:#9aa5a1}
.wl{fill:#ec8a80}
.gl{fill:#6fcf8d}
.bg{fill:#141817}
.zone{fill:#1a201e;stroke:#3a4440}
.zone2{fill:#202725;stroke:#3a4440}
.cloudz{fill:#1a2333;stroke:#86a6db}
.box{fill:#1c2220;stroke:#3a4440}
.gate{fill:#2a2216;stroke:#e0a85a}
.act{fill:#18212c;stroke:#8db3e2}
.cbox{fill:#1c2220;stroke:#86a6db}
.ln{stroke:#9aa5a1}
.out{stroke:#6fcf8d}
.stopln,.wall{stroke:#ec8a80}
.ah{fill:#9aa5a1}.ahg{fill:#6fcf8d}.ahs{fill:#ec8a80}
}
</style>
<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" class="ah"/></marker>
<marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" class="ahg"/></marker>
<marker id="as" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" class="ahs"/></marker>
</defs>
${o.join('\n')}
</svg>
`
}

for (const [name, L] of Object.entries(LABELS)) writeFileSync(`${media}how-it-works.${name}.svg`, svg(L))
writeFileSync(`${media}details-flow.zh-TW.svg`, svg(DETAILS))
