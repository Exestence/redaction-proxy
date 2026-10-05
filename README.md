# redaction-proxy

[繁體中文](README.zh-TW.md) · [Technical details (zh-TW)](docs/DETAILS.md)

A small proxy that runs on your machine. Before your AI tool sends a prompt to a cloud LLM, it replaces email addresses, Taiwan national IDs, phone numbers, API keys, home-directory paths, and similar values with placeholders such as `⟦EMAIL_1⟧`; when the model's reply comes back, it puts the original values back, streamed replies included. It works with any OpenAI-compatible or Anthropic-compatible client and needs no local model. It **reduces** leakage of personal data and secrets; it does **not** make a conversation private.

> Status: private, pre-release, not published to npm. Tested against a local fake upstream only.

## ⚠️ Read first: what it does not protect

| Limitation | What it means |
| --- | --- |
| Hides entities, not meaning | The upstream still reads everything around the placeholders. `⟦PATH_1⟧/clients/acme-layoffs.md` still says a lot. |
| Names and addresses only if listed | There is no free-text name detection and no address rule. List names, companies, and code names in `terms` or `projectNames`. Health conditions, salaries, and postal addresses go through as written. |
| Some fields are not masked | Images, PDFs, audio, `metadata`, tool names, and signed thinking are forwarded unchanged. If a detected value appears in one of them, the whole request is refused with 422. |
| Cursor cannot use it | Cursor sends custom base-URL requests from Cursor's own servers, which cannot reach your `127.0.0.1`; and Cursor's backend sees the unmasked prompt before any proxy would. |
| Some split spellings are missed | Not detected: a private IP with spaces after the dots (`192. 168. 1. 2`); an API key split by a space or a line break (the high-entropy rule catches some halves); an email address written `name @ domain` with spaces (`wang.yichun @ example.tw`) or with a bare ` at ` (`wang.yichun at example.tw`) is not masked, because shell prompts (`root @ web01.example.com`), handles (`cc @ alice.me`), prose (`socket.io at github.com`), and matrix code (`a.b @ c.de`) look the same; the privacy classifier is the only guard for it. Detected: spaced or dashed terms, `＠`, `(at)`, `[at]`, `[dot]`, and IDs, business numbers, and mobile numbers with one separator inside. |
| Some encoded spellings are missed | Percent-encoded values (`lin.yating%40example.com`, `%E6%98%9F…` in a query string, `%2FUsers%2F…`) are decoded one level and masked as written, and the reply gets the encoded text back. A stray or truncated escape (`%FF`, a URL cut after `%E6`) does not stop the rest from decoding, decoded full-width or zero-width characters are folded as in plain text, and a stray escape right before a number or a token (`%E6%2B886…`, `%E609-1234-5678`, `%FFsk-…`) does not hide it. Not detected: a double-encoded value (`%2540`); a `+` meant as a space in a form-encoded query (`星河+計畫`); a value base64-encoded inside a URL (the privacy router decodes base64 only in tool output); an identification number right after a stray escape (`%E6A123456789`), because in Big5 and Shift-JIS the letter after a lead byte is part of the character (`%A4A` is 乙). For the same reason a Shift-JIS character whose trail byte is `A` can turn `%83AKIA…` into a masked key-shaped span. |
| One placeholder per term, first spelling restored | `星河計畫`, `星河 計畫`, and `NIMBUS-7` / `nimbus 7` each share one placeholder per configured term, and the reply gets the first spelling of the request back at every position. |
| Only the canonical placeholder | If the model rewrites `⟦EMAIL_1⟧` as `[EMAIL_1]`, you see it as written. |
| Model quality can drop | Tasks that operate on the masked value itself (turning an absolute path into a relative one, say) get worse. You see the placeholder; the failure is not silent. |
| Some characters are changed | By default control characters become visible stand-ins (`␛`), and a `⟦` or `⟧` already in the text becomes `⟪` or `⟫`. |
| A restart forgets continuations | Responses API `previous_response_id` relies on the last 256 responses held in memory; after a restart, placeholders from earlier turns are not restored. |
| No local authentication | It binds `127.0.0.1` only, but any process on your machine can use it. |
| Not tested against real services | Tests and the demo use a local fake upstream; nothing has been verified against OpenAI, Anthropic, DeepSeek, or real clients yet. A harness for that exists ([e2e/real](e2e/real/README.md)) but has not been run. |

