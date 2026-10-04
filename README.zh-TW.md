# redaction-proxy

[English](README.md) · [技術細節](docs/DETAILS.md)

在你電腦上執行的小型代理。你的 AI 工具把提示送往雲端 LLM 之前，它先把 email、身分證字號、手機、API 金鑰、家目錄路徑等換成 `⟦EMAIL_1⟧` 這類佔位符；模型回覆回來時，再把佔位符換回原值，串流回覆也一樣。它適用任何 OpenAI 相容或 Anthropic 相容的用戶端，不需要本機模型。它**減少**個資與機密外洩，但**不會**讓對話變成私密的。

> 狀態：私有、尚未發布，沒有發布到 npm。只對本機假上游測試過。

## ⚠️ 先讀：它不保護什麼

| 限制 | 意思 |
| --- | --- |
| 藏實體，不藏語意 | 上游仍讀得到佔位符周圍的一切。`⟦PATH_1⟧/clients/acme-layoffs.md` 依然透露很多。 |
| 人名、地址只有列出才遮 | 沒有自由文字的人名偵測，也沒有地址規則。人名、公司名、代號要列進 `terms` 或 `projectNames`。病況、薪資、通訊地址照原樣送出。 |
| 有些欄位不遮 | 圖片、PDF、音訊、`metadata`、工具名稱、帶簽章的 thinking 原樣轉送。若偵測到的值出現在這些欄位，整個請求以 422 拒絕。 |
| Cursor 不能用 | Cursor 的自訂 base URL 請求是從 Cursor 自己的伺服器發出，連不到你的 `127.0.0.1`；而且 Cursor 後端在任何代理之前就看到未遮罩的提示。 |
| 有些拆開的寫法抓不到 | 偵測不到：點後加空格的私有 IP（`192. 168. 1. 2`）；被空格或換行拆開的 API 金鑰（高熵規則只抓得到部分片段）；單獨用 ` at ` 的 email（`wang.yichun at example.tw`），因為英文散文（`socket.io at github.com`）長得一樣；以及 `@` 兩側有空白、但網域結尾不在固定常見頂級網域清單內的 email（`wang.yichun @ example.xyz`），因為矩陣程式碼（`layer.weight @ state.dx`）長得一樣。抓得到：`wang.yichun @ example.tw`（每側最多兩個空白，清單內的頂級網域如 `com`、`org`、`io`、`tw`、`jp`）、`＠`、`(at)`、`[at]`、`[dot]`、加了空格或連字號的 terms，以及中間有一個分隔符的身分證字號、統編、手機號碼。 |
| 一個 term 一個佔位符，還原成第一種寫法 | `星河計畫`、`星河 計畫` 與 `NIMBUS-7`、`nimbus 7` 都依所設定的 term 共用一個佔位符，回覆中每個位置都還原成請求裡第一次出現的寫法。 |
| 只認標準佔位符 | 模型若把 `⟦EMAIL_1⟧` 改寫成 `[EMAIL_1]`，你會原樣看到它。 |
| 模型品質可能下降 | 需要直接操作被遮值的任務（例如把絕對路徑改成相對路徑）會變差。你會看到佔位符，不是靜默出錯。 |
| 會改動一些字元 | 預設把控制字元換成可見字元（`␛`），把原文中的 `⟦` `⟧` 換成 `⟪` `⟫`。 |
| 重啟會忘記接續對話 | Responses API 的 `previous_response_id` 依賴記憶體中最近 256 個回應；重啟後舊輪次的佔位符無法還原。 |
| 本機沒有驗證 | 只綁定 `127.0.0.1`，但你電腦上的任何程式都能使用它。 |
| 尚未對真實服務測試 | 測試與示範都用本機假上游，尚未對 OpenAI、Anthropic、DeepSeek 或真實用戶端驗證。 |

## 🔄 運作方式

