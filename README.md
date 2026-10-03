# redaction-proxy

[繁體中文](README.zh-TW.md)

A local HTTP proxy that masks PII and secrets in LLM API requests and restores them in the responses, including streamed responses. It sits between your client and an OpenAI-compatible or Anthropic-compatible upstream, replacing each detected value with an opaque placeholder such as `⟦EMAIL_1⟧`.

It **reduces** how much personal data and how many credentials leave your machine. It does **not** make a conversation private: masking hides entities, not meaning.

Status: private, pre-release. Not published to npm.

## Known limitations (read first)

- **Masking hides entities, not meaning.** The upstream still reads everything around the placeholders: what you are doing, who you are talking about by role, your code, your plans. `⟦PATH_1⟧/clients/acme-layoffs.md` still says a lot.
- **Only what the rules detect is masked.** There is no free-text name detection and no street-address rule. Personal names, company names, and code names are masked only if you list them as `terms` or `projectNames`. Anything else (a health condition, a salary, a postal address) goes through as written.
- **Some fields are forwarded unmasked by design:** images, PDFs, and audio (`data`, `url`, `image_url`, `file_data`), `metadata`, tool and participant `name`s, model ids, and signed or encrypted model state (`thinking`, `signature`, `encrypted_content`). If a value detected elsewhere in the request also appears in one of them, the proxy refuses the request with 422 and names the field (never the value). The same refusal fires when a detected value recurs inside a longer token, where it is not masked.
- **Restore recognizes only the canonical `⟦CATEGORY_n⟧` form.** If a model rewrites a placeholder (`EMAIL_1`, `[EMAIL_1]`, `〚EMAIL_1〛`), it reaches you as written. A placeholder the request never bound (a hallucinated id) stays as the literal placeholder. Anthropic thinking text is shown with placeholders, because restoring it would break its signature when the client resends it.
- **Model quality can drop** on tasks that operate on the masked value itself, such as turning an absolute path into a relative one, or reasoning about a location. These failures are visible (you see the placeholder), not silent.
- **Request text is altered in two more ways by default** (`screen: "replace"`): control characters, U+FFFD, and lone surrogates become visible stand-ins (`␛`, `␦`), and a `⟦` or `⟧` already in the text becomes `⟪` or `⟫`. Set `screen: "refuse"` to reject such requests instead.
- **Responses API continuations** (`previous_response_id`) depend on input texts the proxy keeps in process memory (last 256 responses). After a restart, placeholders from earlier turns of such a conversation are no longer restored.
- **No authentication on the socket.** It binds `127.0.0.1` only, but any process on your machine can use it, including any fallback key set in the environment.
- **Cursor cannot use it.** Cursor sends custom base-URL requests from its own servers, so a loopback proxy is unreachable, and Cursor's backend sees the unmasked prompt before any proxy would.
- **Tested against a fake upstream only.** The end-to-end suite and the demo use a local fake server. It has not yet been exercised against the real OpenAI, Anthropic, or DeepSeek APIs or real clients.

## Quick start

Requires Node 22.19+ and pnpm.

```sh
pnpm install
pnpm demo                     # keyless: fake upstream + proxy + one streamed request
pnpm build
node lib/cli.js               # http://127.0.0.1:8787 -> api.openai.com / api.anthropic.com
```

The demo prints:

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 7ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

## Pointing clients at it

These are configurations to try, not yet verified against each client.

| Client | Setting |
| --- | --- |
| OpenAI SDK, most OpenAI-compatible tools | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` (note the `/v1`) |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (no `/v1`) |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` |
| curl | `curl http://127.0.0.1:8787/v1/chat/completions -H "authorization: Bearer $KEY" ...` |
| Cursor | Not supported; see limitations. |

Your client keeps sending its own key; the proxy forwards `authorization`, `x-api-key`, and `anthropic-*` headers unchanged and never stores them.

To use another upstream, set its base so that `<base>/v1/chat/completions` (or `<base>/v1/messages`) is the real endpoint, for example `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com`.

## Configuration

