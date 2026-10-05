# Public redaction benchmark

Seed 20261005: 1200 synthetic prompts (4 languages × 6 formats × 50), 3122 sensitive values, 1966 hard negatives. Built-in rules `rules-6`, default configuration. Reproduce with `pnpm run bench:public`.

## Overall

| System | Recall | Precision | Leak rate | Restore exact | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| redaction-proxy rules | 78.6% | 96.0% | 21.4% | 100.0% | 0.05 | 0.11 |
| Presidio 2.2 (en_core_web_sm) | 52.2% | 55.3% | 34.1% | n/a | 4.94 | 7.02 |

## Recall by category (leak rate in parentheses)

| Category | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| PERSON | 0.0% (100.0%) | 27.4% (72.6%) |
| EMAIL | 100.0% (0.0%) | 100.0% (0.0%) |
| PHONE | 31.6% (68.4%) | 90.2% (1.0%) |
| NATIONAL_ID | 29.0% (70.5%) | 94.2% (5.8%) |
| CARD | 100.0% (0.0%) | 100.0% (0.0%) |
| SECRET | 100.0% (0.0%) | 7.9% (72.0%) |
| HOME_PATH | 100.0% (0.0%) | 0.5% (70.5%) |
| PRIVATE_IP | 100.0% (0.0%) | 100.0% (0.0%) |
| INTERNAL_HOST | 100.0% (0.0%) | 10.3% (31.6%) |

## Recall / precision by language

| Language | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| en | 74.7% / 95.7% | 58.6% / 55.6% |
| zh-TW | 86.9% / 97.0% | 48.8% / 57.8% |
| zh-CN | 75.3% / 96.1% | 48.7% / 52.5% |
| ja | 77.5% / 95.1% | 52.7% / 55.3% |

## Hard negatives masked (lower is better)

| Kind | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| commit-hash | 46.2% | 9.0% |
| sha256 | 0.5% | 10.0% |
| uuid | 0.0% | 38.7% |
| version | 0.0% | 53.3% |
| order-number | 0.0% | 100.0% |
| tracking-number | 0.0% | 100.0% |
| epoch-millis | 0.0% | 100.0% |
| code-identifier | 0.0% | 13.4% |

<details><summary>Recall / precision by format</summary>

| Format | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| chat | 54.3% / 100.0% | 84.1% / 64.5% |
| code | 83.7% / 83.1% | 40.5% / 57.1% |
| log | 100.0% / 99.8% | 43.5% / 37.9% |
| config | 100.0% / 100.0% | 38.5% / 82.4% |
| email | 42.5% / 100.0% | 73.1% / 63.8% |
| stacktrace | 100.0% / 100.0% | 29.9% / 36.4% |

</details>

## Notes
- Presidio 2.2 (en_core_web_sm): default recognizers on the small spaCy model, not the default en_core_web_lg; language "en" for every sample.
- Matching ignores category names. Recall: a value counts when detections cover all of it. Leak rate: the exact value is still in the masked text. Precision: a masked region counts when it overlaps a sensitive value. Restore exact: the masked text restores to the original byte for byte.
- Latency is per prompt, in process, after start-up (model loading excluded).