```mermaid
flowchart LR
  C["你的用戶端"] -- "原始提示" --> M["代理：遮罩"]
  M -- "⟦EMAIL_1⟧ 等佔位符" --> U["雲端 LLM"]
  U -- "串流回覆，含佔位符" --> R["代理：還原"]
  R -- "原值放回" --> C
```

- 同一個值在同一個請求中一律用同一個佔位符。
- 代理不存對話狀態。每次請求都從完整歷史重新編號，所以同一段對話每一輪的編號一致，上游的提示快取照常生效。
- 遮罩後若在請求中仍找得到任何原始值，代理會拒絕送出（422），而不是冒險外洩。
- 金鑰照常由用戶端送出，代理原樣轉送，從不儲存。

佔位符被切在兩個串流片段之間時，代理只扣住可能是佔位符的那一小段，其餘立刻送出：

```mermaid
sequenceDiagram
  participant U as 雲端 LLM
  participant P as 代理
  participant C as 用戶端
  U->>P: "I will email ⟦EM"
  P->>C: "I will email "
  Note over P: 扣住 ⟦EM
  U->>P: "AIL_1⟧ about"
  P->>C: "lin@example.test about"
```

## 🔍 會遮哪些東西

| 類別 | 原文範例 | 上游看到 |
| --- | --- | --- |
| Email | `lin@example.test` | `⟦EMAIL_1⟧` |
| 家目錄路徑（只遮前綴） | `/Users/lin/notes.md` | `⟦PATH_1⟧/notes.md` |
| API 金鑰與憑證 | `sk-...`、`ghp_...`、`AKIA...`、JWT、`Bearer ...`、`password=...` | `⟦KEY_1⟧`（`password=` 這類鍵名保留） |
| 身分證、居留證（**驗證檢查碼**） | `A123456789` | `⟦TWID_1⟧` |
| 手機 | `0912-345-678`、`+886 912 345 678` | `⟦PHONE_1⟧` |
| 市話（需「電話」、tel 等關鍵詞） | `電話 02-2345-6789` | `電話 ⟦PHONE_1⟧` |
| 統一編號（需關鍵詞） | `統編 12345678` | `統編 ⟦TAXID_1⟧` |
| 信用卡號（**Luhn 驗證**） | 13–19 碼卡號 | `⟦CARD_1⟧` |
| 私有 IP | `192.168.1.20` | `⟦IP_1⟧` |
| 內部主機名 | `nas.local`、`db.internal` | `⟦HOST_1⟧` |
| 高熵字串 | 32 字元以上的 hex 或 base64 | `⟦ENTROPY_1⟧` |
| 你列出的字詞（`terms`） | `林小明` | `⟦TERM_1⟧` |
| 你列出的代號（`projectNames`） | `Nimbus` | `⟦PROJECT_1⟧` |