## 🔄 How it works

```mermaid
flowchart LR
  C["Your client"] -- "original prompt" --> M["Proxy: mask"]
  M -- "placeholders such as ⟦EMAIL_1⟧" --> U["Cloud LLM"]
  U -- "streamed reply with placeholders" --> R["Proxy: restore"]
  R -- "originals put back" --> C
```

- The same value gets the same placeholder throughout a request.
- The proxy keeps no conversation state. It renumbers from the full history on every request, so a conversation keeps the same numbering on every turn and upstream prompt caching keeps working.
- If any original can still be found in the request after masking, the proxy refuses to send it (422) instead of risking a leak.
- Your client sends its own key as usual; the proxy forwards it unchanged and never stores it.

When a placeholder is split across two streamed chunks, the proxy holds back only the part that could be a placeholder and sends everything else at once:

```mermaid
sequenceDiagram
  participant U as Cloud LLM
  participant P as Proxy
  participant C as Client
  U->>P: "I will email ⟦EM"
  P->>C: "I will email "
  Note over P: holds ⟦EM
  U->>P: "AIL_1⟧ about"
  P->>C: "lin@example.test about"
```

## 🔍 What gets masked

| Category | Example input | Upstream sees |
| --- | --- | --- |
| Email | `lin@example.test` | `⟦EMAIL_1⟧` |
| Home-directory path (prefix only) | `/Users/lin/notes.md` | `⟦PATH_1⟧/notes.md` |
| API keys and credentials | `sk-...`, `ghp_...`, `AKIA...`, JWT, `Bearer ...`, `password=...` | `⟦KEY_1⟧` (key names such as `password=` stay) |
| Taiwan national ID and resident certificate (**checksum verified**) | `A123456789` | `⟦TWID_1⟧` |
| Taiwan mobile | `0912-345-678`, `+886 912 345 678` | `⟦PHONE_1⟧` |
| Landline (after a keyword such as 電話 or tel) | `電話 02-2345-6789` | `電話 ⟦PHONE_1⟧` |
| Business number 統一編號 (after a keyword) | `統編 12345678` | `統編 ⟦TAXID_1⟧` |
| Card number (**Luhn verified**) | 13–19 digit card number | `⟦CARD_1⟧` |
| Private IP | `192.168.1.20` | `⟦IP_1⟧` |
| Internal host name | `nas.local`, `db.internal` | `⟦HOST_1⟧` |
| High-entropy string | hex or base64 of 32+ characters | `⟦ENTROPY_1⟧` |
| Words you list (`terms`) | `林小明` | `⟦TERM_1⟧` |
| Code names you list (`projectNames`) | `Nimbus` | `⟦PROJECT_1⟧` |

Full-width digits (`０９１２３４５６７８`), a full-width `＠`, and values split by zero-width characters are caught too. See the [technical details](docs/DETAILS.md#3-偵測規則) for every rule.

## 🚀 Quick start

Requires Node 22.19+ and pnpm.

```sh
pnpm install
pnpm demo          # keyless: fake upstream + proxy + one streamed request
pnpm build
node lib/cli.js    # starts on http://127.0.0.1:8787
```

`pnpm demo` prints:

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 7ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

## 🔌 Pointing clients at it

> **None of these has been verified with a real client yet.** Only `pnpm demo` and the tests against a fake upstream have actually run.

| Client | Setting | Status |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` | Untested |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (no `/v1`) | Untested |
| OpenAI SDK and most compatible tools | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` (with `/v1`) | Untested |
| curl | See below | Untested |
| Cursor | Not supported; see the limitations | — |

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"email lin@example.test"}]}'
```

To use another compatible service, such as DeepSeek: `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com node lib/cli.js`.

## ⚙️ Configuration

Pass a JSON file with `node lib/cli.js --config redaction.json`; environment variables override it. Keys never go in the file; an unknown key stops startup.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8787` | Binds `127.0.0.1` only. |
| `openaiUpstream` | `https://api.openai.com` | Upstream for Chat Completions and Responses. |
| `anthropicUpstream` | `https://api.anthropic.com` | Upstream for Anthropic Messages. |
| `redaction.terms` | none | Names and other words to mask, case-insensitive. |
| `redaction.projectNames` | none | Project code names to mask. |
| `redaction.allowlist` | `git@github.com`, `noreply@github.com` | Values never masked. |
| `redaction.rules` | all | Built-in rules to enable. |
| `screen` | `replace` | On control characters, replace them with visible stand-ins (`replace`) or refuse the request (`refuse`). |
| `debugMasked` | `false` | Log each masked request body. |

