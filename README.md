# redaction-proxy

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

A small proxy on your own machine that replaces emails, API keys, ID numbers, and other personal data with placeholders before a prompt reaches a cloud LLM, and puts the real values back in the reply.

![Your AI tool sends lin@example.test to redaction-proxy on 127.0.0.1; the cloud LLM receives ⟦EMAIL_1⟧; the reply comes back with ⟦EMAIL_1⟧ and the proxy restores lin@example.test.](docs/media/hero.svg)

It works with any OpenAI- or Anthropic-compatible client, streaming included, and needs no local model. It **reduces** leaks of personal data and secrets; it does **not** make a conversation private.

> **Status:** pre-release, not on npm. Tested only against a local fake upstream; nothing has been verified with a real service or client yet.

## Intro video

[![A 30-second terminal recording: pnpm demo sends an email, a national ID, and a home path; the cloud sees only placeholders; the reply comes back with the real values.](docs/media/intro.gif)](docs/media/intro.mp4)

The recording replays real output of `pnpm demo` and of one more request through the proxy. [MP4 version](docs/media/intro.mp4).

## Quick start (30 seconds)

Requires Node 22.19+ and pnpm. From a clone of this repository:

```sh
pnpm install
pnpm demo          # no API key: fake upstream + proxy + one streamed request
pnpm build
node lib/cli.js    # the proxy, on http://127.0.0.1:8787
```

`pnpm demo` prints:

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 8ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

## Point your tool at it

> **Untested with real clients.** Only `pnpm demo` and the tests against a fake upstream have run. A harness for real services exists ([e2e/real](e2e/real/README.md)) but has not been run yet.

Your tool keeps sending its own API key; the proxy forwards it and never stores it.

| Tool | Setting | Status |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` | Untested |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (no `/v1`) | Untested |
| OpenAI SDK and most compatible tools | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` (with `/v1`) | Untested |
| DeepSeek | Start the proxy with `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com node lib/cli.js`, then use `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` with your DeepSeek key. This replaces the OpenAI upstream. | Untested |
| Cursor | Not supported: Cursor sends custom base-URL requests from its own servers, which cannot reach your `127.0.0.1`. | — |

