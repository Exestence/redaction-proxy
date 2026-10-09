# Changelog

## 0.1.0 — 2026-10-09

First release.

- Local proxy for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages clients: detected private values become placeholders (`⟦EMAIL_1⟧`) before the request leaves the machine and are restored in the reply, streaming included.
- Detector `rules-12`: core rules (email, home paths, credentials, Taiwan IDs and phones, cards, private IPs and hosts, high-entropy strings), international and extended rules on by default in the proxy, configured `terms` and `projectNames`. Optional experimental name model.
- Fail-closed within a request: a detected value still present after masking gets the request refused (422).
- Placeholders inside URLs stay unrestored in replies and tool arguments; tool arguments restore only the categories allowed by `toolRestore` (default `PATH`, `TERM`, `PROJECT`).
- Per-client memory of detected values masks them in later requests for 24 hours (`knownOriginalsTtlSeconds`); it never refuses a request.
- Loopback-only by default; an auth token is required off loopback. Upstream redirects are refused.
- Public benchmark on synthetic multilingual data with frozen held-out sets, compared with Presidio.
- Reviewed in ten adversarial rounds before release; see "Protection scope" and "What it does not protect" in the README for the limits.
