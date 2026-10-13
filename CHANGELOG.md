# Changelog

## 0.2.1 — 2026-10-13

Documentation only; no code change.

- The README and DETAILS flowcharts are SVG diagrams in four languages instead of Mermaid. They state that detected values leave only as placeholders (default); a value the detector misses is sent as is.
- READMEs give the status as this version.

## 0.2.0 — 2026-10-13

- Config files can be TOML (`.toml`) as well as JSON (`.json`), chosen by extension, with the same keys and validation; a path without an extension (`/dev/stdin`) is read as JSON as before, and any other extension stops startup. A syntax error names the file and, for TOML, the line and column, without quoting the file. `config.example.toml` lists every option with its default. Adds the runtime dependency `smol-toml` (BSD-3-Clause).
- `sendWhenMaskFails` (default `false`; environment `REDACTION_PROXY_SEND_WHEN_MASK_FAILS=1|0`): when on, a request whose masking fails is sent instead of refused with 422, partly masked when the leak scan finds a detected value still in it, unmasked when masking throws. This sends detected values to the provider. The reply carries `x-redaction-proxy-mask-failed: 1`, also when the proxy itself answers with an error after masking failed (such as 502 on an upstream redirect or a refused connection), and one warning line names the fields and categories, or the error code, never the values. An upstream-sent copy of that header is dropped. Other refusals are unchanged.
- Stricter config validation: in a file, `debugMasked` and `allowInsecureUpstream` accept only `true` or `false` (a string such as `"true"` stops startup instead of being read as off), and `redaction`, `toolRestore`, and `nameModel` must be tables (a TOML date, an array, a number, or a string stops startup).
- Config errors quote a key or value only when it is a short name-like word (letters, `_` or `-`, at most 24 characters and two digits, no known token prefix such as `sk-`, `ghp_`, `xox`, `AKIA`, or `eyJ`); anything else, including token-shaped text and a non-loopback `host`, prints as `<key>`, `<value>`, `<host>`, or the type.
- `REDACTION_PROXY_DEBUG_MASKED` and `REDACTION_PROXY_ALLOW_INSECURE_UPSTREAM` now override the file both ways and accept only `1` or `0`; any other value stops startup. Before, `0` could not turn off a file's `true` and other values were read as off.
- A JSON config file may start with a UTF-8 BOM, as a TOML file already could. A file named exactly `.toml` or `.json` is read in that format.

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