全形數字（`０９１２３４５６７８`）、全形 `＠`、夾零寬字元的值也抓得到。完整規則見[技術細節](docs/DETAILS.md#3-偵測規則)。

## 🚀 快速開始

需要 Node 22.19 以上與 pnpm。

```sh
pnpm install
pnpm demo          # 不需金鑰：假上游 + 代理 + 一次串流請求
pnpm build
node lib/cli.js    # 在 http://127.0.0.1:8787 啟動
```

`pnpm demo` 的輸出：

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 7ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

## 🔌 讓用戶端走代理

> 以下設定**都尚未在真實用戶端驗證**，只有 `pnpm demo` 與對假上游的測試實際跑過。

| 用戶端 | 設定 | 狀態 |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` | 未測試 |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`（不加 `/v1`） | 未測試 |
| OpenAI SDK 與多數相容工具 | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`（要加 `/v1`） | 未測試 |
| curl | 見下方 | 未測試 |
| Cursor | 不支援，見限制 | — |

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"寄信給 lin@example.test"}]}'
```

要改用其他相容服務，例如 DeepSeek：`REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com node lib/cli.js`。

## ⚙️ 設定

用 `node lib/cli.js --config redaction.json` 指定 JSON 檔，環境變數可覆寫。金鑰永遠不放在檔案裡；不認得的鍵會讓啟動失敗。

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `port` | `8787` | 只綁定 `127.0.0.1`。 |
| `openaiUpstream` | `https://api.openai.com` | Chat Completions 與 Responses 的上游。 |
| `anthropicUpstream` | `https://api.anthropic.com` | Anthropic Messages 的上游。 |
| `redaction.terms` | 無 | 要遮的人名等字詞，不分大小寫。 |
| `redaction.projectNames` | 無 | 要遮的專案代號。 |
| `redaction.allowlist` | `git@github.com`、`noreply@github.com` | 永遠不遮的值。 |
| `redaction.rules` | 全部 | 要啟用的內建規則。 |
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

對應的環境變數與完整說明見[技術細節](docs/DETAILS.md#12-完整設定)。日誌每個請求一行，只有計數與耗時，絕不含原始值或標頭。

## 📊 實測數字

| 項目 | 結果 | 代表什麼 |
| --- | --- | --- |
| 測試 | 418 個全部通過 | 規則、引擎、對抗輸入、對假上游的三種 API 串流與非串流。 |
| 憑證誤遮 | 每千行程式碼 **0.76** 處 | 在不含真實金鑰的 DeepSeek Harness 原始碼上量測（69.8 萬行程式碼），平均約 1,300 行有一處被誤當成金鑰而遮掉。 |
| 還原失敗 | 0 | 遮罩成功的檔案全部都能逐位元組還原。 |
| 速度 | 約 85 萬行 / 5 秒 | Apple M5 Max。 |

誤遮的代價是模型看到一個不必要的佔位符，回覆時會被換回原值。語料是英文程式碼，中文散文的誤遮率尚未量測。以 `pnpm test` 與 `pnpm bench` 重現。

## 🆚 和 dsh-privacy-router 的差別

| | redaction-proxy（本倉庫） | [dsh-privacy-router](https://github.com/PersonalAssistanceHsin/dsh-privacy-router) |
| --- | --- | --- |
| 形式 | 獨立的 HTTP 代理 | dsh 的外掛 |
| 用戶端 | 任何 OpenAI 或 Anthropic 相容用戶端 | 只限 dsh |
| 路由 | 不路由：每個請求都遮罩後送往上游 | 每一輪決定送本機模型還是雲端 |
| 本機模型 | 不需要 | 需要 |
| 遮罩核心 | 在這裡（`src/core/`） | dsh-addons 的 redaction 套件以 git submodule 引用這份核心 |
| 串流還原 | `src/core/restore.ts` | 仍有自己的還原器，未來預計統一 |

## ❓ 常見問題

**用了它，對話就是私密的嗎？** 不是。它減少可偵測的個資與憑證外洩，但上游仍讀得到其餘內容。

**為什麼用 `⟦EMAIL_1⟧`，不用假的 email？** 實測時模型逐字保留佔位符的比例是 100%，假值只有 75%，而且假值造成了無法還原的靜默錯誤。

**我的名字會被遮嗎？** 只有列進 `terms` 才會。

**為什麼請求被 422 拒絕？** 偵測到的值也出現在代理不改寫的欄位（例如圖片 URL 或 metadata），或你設定了 `screen: "refuse"`。訊息會指出欄位，不含值。

**代理會存我的金鑰或對話嗎？** 金鑰原樣轉送，不儲存。對話不存，唯一例外是 Responses API 接續用的最近 256 份輸入，只在記憶體中。

**能放在伺服器上給別人用嗎？** 不能。綁定位址固定為 `127.0.0.1`，而且沒有身分驗證。

## 📚 更多

[docs/DETAILS.md](docs/DETAILS.md) 包含架構、核心 API、遮罩順序與提示快取、不遮的欄位、422 拒絕、串流還原內部、`previous_response_id`、日誌、控制字元篩檢、威脅模型、完整設定、測試與誤遮量測方法。
