# redaction-proxy

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

在你自己電腦上執行的小型代理：提示送往雲端 LLM 之前，先把 email、API 金鑰、身分證字號等個資換成佔位符；回覆回來時，再把原值放回去。

![你的 AI 工具把 lin@example.test 送到 127.0.0.1 上的 redaction-proxy；雲端 LLM 收到的是 ⟦EMAIL_1⟧；回覆帶著 ⟦EMAIL_1⟧ 回來，代理再還原成 lin@example.test。](docs/media/hero.svg)

適用任何 OpenAI 或 Anthropic 相容的用戶端，串流回覆也一樣，不需要本機模型。它**減少**個資與機密外洩，但**不會**讓對話變成私密的。

> **狀態：** 尚未正式發布，沒有上 npm。已對真實的 DeepSeek Chat Completions API 驗證（2026-10-08，見下方）；OpenAI、Anthropic 與 Claude Code 等真實用戶端尚未驗證。

## 介紹影片

[![30 秒的終端機錄影：pnpm demo 送出 email、身分證字號與家目錄路徑；雲端只看到佔位符；回覆帶著原值回來。](docs/media/intro.gif)](docs/media/intro.mp4)

影片重播的是 `pnpm demo` 與另一個經過代理的請求的真實輸出（字幕為英文）。[MP4 版本](docs/media/intro.mp4)。

## 30 秒快速開始

需要 Node 22.19 以上與 pnpm。在本倉庫的 clone 裡執行：

```sh
pnpm install
pnpm demo          # 不需金鑰：假上游 + 代理 + 一次串流請求
pnpm build
node lib/cli.js    # 啟動代理，位址 http://127.0.0.1:8787
```

`pnpm demo` 的輸出：

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 8ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

### Docker

尚未實際建置或測試；撰寫這個映像的環境沒有 Docker。

```sh
docker build -t redaction-proxy .
export REDACTION_PROXY_AUTH_TOKEN=$(openssl rand -hex 32)
docker run --rm -p 127.0.0.1:8787:8787 -e REDACTION_PROXY_AUTH_TOKEN redaction-proxy
```

> **一定要用 `-p 127.0.0.1:8787:8787`，不要用 `-p 8787:8787`。** 映像在容器內綁定 `0.0.0.0`，所以沒設 `REDACTION_PROXY_AUTH_TOKEN` 就拒絕啟動，沒帶權杖的請求一律回 401；唯一例外是允許來源的瀏覽器 CORS 預檢，由代理自己回應，不轉送任何內容（其他來源的網頁得到 403）。權杖以明文 HTTP 傳送；`127.0.0.1:` 這個前綴讓它，以及你的工具經由代理送出的 API 金鑰，不暴露在你的網路上。

用戶端在 `x-redaction-proxy-token` 標頭帶上權杖：Claude Code 用 `ANTHROPIC_CUSTOM_HEADERS="x-redaction-proxy-token: $REDACTION_PROXY_AUTH_TOKEN"`；OpenAI 與 Anthropic SDK 用預設標頭選項（Python 的 `default_headers`、TypeScript 的 `defaultHeaders`）。

設定檔：加上 `-v "$PWD/redaction.json:/redaction.json:ro"`，並在最後加 `--config /redaction.json`。人名模型：以 `--build-arg NAME_MODEL=1` 建置，並加上 `-v ~/models/nym:/models:ro -e REDACTION_PROXY_NAME_MODEL_DIR=/models`。

### npx（第一次發布到 npm 之後）

目前還沒上 npm。發布之後：

```sh
npx redaction-proxy --demo
npx redaction-proxy           # 啟動代理，位址 http://127.0.0.1:8787（本機不需要權杖）
```

## 讓你的工具走代理

> **真實服務目前只驗證了 DeepSeek。** 2026-10-08 用[真實服務驗證工具](e2e/real/README.md)對 DeepSeek 跑了 4 個情境（Chat Completions；一般與串流；純文字與強制工具呼叫），全部通過：上游只看到佔位符，每次 5 個值都正確還原。OpenAI、Anthropic 因沒有金鑰而略過，也還沒試過真實用戶端。

