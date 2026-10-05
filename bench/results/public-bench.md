# Public redaction benchmark

Seed 20261005: 120 synthetic prompts (4 languages × 6 formats × 5), 300 sensitive values, 182 hard negatives. Built-in rules `rules-6`, default configuration. Reproduce with `pnpm run bench:public`.

## Overall

| System | Recall | Precision | Leak rate | Restore exact | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| redaction-proxy rules | 78.3% | 94.8% | 21.7% | 100.0% | 0.08 | 0.28 |
| Presidio 2.2 (en_core_web_sm) | 46.0% | 51.4% | 39.0% | n/a | 5.29 | 7.11 |

## Recall by category (leak rate in parentheses)

| Category | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| PERSON | 0.0% (100.0%) | 18.9% (81.1%) |
| EMAIL | 100.0% (0.0%) | 58.6% (31.0%) |
| PHONE | 38.5% (61.5%) | 92.3% (0.0%) |
| NATIONAL_ID | 25.9% (74.1%) | 100.0% (0.0%) |
| CARD | 100.0% (0.0%) | 100.0% (0.0%) |
| SECRET | 100.0% (0.0%) | 6.4% (72.3%) |
| HOME_PATH | 100.0% (0.0%) | 0.0% (73.7%) |
| PRIVATE_IP | 100.0% (0.0%) | 100.0% (0.0%) |
| INTERNAL_HOST | 100.0% (0.0%) | 10.7% (25.0%) |

## Recall / precision by language

| Language | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| en | 74.7% / 94.9% | 54.7% / 52.0% |
| zh-TW | 88.3% / 94.4% | 44.2% / 53.5% |
| zh-CN | 77.3% / 93.5% | 45.3% / 43.9% |
| ja | 72.6% / 96.4% | 39.7% / 56.0% |

## Hard negatives masked (lower is better)

| Kind | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| commit-hash | 0.0% | 14.3% |
| sha256 | 0.0% | 0.0% |
| uuid | 23.2% | 19.6% |
| version | 0.0% | 55.6% |
| order-number | 0.0% | 100.0% |
| tracking-number | 0.0% | 100.0% |
| epoch-millis | 0.0% | 100.0% |
| code-identifier | 0.0% | 10.5% |

<details><summary>Recall / precision by format</summary>

| Format | redaction-proxy rules | Presidio 2.2 (en_core_web_sm) |
| --- | --- | --- |
| chat | 58.7% / 100.0% | 80.4% / 59.6% |
| code | 81.7% / 100.0% | 23.3% / 59.6% |
| log | 100.0% / 75.5% | 62.5% / 32.0% |
| config | 100.0% / 100.0% | 25.0% / 81.1% |
| email | 35.2% / 100.0% | 66.7% / 58.7% |
| stacktrace | 100.0% / 100.0% | 27.5% / 38.8% |

</details>

## Notes
- Presidio 2.2 (en_core_web_sm): default recognizers on the small spaCy model, not the default en_core_web_lg; language "en" for every sample.
- Matching ignores category names. Recall: a value counts when detections cover all of it. Leak rate: the exact value is still in the masked text. Precision: a masked region counts when it overlaps a sensitive value. Restore exact: the masked text restores to the original byte for byte.
- Latency is per prompt, in process, after start-up (model loading excluded).
