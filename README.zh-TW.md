# redaction-proxy

[English](README.md)

在本機執行的 HTTP 代理：把送往 LLM API 的請求中的個資與機密遮罩掉，再在回應（包括串流回應）中還原。它位於你的用戶端與 OpenAI 相容或 Anthropic 相容的上游之間，把偵測到的每個值換成 `⟦EMAIL_1⟧` 這類不透明的佔位符。

它**減少**離開你電腦的個資與憑證數量，但**不會**讓對話變成私密的：遮罩藏住的是實體，不是語意。

狀態：私有、尚未發布，沒有發布到 npm。

## 已知限制（請先讀）

- **遮罩藏住實體，不藏語意。** 上游仍然讀得到佔位符周圍的一切：你在做什麼、你以什麼角色談論誰、你的程式碼、你的計畫。`⟦PATH_1⟧/clients/acme-layoffs.md` 依然透露很多。
- **只有規則偵測得到的才會被遮。** 沒有自由文字的人名偵測，也沒有街道地址規則。人名、公司名、代號只有列進 `terms` 或 `projectNames` 才會被遮。其他內容（病況、薪資、通訊地址）照原樣送出。
- **有些欄位刻意不遮就轉送：** 圖片、PDF、音訊（`data`、`url`、`image_url`、`file_data`）、`metadata`、工具與參與者的 `name`、模型 id，以及帶簽章或加密的模型狀態（`thinking`、`signature`、`encrypted_content`）。如果請求裡別處偵測到的值也出現在這些欄位中，代理會以 422 拒絕整個請求，並指出欄位位置（絕不包含值本身）。偵測到的值若再次出現在較長的詞中間而未被遮，也會觸發同樣的拒絕。
- **還原只認標準的 `⟦CATEGORY_n⟧` 形式。** 模型若把佔位符改寫成 `EMAIL_1`、`[EMAIL_1]`、`〚EMAIL_1〛`，你會原樣看到。請求中從未綁定的佔位符（模型編出來的 id）保留為字面佔位符。Anthropic 的 thinking 內容會帶著佔位符顯示，因為還原它會讓用戶端回傳時簽章失效。
- **模型品質可能下降**，例如需要直接操作被遮值的任務（把絕對路徑改成相對路徑）、或對地點做推理。這類失敗看得見（你會看到佔位符），不是靜默出錯。
- **預設還會以另外兩種方式改動請求文字**（`screen: "replace"`）：控制字元、U+FFFD、孤立 surrogate 會換成可見替代字元（`␛`、`␦`），文字中原本就有的 `⟦`、`⟧` 會換成 `⟪`、`⟫`。設定 `screen: "refuse"` 則改為拒絕這類請求。
- **Responses API 的接續請求**（`previous_response_id`）依賴代理放在行程記憶體中的輸入文字（最近 256 個回應）。代理重啟後，這類對話先前輪次的佔位符就無法再還原。
- **socket 沒有身分驗證。** 只綁定 `127.0.0.1`，但你電腦上的任何程式都能使用它，包括環境變數中設定的備援金鑰。
- **Cursor 無法使用。** Cursor 的自訂 base URL 請求是從它自己的伺服器發出，連不到本機回環位址；而且在任何代理之前，Cursor 的後端就已經看到未遮罩的提示。
- **只對假上游測試過。** 端對端測試與示範都用本機假伺服器，尚未對真實的 OpenAI、Anthropic、DeepSeek API 或真實用戶端驗證。

## 快速開始

需要 Node 22.19 以上與 pnpm。

```sh
pnpm install
pnpm demo                     # 不需金鑰：假上游 + 代理 + 一次串流請求
pnpm build
node lib/cli.js               # http://127.0.0.1:8787 -> api.openai.com / api.anthropic.com
```

示範輸出：

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 7ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

## 讓用戶端走代理

以下是可嘗試的設定，尚未逐一在各用戶端驗證。