A JSON file passed with `--config path` (or `REDACTION_PROXY_CONFIG`), overridden by environment variables. Unknown keys are rejected; keys never belong in the file.

```json
{
  "port": 8787,
  "openaiUpstream": "https://api.openai.com",
  "anthropicUpstream": "https://api.anthropic.com",
  "screen": "replace",
  "debugMasked": false,
  "redaction": {
    "terms": ["林小明", "Denise Whitlock"],
    "projectNames": ["Nimbus"],
    "allowlist": ["git@github.com", "noreply@github.com"],
    "rules": ["email", "user-path", "api-key", "tw-national-id", "phone", "tax-id", "card", "ip", "host", "entropy"]
  }
}
```

| Environment variable | Meaning |
| --- | --- |
| `REDACTION_PROXY_PORT` | Port on 127.0.0.1 (default 8787). The bind address is fixed. |
| `REDACTION_PROXY_OPENAI_UPSTREAM`, `REDACTION_PROXY_ANTHROPIC_UPSTREAM` | Upstream base URLs. |
| `REDACTION_PROXY_OPENAI_API_KEY`, `REDACTION_PROXY_ANTHROPIC_API_KEY` | Optional fallback key, used only when the client sends none. Held in memory only. |
| `REDACTION_PROXY_SCREEN` | `replace` or `refuse`. |
| `REDACTION_PROXY_DEBUG_MASKED=1` | Log each masked request body. Off by default. |

The log has one line per request: method, path (no query string), status, counts per category, restore counts, and duration. It never contains an original value or a header.

## What it masks

| Rule | Category | Detail |
| --- | --- | --- |
| `email` | `EMAIL` | Anchored at `@`, bounded expansion. |
| `user-path` | `PATH` | The home prefix only (`/Users/x`, `/home/x`, `C:\Users\x`, `~x/`), including JSON-escaped forms; the rest of the path stays readable. |
| `api-key` | `KEY` | PEM blocks, AWS `AKIA`/`ASIA`, GitHub `ghp_` family, `sk-`, Slack `xox` and webhooks, Google `AIza`, JWTs, `Authorization`/`Bearer`, URL userinfo, `curl -u`, `--password x`, and `key=value` assignments whose key names a credential (English and Chinese keywords). |
| `tw-national-id` | `TWID` | Taiwan national ID (`A123456789`) and resident certificate numbers (second digit 8/9), **checksum verified**. |
| `phone` | `PHONE` | Taiwan mobile `09xx-xxx-xxx` and `+886` forms without a keyword; landlines (`02-2345-6789`, `(02)2345-6789`) after a keyword such as 電話 or tel. |
| `tax-id` | `TAXID` | 8-digit Taiwan business number (統一編號) after a keyword. |
| `card` | `CARD` | 13–19 digits, **Luhn verified**, issuer prefix checked, window anchored to digit-group boundaries so timestamps and snowflake ids are not masked. |
| `ip` | `IP` | RFC 1918 private addresses with octets checked. |
| `host` | `HOST` | `.local`, `.lan`, `.internal` host names. |
| `entropy` | `ENTROPY` | Long hex or mixed-case base64 runs with high entropy; commit hashes next to `commit`/`sha` are left alone. |
| `terms` | `TERM` | Your literals, case-insensitive, also matched in `\uXXXX`-escaped form. |
| `projectNames` | `PROJECT` | Same, under a separate category. |

Every rule also runs over an NFKC projection with zero-width characters removed, so full-width digits (`０９１２３４５６７８`), full-width `＠`, and `ali\u200bce@…` are caught. Once a value is detected, every other occurrence of it in the request is masked with the same placeholder.

## How it works