<details><summary>curl example and configuration file</summary>

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"email lin@example.test"}]}'
```

Pass a JSON file with `node lib/cli.js --config redaction.json`; environment variables override it. Keys never go in the file, and an unknown key stops startup.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8787` | Binds `127.0.0.1` only. |
| `openaiUpstream` | `https://api.openai.com` | Upstream for Chat Completions and Responses. |
| `anthropicUpstream` | `https://api.anthropic.com` | Upstream for Anthropic Messages. |
| `redaction.terms` | none | Names and other words to mask, case-insensitive. |
| `redaction.projectNames` | none | Project code names to mask. |
| `redaction.allowlist` | `git@github.com`, `noreply@github.com` | Values never masked. |
| `redaction.rules` | all but `e164-phone` | Built-in rules to enable. `e164-phone` is off because it masks numeric diff lines. |
| `nameModel` | none | Turns on the [experimental name model](#optional-name-model-experimental). |
| `screen` | `replace` | On control characters: replace them with visible stand-ins (`replace`) or refuse the request (`refuse`). |
| `debugMasked` | `false` | Log each masked request body. |

```json
{
  "redaction": {
    "terms": ["林小明", "Denise Whitlock"],
    "projectNames": ["Nimbus"]
  }
}
```

Environment variables and every option: [technical details §12](docs/DETAILS.md#12-完整設定) (Traditional Chinese). The log has one line per request with counts and duration, never an original value or a header.

</details>

## What it masks

![A real request through the proxy: the tool sends a host name, a private IP, a home path, an API key, and an email; the cloud LLM receives placeholders such as ⟦HOST_1⟧ and ⟦KEY_1⟧; the reply comes back with the real values.](docs/media/before-after.png)

| Category | Example | The cloud sees |
| --- | --- | --- |
| Email | `lin@example.test` | `⟦EMAIL_1⟧` |
| API keys and credentials | `sk-…`, `ghp_…`, `AKIA…`, JWT, `Bearer …`, `password=…` | `⟦KEY_1⟧` |
| Home-directory path (prefix only) | `/Users/lin/notes.md` | `⟦PATH_1⟧/notes.md` |
| Private IP, internal host | `192.168.1.20`, `nas.local` | `⟦IP_1⟧`, `⟦HOST_1⟧` |
| Card number (Luhn checked) | 13–19 digits | `⟦CARD_1⟧` |
| Taiwan ID, mobile, business number | `A123456789`, `0912-345-678` | `⟦TWID_1⟧`, `⟦PHONE_1⟧` |
| IDs from 10 more countries and regions, IBAN | US SSN, UK NINO, Chinese resident ID, My Number, … | `⟦NATID_1⟧`, `⟦IBAN_1⟧` |
| Long random strings | hex or base64, 32+ characters | `⟦ENTROPY_1⟧` |
| Words you list | `terms`, `projectNames` | `⟦TERM_1⟧`, `⟦PROJECT_1⟧` |

The same value gets the same placeholder throughout a request. If a detected value is still in the request after masking, the proxy refuses to send it (422) rather than leak it. Full-width digits, `＠`, and zero-width characters are folded first. Every rule: [technical details §3](docs/DETAILS.md#3-偵測規則).

## Optional name model (experimental)

Off by default. Rules alone do not find names. Turn on a small local model ([`Wismut/nym-pii-multilingual-small`](https://huggingface.co/Wismut/nym-pii-multilingual-small), MIT, 108 MB) and it also masks person names, companies, places, and addresses in what **you** write (`⟦NAME_1⟧`, `⟦ORG_1⟧`, `⟦LOC_1⟧`, `⟦ADDR_1⟧`).

```sh
pnpm add -D onnxruntime-node@1.30.0 tokenizers@0.23.2   # the runtime, about 350 MB
node scripts/fetch-name-model.mjs ~/models/nym        # about 125 MB, sha256-checked
REDACTION_PROXY_NAME_MODEL_DIR=$HOME/models/nym node lib/cli.js
```

It misses some names and masks some words that are not names. Measured on synthetic data:

| | Result |
| --- | --- |
| Names in prose: English, Japanese | 1.00, 1.00 recall |
| Names in pasted code, logs, config | not read by the model; on the held-out set it fully masks 65–70% of all names |
| Names in prose: Traditional Chinese | **0.87** recall (about 1 name in 8 missed) |
| Names in pasted code, logs, JSON | 0.10–0.30 recall: code is not read; list such names in `terms` |
| Precision | 0.94 |
| Cost | about +420 MB memory, p95 about 130 ms per 2 KB of Chinese prose |

What it reads, every number, and the options: [technical details §16](docs/DETAILS.md#16-人名模型實驗性).

## Results

<!-- RESULTS:START -->
**held-out set (written blind, run once).** 1,518 synthetic prompts in 7 languages (English, Traditional and Simplified Chinese, Japanese, Korean, German, French), written by someone who never saw the rules, frozen with a SHA-256 checksum, and scored once. Nothing was changed after the results were seen.

![Bar chart: share of sensitive values fully masked per category on the English held-out prompts, proxy-default rules and rules plus name model against Presidio at cutoff 0.4.](docs/media/results.svg)

| held-out, English prompts (330) | core default rules | proxy default rules | + name model (experimental) | Presidio, cutoff 0 | Presidio, cutoff 0.4 |
| --- | --- | --- | --- | --- | --- |
| Fully masked (macro average of 10 categories) | 34.6% | 54.1% | **61.1%** | 52.2% | 50.7% |
| Masked regions that were sensitive | 95.2% | **95.7%** | 92.5% | 64.7% | 69.0% |
| Median time per prompt | 0.06 ms | 0.07 ms | 7.4 ms | 8.6 ms | 8.6 ms |
| Fully masked, all 7 languages | 38.8% | 56.0% | 64.3% | 46.6%* | 43.0%* |

\* Presidio analyzes every prompt as English, so its all-language results are for reference only.

**About the 100% cells.** Email, card and IBAN reach 100% because every value of those kinds in this set is written the standard way: no obfuscated emails (`name at example.com`, `name [at] example.com`), no lower-case IBANs, IBANs from only 7 countries, and cards only in common groupings. Those other spellings are known misses (see [Limitations](#what-it-does-not-protect)). The samples are also small (107 cards, 127 IBANs), so 100% here means roughly 97% or better. The next held-out version will include these spellings.

Self-check, not a score: in every prompt, restoring the masked text gave the original byte for byte. This tests the proxy against itself; no language model was involved.

Where it is weak:

- **Phone numbers.** 95% of English phone numbers are left untouched with the proxy default (the international `e164-phone` rule is opt-in); Presidio fully masks 82–85%.
- **Paths** are mostly only partly masked: the user name is masked, the rest of the path is kept.
- **Hosts and secrets.** About 30% of hosts and 26–28% of secrets are left untouched.
- **Addresses.** There is no address rule.
- **The name model** fully masks 65–70% of names, and it also masks user-agent strings.

The dev set scored much higher (77.8% English macro average for the proxy default) because it was written alongside the rules; it is kept only as a development check.

Full tables: [held-out results](bench/results/public-bench-held-out.md), [dev results](bench/results/public-bench-dev.md). Method and other measurements: [technical details §18](docs/DETAILS.md#18-實測數字).
<!-- RESULTS:END -->

## What it does not protect

- **Meaning.** The cloud still reads everything around the placeholders: `⟦PATH_1⟧/clients/acme-layoffs.md` still says a lot.
- **Names, addresses, health details, salaries**, unless you list them in `terms` or the name model finds them.
- **Images, PDFs, audio, `metadata`, tool names, signed thinking.** These are forwarded unchanged; if a detected value appears in one, the whole request is refused with 422.
- **Unusual spellings.** Some split or encoded forms slip through, such as `name @ domain` with spaces, `name at domain`, a lower-case IBAN, or a double percent-encoded value.
- **Cursor**, or any tool that sends requests from its own servers.
- **Other programs on your machine.** The proxy binds `127.0.0.1` only, with no authentication.

Also: a model that rewrites `⟦EMAIL_1⟧` as `[EMAIL_1]` shows it to you as written; tasks that need the masked value itself get worse; control characters become visible stand-ins; a restart forgets Responses API continuations. Full list: [technical details §17](docs/DETAILS.md#17-完整限制清單); threat model: [§11](docs/DETAILS.md#11-威脅模型).

## More

[docs/DETAILS.md](docs/DETAILS.md) (Traditional Chinese) covers the architecture, the comparison with dsh-privacy-router, the core API, every rule, streaming restore, 422 refusals, the threat model, the full configuration, tests, measurement methods, an FAQ, and how to regenerate the images and video in this README.

## License

[Apache-2.0](LICENSE). Parts of the rules and engine descend from [LYiHub/pub-dsh-privacy-router](https://github.com/LYiHub/pub-dsh-privacy-router) (MIT); see [NOTICE](NOTICE).