工具照常送出自己的 API 金鑰；代理原樣轉送，從不儲存。

| 工具 | 設定 | 狀態 |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` | 未測試 |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`（不加 `/v1`） | 未測試 |
| OpenAI SDK 與多數相容工具 | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`（要加 `/v1`） | 未測試 |
| DeepSeek | 以 `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com node lib/cli.js` 啟動代理，再用 `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` 搭配你的 DeepSeek 金鑰。這會取代 OpenAI 上游。 | 已用真實服務驗證工具驗證（僅 API） |
| Cursor | 不支援：Cursor 的自訂 base URL 請求從 Cursor 自己的伺服器發出，連不到你的 `127.0.0.1`。 | — |

<details><summary>curl 範例與設定檔</summary>

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"寄信給 lin@example.test"}]}'
```

用 `node lib/cli.js --config redaction.json` 指定 JSON 檔，環境變數可覆寫。上游 API 金鑰永遠不放在檔案裡；不認得的鍵會讓啟動失敗。

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `port` | `8787` | TCP 埠號。 |
| `host` | `127.0.0.1` | 綁定位址。非本機位址（例如 Docker 中的 `0.0.0.0`）必須設定 `authToken`。 |
| `authToken` | 無 | 用戶端必須在 `x-redaction-proxy-token` 標頭送出的權杖，至少 16 個字元（`openssl rand -hex 32`）。綁定本機時可不設。Claude Code 用 `ANTHROPIC_CUSTOM_HEADERS="x-redaction-proxy-token: <權杖>"` 送出；SDK 用其預設標頭選項。 |
| `allowedOrigins` | 無 | 除了本機 `http(s)` 網頁之外，允許的瀏覽器或 Electron 來源，例如 `app://my-client`。不接受 `null`（`file://` 網頁）。 |
| `openaiUpstream` | `https://api.openai.com` | Chat Completions 與 Responses 的上游。 |
| `anthropicUpstream` | `https://api.anthropic.com` | Anthropic Messages 的上游。 |
| `allowInsecureUpstream` | `false` | 允許以明文 `http://` 連到非本機的上游；API 金鑰會以明文傳送。 |
| `redaction.terms` | 無 | 要遮的人名等字詞，不分大小寫。 |
| `redaction.projectNames` | 無 | 要遮的專案代號。 |
| `redaction.allowlist` | `git@github.com`、`noreply@github.com` | 永遠不遮的值。 |
| `redaction.rules` | `card`、`entropy` 以外全部 | 要啟用的內建規則。以 `card-strict`、`entropy-strict` 取代 `card`、`entropy`：不會把一串數字切成兩半，也放過以檔名為鍵的雜湊。 |
| `nameModel` | 無 | 開啟[實驗性的人名模型](#選用的人名模型實驗性)。 |
| `screen` | `replace` | 遇到控制字元時改成可見字元（`replace`）或拒絕請求（`refuse`）。 |
| `debugMasked` | `false` | 在日誌中記錄遮罩後的請求本文。 |

```json
{
  "redaction": {
    "terms": ["林小明", "Denise Whitlock"],
    "projectNames": ["Nimbus"]
  }
}
```

環境變數與所有選項見[技術細節第 12 節](docs/DETAILS.md#12-完整設定)。日誌每個請求一行，只有計數與耗時；工具呼叫參數中的每個佔位符另記一行（id、工具、參數路徑）。絕不含原始值或標頭。

</details>

## 會遮哪些東西

![一個經過代理的真實請求：工具送出主機名、私有 IP、家目錄路徑、API 金鑰與 email；雲端 LLM 收到 ⟦HOST_1⟧、⟦KEY_1⟧ 等佔位符；回覆帶著原值回來。](docs/media/before-after.png)

| 類別 | 範例 | 雲端看到 |
| --- | --- | --- |
| Email | `lin@example.test` | `⟦EMAIL_1⟧` |
| API 金鑰與憑證 | `sk-…`、`ghp_…`、`AKIA…`、`glpat-…`、`sk_live_…`、JWT、`Bearer …`、`password=…`、`the token is …` | `⟦KEY_1⟧` |
| 家目錄路徑（只遮前綴） | `/Users/lin/notes.md` | `⟦PATH_1⟧/notes.md` |
| 私有 IP、內部主機名 | `192.168.1.20`、`nas.local`、`git.corp` | `⟦IP_1⟧`、`⟦HOST_1⟧` |
| 各國國內格式或電話字眼後的電話號碼 | `(415) 555-0132`、`020 7946 0958`、`Telefon: 030 12345678` | `⟦PHONE_1⟧` |
| 信用卡號（Luhn 驗證） | 13–19 碼 | `⟦CARD_1⟧` |
| 身分證、手機、統一編號 | `A123456789`、`0912-345-678` | `⟦TWID_1⟧`、`⟦PHONE_1⟧` |
| 另外 10 個國家與地區的證號、IBAN | 美國 SSN、英國 NINO、中國身分證、日本個人番號等 | `⟦NATID_1⟧`、`⟦IBAN_1⟧` |
| 長亂數字串 | 32 字元以上的 hex 或 base64 | `⟦ENTROPY_1⟧` |
| 你列出的字詞 | `terms`、`projectNames` | `⟦TERM_1⟧`、`⟦PROJECT_1⟧` |

同一個值在整個請求中用同一個佔位符。遮罩後若請求中仍找得到偵測到的值，代理會拒絕送出（422），不冒險外洩。用戶端請求中綁定過的值，代理依用戶端憑證記在記憶體中，之後的請求即使歷史中已沒有偵測它的上下文（`password: …`），也照樣遮罩。全形數字、`＠`、零寬字元會先折疊再比對。完整規則見[技術細節第 3 節](docs/DETAILS.md#3-偵測規則)。

## 選用的人名模型（實驗性）

預設關閉。光靠規則找不到人名。開啟一個小型本機模型（[`Wismut/nym-pii-multilingual-small`](https://huggingface.co/Wismut/nym-pii-multilingual-small)，MIT 授權，108 MB）後，它會在**你**寫的文字中另外遮掉人名、公司、地名與地址（`⟦NAME_1⟧`、`⟦ORG_1⟧`、`⟦LOC_1⟧`、`⟦ADDR_1⟧`）。

```sh
pnpm add -D onnxruntime-node@1.30.0 tokenizers@0.23.2   # 執行環境，約 350 MB
node scripts/fetch-name-model.mjs ~/models/nym        # 約 125 MB，會檢查 sha256
REDACTION_PROXY_NAME_MODEL_DIR=$HOME/models/nym node lib/cli.js
```

它會漏掉一些人名，也會把一些不是人名的字遮掉。合成資料上的實測：

| | 結果 |
| --- | --- |
| 散文中的人名：英文、日文 | 召回率 1.00、1.00 |
| 貼上的程式碼、log、設定檔裡的人名 | 模型不讀；在保留集第 2 版上，全部人名有 52% 被完整遮住（英文 49%） |
| 散文中的人名：繁體中文 | 召回率 **0.87**（大約每 8 個漏 1 個） |
| 貼上的程式碼、日誌、JSON 中的人名 | 召回率 0.10–0.30：程式碼不讀，這類人名請列進 `terms` |
| 精確率 | 0.94 |
| 代價 | 記憶體約 +420 MB；每 2 KB 中文散文 p95 約 130 ms |

它讀哪些文字、全部數字與選項，見[技術細節第 16 節](docs/DETAILS.md#16-人名模型實驗性)。

## 實測結果

<!-- RESULTS:START -->
**held-out set v2 (written blind, run once)，保留集第 2 版（盲寫、只跑一次）。** 7 種語言（英文、繁中、簡中、日文、韓文、德文、法文）共 1,617 筆合成提示、10,268 個敏感值、2,997 個困難反例。撰寫者沒看過規則與評測程式；約 60% 的值是非標準寫法（用點分隔的卡號、小寫 IBAN、`name at example dot com`、帶分機的電話）。以 SHA-256 凍結後只評分一次，量測的是 commit `01489cd`；兩版保留集與其雜湊在 [bench/heldout/](bench/heldout/)。

![長條圖：英文保留集第 2 版提示中各類別完全遮蔽的比例，代理預設規則、規則加人名模型與 Presidio（cutoff 0.4）對照。](docs/media/results.svg)

| 保留集第 2 版，英文提示（1,527 個值） | 核心預設規則 | 代理預設規則 | + 人名模型（實驗性） | Presidio，cutoff 0 | Presidio，cutoff 0.4 |
| --- | --- | --- | --- | --- | --- |
| 完全遮蔽（10 類宏平均） | 25.9% | 39.5% | **44.8%** | 40.4% | 37.8% |
| 完全沒遮（宏平均） | 64.0% | 49.9% | 35.6% | **29.3%** | 35.0% |
| 遮掉的範圍確實是敏感值 | 94.3% | **95.8%** | 94.8% | 64.9% | 68.0% |
| 每筆提示的中位數耗時 | 0.10 ms | 0.12 ms | 10.8 ms | 11.4 ms | 11.2 ms |
| 完全遮蔽，全部 7 種語言 | 27.3% | 37.9% | 44.4% | 34.5%* | 32.8%* |

\* Presidio 把每筆提示都當英文分析，全部語言的結果僅供參考。

標準與非標準寫法，英文，完全遮蔽（n 為值的數量）：

| 類別 | 代理預設，標準 | 代理預設，非標準 | Presidio 0.4，標準 | Presidio 0.4，非標準 |
| --- | --- | --- | --- | --- |
| Email | 100%（n=107） | 61.5%（n=148） | 57.9% | 35.1% |
| 電話 | 70.4%（n=54） | 41.1%（n=107） | 83.3% | 85.0% |
| 身分證號 | 89.5%（n=19） | 30.4%（n=23） | 68.4% | 47.8% |
| 信用卡 | 94.7%（n=19） | 0.0%（n=40） | 84.2% | 15.0% |
| IBAN | 100%（n=15） | 0.0%（n=46） | 100% | 69.6% |
| 金鑰 | 95.9%（n=49） | 80.7%（n=140） | 12.2% | 5.7% |
| 主機 | 100%（n=93） | 43.6%（n=149） | 47.3% | 12.1% |
| 人名（加人名模型） | 60.4%（n=164） | 39.1%（n=192） | 42.7% | 44.3% |

100% 的格子都是標準寫法，正是規則針對的寫法，而且樣本小：n=15 全對只代表 15 個裡沒有漏掉任何一個。

弱點（英文、代理預設）：

- **非標準寫法**的 IBAN、卡號、身分證號大多抓不到（完全遮蔽 0%、0%、30%）；38% 的非標準 email（`name at example dot com`、國際化網域、加空格）完全沒遮。
- **路徑**大多只遮掉一部分（88%）：使用者名稱會被遮，路徑其餘部分保留。
- **地址。** 沒有地址規則：完全遮蔽 0%（人名模型遮掉一部分的有 77%）。
- **人名**要靠人名模型，完全遮蔽 49%（全部語言 52%）。
- **電話**完全遮蔽 51%（Presidio 85%）；帶分機（`x204`）的電話沒有一個被完全遮蔽。

還原，自我檢查而非成績：只用規則時，1,617 筆提示遮罩後全部能逐位元組還原；開啟人名模型時是 1,617 筆中的 1,587 筆（30 筆不完全一致）。

這次量測之後有兩項修正，不含在上面的數字中：`card-strict` 現在也認重新分組、用點分隔、混用空格和 `-`，以及換行斷開的卡號（這次代理預設只完全遮蔽 30.5% 的英文卡號，核心預設是 44.1%）；人名模型的還原錯誤已修正：同一個名字的不同寫法（`Jordan`、`JORDAN`）現在各拿一個代號，2,908 筆合成資料的還原檢查從 754 筆不一致降到 0 筆。

完整表格：[保留集第 2 版結果](bench/results/public-bench-held-out-v2.md)。較早的[保留集第 1 版](bench/results/public-bench-held-out.md)（1,518 筆、較舊的規則 `rules-6+intl-1`、只有標準寫法）留作紀錄。方法與其他量測：[技術細節第 18 節](docs/DETAILS.md#18-實測數字)。
<!-- RESULTS:END -->

## 它不保護什麼

- **語意。** 雲端仍讀得到佔位符周圍的一切：`⟦PATH_1⟧/clients/acme-layoffs.md` 依然透露很多。
- **人名、地址、病況、薪資**，除非你列進 `terms` 或人名模型找到。
- **圖片、PDF 等 base64 檔案（純文字文件的內容照常遮罩）、音訊、`url` 欄位、`metadata`、`stop` 序列、`name` 欄位（工具與參與者名稱）、帶簽章的 thinking。** 這些原樣轉送且不掃描，JSON 物件的鍵也是：在被遮的文字中偵測到的值若也出現在其中，整個請求以 422 拒絕；只出現在這些地方的值則照原樣送出。
- **少見的寫法。** 有些拆開或編碼過的寫法抓不到，例如有空白的 `name @ domain`、`name at domain`、小寫的 IBAN、編碼兩次的百分比編碼。
- **Cursor**，以及任何從自家伺服器發出請求的工具。
- **你電腦上的其他程式。** 代理預設只綁定 `127.0.0.1`；沒設 `authToken` 時，你電腦上的任何程式都能使用它。網頁的請求以 403 拒絕，除非來源（Origin）是本機 `http(s)` 網頁或列在 `allowedOrigins`；指名其他主機名稱的請求（DNS rebinding）也以 403 拒絕。
- **模型把值寫到哪裡。** 模型在哪裡寫佔位符，代理就在哪裡還原，只有 URL 內例外：那裡的 `https://example.test/?q=⟦EMAIL_1⟧` 保持原樣，拿到這個 URL 的抓網頁工具，或顯示 `![](…)` 圖片與連結的用戶端，都不會送出真實 email。這只針對照常寫出的 URL，擋不住刻意規避的模型：空白之後（`https://evil.example/?q= ⟦EMAIL_1⟧`，`fetch` 仍會以 `%20…` 送出）、用反斜線或少寫斜線（`https:\\evil.example`、`https:evil.example`）、裸網域，都會還原。工具參數的其他位置照常還原，所以模型寫的 shell 指令仍可能把值送出；每次這類還原都會記入日誌。

另外：模型若把 `⟦EMAIL_1⟧` 改寫成 `[EMAIL_1]`，你會原樣看到；需要直接操作被遮值的任務會變差；控制字元會換成可見字元；重啟後會忘記 Responses API 的接續對話與記住的值，接續請求會以 422 拒絕；超過 64 MiB 的請求以 413 拒絕。完整清單見[技術細節第 17 節](docs/DETAILS.md#17-完整限制清單)，威脅模型見[第 11 節](docs/DETAILS.md#11-威脅模型)。

## 更多

[docs/DETAILS.md](docs/DETAILS.md) 包含架構、與 dsh-privacy-router 的比較、核心 API、每條規則、串流還原、422 拒絕、威脅模型、完整設定、測試、量測方法、常見問題，以及如何重新產生本頁的圖片與影片。

## 授權

[Apache-2.0](LICENSE)。部分規則與引擎源自 [LYiHub/pub-dsh-privacy-router](https://github.com/LYiHub/pub-dsh-privacy-router)（MIT），見 [NOTICE](NOTICE)。
