# Real-service harness

Drives the proxy against real OpenAI, Anthropic, and DeepSeek APIs with synthetic data. It is not part of `pnpm test` and costs a few cents of API usage per run.

```sh
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... DEEPSEEK_API_KEY=... pnpm run e2e:real
```

A provider whose key is not set is skipped. Keys are read from the environment only and are never printed; an upstream error that quotes the key is shown with the key replaced.

Last real run: on 2026-10-08, with only `DEEPSEEK_API_KEY` set, DeepSeek Chat Completions passed 4 of 4 scenarios; OpenAI and Anthropic were skipped (no keys).

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
| `E2E_ANTHROPIC_MODEL` | `claude-haiku-4-5` | Model for Anthropic |
| `E2E_DEEPSEEK_MODEL` | `deepseek-chat` | Model for DeepSeek |
| `E2E_OPENAI_UPSTREAM`, `E2E_ANTHROPIC_UPSTREAM`, `E2E_DEEPSEEK_UPSTREAM` | the public API | Service base URL |

## Pointing real clients at the proxy

Start the proxy with `pnpm build && node lib/cli.js` (port 8787). Claude Code was verified through the proxy on 2026-10-13 and again on 2026-10-14 on the final 0.3.0 build (commit `25881e0`, where the model wrote a sentence before its tool calls, the Bash command ran once, and placeholder numbers stayed stable across requests): version 2.1.287 with its subscription login against Anthropic Messages (Claude Haiku 5.5), streaming text and the Bash and Read tools; the upstream saw only placeholders for detected values, replies were restored, and tool arguments were restored per `toolRestore` (`PATH`, `TERM`, `PROJECT`) and kept as placeholders for other categories. Codex CLI has not been verified. This harness has not been run against Anthropic.

**Claude Code** (API key or subscription login; the proxy forwards either credential unchanged):

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

To use DeepSeek's Anthropic-compatible API instead, start the proxy with `REDACTION_PROXY_ANTHROPIC_UPSTREAM=https://api.deepseek.com/anthropic` and run Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY`.

**Codex CLI** (API-key login only; a ChatGPT login sends requests to ChatGPT's backend, which no base URL changes):

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