| 用戶端 | 設定 |
| --- | --- |
| OpenAI SDK 與多數 OpenAI 相容工具 | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`（注意 `/v1`） |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`（不加 `/v1`） |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` |
| curl | `curl http://127.0.0.1:8787/v1/chat/completions -H "authorization: Bearer $KEY" ...` |
| Cursor | 不支援，見限制。 |

用戶端照常送出自己的金鑰；代理原樣轉送 `authorization`、`x-api-key`、`anthropic-*` 標頭，從不儲存。

要換上游，把 base 設成讓 `<base>/v1/chat/completions`（或 `<base>/v1/messages`）是真正的端點，例如 `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com`。

## 設定

以 `--config 路徑`（或 `REDACTION_PROXY_CONFIG`）指定 JSON 檔，環境變數可覆寫。不認得的鍵會被拒絕；金鑰永遠不放在檔案裡。欄位與環境變數見[英文版的設定一節](README.md#configuration)。

日誌每個請求一行：方法、路徑（不含查詢字串）、狀態碼、各類別遮罩數、還原數與耗時。絕不包含原始值或標頭。`REDACTION_PROXY_DEBUG_MASKED=1` 才會記錄遮罩後的請求內容。

## 會遮哪些東西

| 規則 | 類別 | 說明 |
| --- | --- | --- |
| `email` | `EMAIL` | 以 `@` 為錨點、有上限地向兩側展開。 |
| `user-path` | `PATH` | 只遮家目錄前綴（`/Users/x`、`/home/x`、`C:\Users\x`、`~x/`），含 JSON 跳脫形式；路徑其餘部分保持可讀。 |
| `api-key` | `KEY` | PEM、AWS `AKIA`/`ASIA`、GitHub `ghp_` 系列、`sk-`、Slack `xox` 與 webhook、Google `AIza`、JWT、`Authorization`/`Bearer`、URL 中的帳密、`curl -u`、`--password x`，以及鍵名代表憑證的 `key=value` 指派（含中英文關鍵詞）。 |
| `tw-national-id` | `TWID` | 中華民國身分證字號（`A123456789`）與居留證號（第二碼 8/9），**驗證檢查碼**。 |
| `phone` | `PHONE` | 手機 `09xx-xxx-xxx` 與 `+886` 形式不需關鍵詞；市話（`02-2345-6789`、`(02)2345-6789`）需在「電話」、tel 等關鍵詞之後。 |
| `tax-id` | `TAXID` | 關鍵詞後的 8 碼統一編號。 |
| `card` | `CARD` | 13–19 碼、**Luhn 驗證**、檢查發卡機構前綴，並把視窗錨定在數字組邊界，避免遮到時間戳與 snowflake id。 |
| `ip` | `IP` | RFC 1918 私有位址，並檢查每段數值。 |
| `host` | `HOST` | `.local`、`.lan`、`.internal` 主機名。 |
| `entropy` | `ENTROPY` | 高熵的長 hex 或大小寫混合 base64；`commit`/`sha` 旁的雜湊會放過。 |
| `terms` | `TERM` | 你指定的字面值，不分大小寫，也比對 `\uXXXX` 跳脫形式。 |
| `projectNames` | `PROJECT` | 同上，另一個類別。 |

每條規則也會在去除零寬字元後的 NFKC 投影上再跑一次，所以全形數字（`０９１２３４５６７８`）、全形 `＠`、`ali\u200bce@…` 都抓得到。一個值被偵測到之後，它在同一請求中的其他出現位置也會用同一個佔位符遮掉。

## 運作方式

- **用佔位符，不用假值。** 每個不同的值得到一個 `⟦CATEGORY_n⟧`。以假值替換（「數位分身」）經過實測後被否決：模型逐字保留佔位符的比例是 100%，假值只有 75%；假值還造成無法還原的靜默錯誤（18 段對話中 5 段）。
- **不需狀態的對話內一致編號。** 用戶端每次都會重送完整歷史，而編號依文字順序（先工具與系統提示）分配，所以只增不改的對話中，同一個值每一輪都得到同一個佔位符。遮罩後的前綴因此逐位元組穩定，上游的提示快取照常生效。後面的訊息若含有字面的 `EMAIL_3`，會保留這個 id，可能讓在它之後首次出現的值重新編號。
- **串流還原。** 每個串流文字欄位（內容、推理、每個工具呼叫的參數）各有一個還原器，只扣住可能成為佔位符的前綴（最多 64 字元），其餘立即送出。佔位符被切成任意多段也只會還原一次。工具呼叫的參數是 JSON 文字，所以原始值會以 JSON 跳脫寫入。
- **送出前失敗即關閉。** 遮罩後會在序列化的請求中搜尋每個被偵測到的原始值（原樣與 JSON 跳脫形式），找到就以 422 拒絕而不送出。代理不遮罩的 POST 路由（例如 `/v1/embeddings`）以 404 拒絕；其他 GET 請求照常轉送。

## 威脅模型

能防：經由代理、位於被改寫欄位中的可偵測識別資料與憑證，不小心洩漏給上游供應商，以及之後讀取其日誌或訓練資料的人。

不能防：

- 從上下文推論（佔位符周圍的語意），以及規則偵測不到的識別資料；
- 不遮就轉送的欄位內容（圖片、檔案、metadata、帶簽章的 thinking）；
- 繞過代理的用戶端，或用戶端直接連自家伺服器的功能（遙測、Cursor 後端）；
- 同一台電腦上的其他程式或使用者，他們可以呼叫代理或讀取其記憶體；
- 惡意上游誘導模型以非標準形式寫回值（還原只填佔位符，從不把原始值送往上游）；
- 輸入者刻意規避（例如用規則不會折疊的字元拆開一個值）。

## 實測誤遮率

語料：DeepSeek Harness 倉庫 `6d3b7608bf`，目錄 `packages`、`docs`、`scripts`；檔案類型 `.ts .md .yml .yaml .json .sh .py`、小於 512 KB，排除 snapshot、session、fixture 與建置輸出。共 4,789 個檔案、848,546 行，其中程式碼檔 697,669 行。預設規則。以 `pnpm bench` 重現。

| 指標 | 數值 |
| --- | --- |
| 程式碼檔中的憑證（`KEY`）遮罩，全部是誤遮 | **每千行程式碼 0.76**（527 處） |
| 全部行數上的 `KEY` | 每千行 0.68 |
| `ENTROPY` | 每千行 1.03 |
| `PATH` / `HOST` / `IP` / `EMAIL` / `CARD` / `PHONE` / `TWID` | 每千行 0.24 / 0.19 / 0.05 / 0.02 / <0.01 / <0.01 / <0.01 |
| 被拒絕的檔案（含 `⟦`/`⟧` 或控制字元） | 4,789 個中 29 個 |
| 還原失敗 | 0 |
| 處理量 | Apple M5 Max 上約 4.8 秒遮罩 85 萬行 |

`KEY` 以外的類別是誤遮的上限：文件中有合理應被遮的範例路徑與地址。先前筆記把 0.68 寫成每千行程式碼的數字，它其實對應的是現在的「全部行數」比率。這份語料是英文程式碼；以中文為主的散文語料尚未量測。

## 測試

`pnpm test` 執行 418 個測試：與 DeepSeek Harness 轉接層共用的規則與引擎測試；對抗測試（洩漏與往返、失敗即關閉的篩檢、35 種 200 KB 病態輸入各須在 2 秒內、串流回覆的所有 2 段與 3 段切法、100 KB 串流以 4 字元為單位）；以及對假上游的代理端對端測試，涵蓋 Chat Completions、Responses、Anthropic Messages 的 JSON 與 SSE，佔位符跨越分塊邊界並出現在工具呼叫 JSON 中。

## 目錄

- `src/core/` — 遮罩核心：規則、佔位符引擎、嚴格與串流還原。沒有執行期相依、沒有宿主型別。DeepSeek Harness 以 git submodule（`dsh-addons/vendor/redaction-proxy`）使用它；核心只在這裡修改。
- `src/proxy/` — HTTP 代理與設定；`src/cli.ts` — 命令列。
- `bench/` — 誤遮率量測與免金鑰示範。