- **Placeholders, not fake values.** Each distinct value gets `⟦CATEGORY_n⟧`. Fake look-alike values ("digital twins") were measured and rejected: models kept placeholders verbatim 100% of the time against 75% for twins, and twins produced silent errors (5 of 18 conversations) that no restore can undo.
- **Per-conversation numbering without state.** Clients resend the whole history on every call, and numbering follows text order (tools and system prompt first), so the same value gets the same placeholder on every turn of an append-only conversation. This also keeps the masked prefix byte-stable, so upstream prompt caching keeps working. A later message that contains a literal `EMAIL_3` reserves that id, which can renumber values first seen after it.
- **Streaming restore.** Each streamed text field (content, reasoning, each tool call's arguments) has its own restorer that holds back only a possible placeholder prefix (at most 64 characters) and releases everything else immediately. A placeholder split across any number of chunks is restored exactly once. Tool-call arguments are JSON text, so originals are written JSON-escaped there.
- **Fail closed on the way out.** After masking, the serialized request is checked for every detected original (raw and JSON-escaped). Any hit refuses the request with 422 instead of sending it. POST routes the proxy does not mask (`/v1/embeddings`, for instance) are refused with 404; other GET requests are relayed.

Supported routes: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, `POST /v1/messages/count_tokens`, and `GET` anything.

## Threat model

Protects against: accidental disclosure of detectable identifiers and credentials to the upstream provider and to anyone who later reads its logs or training data, for content that passes through the proxy in the rewritten fields.

Does not protect against:

- inference from context (the meaning around placeholders), and identifiers the rules do not detect;
- content in fields forwarded unmasked (images, files, metadata, signed thinking);
- a client that bypasses the proxy, or features of a client that talk to their own servers (telemetry, Cursor's backend);
- other local processes or users on the same machine, which can call the proxy or read its memory;
- a malicious upstream steering the model to write values back in a non-canonical form (restore only fills placeholders; it never sends originals upstream);
- deliberate evasion by the person typing (for example splitting a value with characters the rules do not fold).

## Measured false positives

Corpus: the DeepSeek Harness repository at `6d3b7608bf`, directories `packages`, `docs`, `scripts`; files `.ts .md .yml .yaml .json .sh .py` under 512 KB, excluding snapshots, sessions, fixtures, and build output. 4,789 files, 848,546 lines, of which 697,669 in code files. Default rules. Reproduce with `pnpm bench` (`CORPUS_REPO`, `CORPUS_REF` to change it).

| Metric | Value |
| --- | --- |
| Credential (`KEY`) spans in code files, all false positives | **0.76 per 1,000 code lines** (527 spans) |
| `KEY` spans over all lines | 0.68 per 1,000 lines |
| `ENTROPY` | 1.03 per 1,000 lines |
| `PATH` / `HOST` / `IP` / `EMAIL` / `CARD` / `PHONE` / `TWID` | 0.24 / 0.19 / 0.05 / 0.02 / <0.01 / <0.01 / <0.01 per 1,000 lines |
| Files refused (contain `⟦`/`⟧` or control characters) | 29 of 4,789 |
| Restore failures | 0 |
| Throughput | about 850k lines masked in 4.8 s on an Apple M5 Max |

Categories other than `KEY` are an upper bound on false positives: documentation contains example paths and addresses that are legitimately masked. An earlier note quoted 0.68 as the per-code-line rate; that figure matches today's all-lines rate. The corpus is English code; a Chinese-heavy prose corpus has not been measured.

## Tests

`pnpm test` runs 418 tests: the rule and engine suites shared with the DeepSeek Harness adapters; the adversarial suite (leak and round-trip cases, fail-closed screening, 35 pathological 200 KB inputs under 2 s each, every 2- and 3-way chunk split of streamed replies, 100 KB streams in 4-character chunks); and proxy end-to-end tests against a fake upstream for Chat Completions, Responses, and Anthropic Messages, JSON and SSE, with placeholders split across chunk boundaries and inside tool-call JSON.

## Layout

- `src/core/` — the redaction core: rules, placeholder engine, strict and streaming restore. No runtime dependencies and no host types. DeepSeek Harness consumes it as a git submodule (`dsh-addons/vendor/redaction-proxy`); change the core here only.
- `src/proxy/` — the HTTP proxy and its configuration; `src/cli.ts` — the command line.
- `bench/` — false-positive benchmark and keyless demo.
