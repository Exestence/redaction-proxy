# Security policy

redaction-proxy reduces what reaches a cloud LLM; a way around it is a security bug. Please report one privately, so it can be fixed before it is public.

## How to report

Use GitHub's private reporting: [Report a vulnerability](https://github.com/Exestence/redaction-proxy/security/advisories/new) (the **Security** tab, then **Report a vulnerability**). Only the maintainer sees the report.

Please do not open a public issue, pull request, or discussion for it. Include, if you can:

- the version or commit, and how the proxy was started (config keys that differ from the defaults, with secrets removed);
- the smallest request that shows the problem, using made-up values (`example.test` addresses, invented IDs, fake keys), never real personal data or live secrets;
- what reached the upstream, or what the client received, and what you expected.

This is a one-person project, so replies are best effort. I will confirm receipt, keep you informed, and credit you in the advisory and the changelog unless you prefer otherwise.

## What counts

Report privately:

- a value in a category the proxy detects, written in a form its rules cover, that reaches the upstream unmasked;
- a request forwarded although masking failed, with `sendWhenMaskFails` off;
- a placeholder restored where the docs say it stays a placeholder (inside a URL, or in tool arguments for a category `toolRestore` does not allow), or restored to the wrong value;
- a way past the auth token, the Host check, or the Origin check, or any way to read the proxy's memory of earlier values;
- the API key or token showing up in logs.

Open an ordinary issue instead for limits the README and [docs/DETAILS.md §17](docs/DETAILS.md#17-完整限制清單) already list: images and files sent as they are, forms the rules do not cover (addresses, unusual spellings), names without the name model, and false positives.

## Supported versions

Fixes go into the latest release. Older 0.x releases do not get fixes.