```json
{
  "redaction": {
    "terms": ["林小明", "Denise Whitlock"],
    "projectNames": ["Nimbus"]
  }
}
```

See the [technical details](docs/DETAILS.md#12-完整設定) for the matching environment variables and the full reference. The log has one line per request with counts and duration only, never an original value or a header.

## 📊 Measured numbers

| Item | Result | What it means |
| --- | --- | --- |
| Tests | 418, all passing | Rules, engine, adversarial inputs, and streamed and non-streamed requests for all three APIs against a fake upstream. |
| Credential false positives | **0.76** per 1,000 code lines | Measured on DeepSeek Harness source, which holds no real key (698k code lines): about one spot every 1,300 lines is mistaken for a key and masked. |
| Restore failures | 0 | Every file that was masked restores byte for byte. |
| Speed | about 850k lines in 5 s | Apple M5 Max. |
| Synthetic multilingual prompts | recall 78.6%, precision 96.0%, restore 100% | 1,200 seeded prompts in English, zh-TW, zh-CN, and Japanese, compared with Presidio: [bench/results/public-bench.md](bench/results/public-bench.md). Misses are names, non-Taiwan phone numbers and IDs; bare commit hashes are masked. |

A false positive costs the model one unnecessary placeholder, which is restored in the reply. The corpus is English code; Chinese prose has not been measured. Reproduce with `pnpm test`, `pnpm bench`, and `pnpm run bench:public`.

## 🆚 Compared with dsh-privacy-router

| | redaction-proxy (this repo) | [dsh-privacy-router](https://github.com/PersonalAssistanceHsin/dsh-privacy-router) |
| --- | --- | --- |
| Form | Standalone HTTP proxy | dsh plugin |
| Clients | Any OpenAI- or Anthropic-compatible client | dsh only |
| Routing | None: every request goes upstream, masked | Decides per turn between a local model and the cloud |
| Local model | Not needed | Needed |
| Masking core | Lives here (`src/core/`) | dsh-addons' redaction packages vendor this core as a git submodule |
| Streaming restore | `src/core/restore.ts` | Still has its own restorer; unification is planned |

## ❓ FAQ

**Does it make my conversation private?** No. It reduces leakage of detectable personal data and credentials, but the upstream still reads everything else.

**Why `⟦EMAIL_1⟧` and not a fake email?** In measurements, models kept placeholders verbatim 100% of the time against 75% for fake values, and fake values caused silent errors no restore can undo.

**Will my name be masked?** Only if you list it in `terms`.

**Why was my request refused with 422?** A detected value also appears in a field the proxy does not rewrite (an image URL or metadata, for instance), or you set `screen: "refuse"`. The message names the field, never the value.

**Does the proxy store my key or my conversation?** Keys are forwarded and never stored. Conversations are not stored, except the inputs of the last 256 Responses API responses, kept in memory for continuations.

**Can I run it on a server for other people?** No. The bind address is fixed to `127.0.0.1`, and there is no authentication.

## 📚 More

[docs/DETAILS.md](docs/DETAILS.md) (Traditional Chinese) covers the architecture, core API, masking order and prompt caching, unmasked fields, 422 refusals, streaming restore internals, `previous_response_id`, logging, control-character screening, the threat model, the full configuration, tests, and the false-positive method.
