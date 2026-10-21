# Real-service harness

Drives the proxy against real OpenAI, Anthropic, and DeepSeek APIs with synthetic data. It is not part of `pnpm test` and costs a few cents of API usage per run.

```sh
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... DEEPSEEK_API_KEY=... pnpm run e2e:real
```

A provider whose key is not set is skipped. Keys are read from the environment only and are never printed; an upstream error that quotes the key is shown with the key replaced.

Last real runs: on 2026-10-21, with only `ANTHROPIC_API_KEY` set and `E2E_ANTHROPIC_MODEL=claude-haiku-5-5`, Anthropic Messages passed 4 of 4 scenarios with `E2E_CLIENT=sdk` (`@anthropic-ai/sdk` 0.135.0) and 4 of 4 with `fetch`; OpenAI and DeepSeek were skipped (no keys). On 2026-10-08, with only `DEEPSEEK_API_KEY` set, DeepSeek Chat Completions passed 4 of 4 scenarios. The OpenAI SDK client path has run only against the fake upstream in `pnpm test`.

## What it checks

Each request goes client → proxy → tee → service. The tee is a local pass-through that records the exact request body the service received and the exact response it sent back.

| Provider | Wire APIs | Scenarios per API |
| --- | --- | --- |
| OpenAI | Chat Completions, Responses | JSON and streamed, each as plain text and as a forced tool call |
| Anthropic | Messages | same |
| DeepSeek | Chat Completions | same |

The prompt asks the model to echo one synthetic line (e-mail, Taiwan mobile number and national ID, an API-key-shaped string, a home directory). A scenario passes when:

1. the request body the service received contains none of the original values, verbatim or JSON-escaped;
2. the prompt the service received is the client's prompt with each original replaced by a placeholder;
3. the client's reply equals the service's reply with each of those placeholders replaced by the original it stood for. This holds whatever the model chose to say, streamed or not. The harness's proxy restores every category into tool calls (`REDACTION_PROXY_TOOL_RESTORE_CATEGORIES=*`), so the forced tool call checks the restore itself, not the default tool restore policy.

A scenario is `inconclusive` when the model echoed no placeholder of the request, so restoration was not exercised. The run exits non-zero when a scenario fails or errors, or when services ran and no scenario passed; with no key set it exits 0. `pnpm test` runs the same harness against a fake upstream (`tests/real-e2e-harness.spec.ts`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_OPENAI_MODEL` | `gpt-4.1-mini` | Model for OpenAI |
| `E2E_ANTHROPIC_MODEL` | `claude-haiku-5-5` | Model for Anthropic |
| `E2E_DEEPSEEK_MODEL` | `deepseek-flash` | Model for DeepSeek |
| `E2E_OPENAI_UPSTREAM`, `E2E_ANTHROPIC_UPSTREAM`, `E2E_DEEPSEEK_UPSTREAM` | the public API | Service base URL |
| `E2E_CLIENT` | `fetch` | `sdk` sends every request through the official SDKs instead of `fetch`: the `openai` package for Chat Completions and Responses, `@anthropic-ai/sdk` for Messages. Any other value stops the run. |

## With a DeepSeek key only

DeepSeek serves an OpenAI-compatible API at `https://api.deepseek.com` and an Anthropic-compatible one at `https://api.deepseek.com/anthropic` ([docs](https://api-docs.deepseek.com/guides/anthropic_api)), so one DeepSeek key checks both SDKs. The `anthropic` provider is pointed at DeepSeek and given the DeepSeek key; `OPENAI_API_KEY` is emptied so the `openai` provider is skipped:

```sh
export OPENAI_API_KEY= ANTHROPIC_AUTH_TOKEN= ANTHROPIC_API_KEY="$DEEPSEEK_API_KEY" \
  E2E_ANTHROPIC_UPSTREAM=https://api.deepseek.com/anthropic E2E_ANTHROPIC_MODEL=deepseek-flash
E2E_CLIENT=sdk pnpm run e2e:real   # official SDKs
pnpm run e2e:real                  # raw fetch
```

Results are labelled `deepseek` (Chat Completions) and `anthropic` (Messages, served by DeepSeek). This checks the wire formats and the SDK clients, not OpenAI's or Anthropic's own services.

## Pointing real clients at the proxy

Start the proxy with `pnpm build && node lib/cli.js` (port 8787). Claude Code was verified through the proxy on 2026-10-13 and again on 2026-10-14 on the final 0.3.0 build (commit `1a12a30`, where the model wrote a sentence before its tool calls, the Bash command ran once, and placeholder numbers stayed stable across requests): version 2.1.287 with its subscription login against Anthropic Messages (Claude Haiku 5.5), streaming text and the Bash and Read tools; the upstream saw only placeholders for detected values, replies were restored, and tool arguments were restored per `toolRestore` (`PATH`, `TERM`, `PROJECT`) and kept as placeholders for other categories. Codex CLI has not been verified.

**Claude Code** (API key or subscription login; the proxy forwards either credential unchanged):

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

To use DeepSeek's Anthropic-compatible API instead, start the proxy with `REDACTION_PROXY_ANTHROPIC_UPSTREAM=https://api.deepseek.com/anthropic` and run Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY`.

**Codex CLI** (API-key login only). Codex 0.155.1 speaks only the Responses API: `wire_api = "chat"` stops it at startup. A ChatGPT login sends requests to ChatGPT's backend (`/backend-api/codex/responses`), which is not a proxy route, so it cannot go through the proxy. Not verified against OpenAI.

```sh
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 codex
```

or, in `~/.codex/config.toml`:

```toml
model_provider = "redaction-proxy"

[model_providers.redaction-proxy]
name = "OpenAI through redaction-proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

**Codex CLI with DeepSeek.** DeepSeek also serves the Responses API ([docs](https://api-docs.deepseek.com/guides/responses_api/); stateless, so no `previous_response_id`). Start the proxy with `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com` and give Codex its own configuration directory, so your `~/.codex` login stays as it is:

```toml
# ~/.codex-redaction-proxy/config.toml
model = "deepseek-flash"
model_provider = "deepseek-via-proxy"

[model_providers.deepseek-via-proxy]
name = "DeepSeek through redaction-proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

```sh
CODEX_HOME=~/.codex-redaction-proxy codex exec --skip-git-repo-check "..." </dev/null
```

On 2026-10-21, with a dummy key, Codex 0.155.1 sent its requests to the proxy's `/v1/responses`, the proxy masked the e-mail in the prompt and the OS user name, and DeepSeek answered 401 for the key; a run with a real key has not been made yet.
