# Public redaction benchmark: dev set

**dev set.** Generated from `bench/public/templates.ts`, seed 20261005, 50 prompts per language and format: 1200 synthetic prompts, 3122 sensitive values, 1966 hard negatives. Built-in rules `rules-6`, default configuration. Reproduce with `pnpm run bench:public --seed 20261005 --per-cell 50`.

## English prompts by category (dev)

Each cell: fully masked / partly masked / untouched, as a share of the sensitive values in that row.

| Category | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) |
| --- | --- | --- | --- |
| PERSON | 0.0% / 0.0% / 100.0% | 86.3% / 0.0% / 13.7% | 86.3% / 0.0% / 13.7% |
| EMAIL | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| PHONE | 0.0% / 0.0% / 100.0% | 60.4% / 35.4% / 4.2% | 60.4% / 35.4% / 4.2% |
| NATIONAL_ID | 0.0% / 0.0% / 100.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| CARD | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| SECRET | 100.0% / 0.0% / 0.0% | 8.8% / 14.4% / 76.8% | 8.8% / 6.4% / 84.8% |
| HOME_PATH | 100.0% / 0.0% / 0.0% | 0.0% / 32.0% / 68.0% | 0.0% / 32.0% / 68.0% |
| PRIVATE_IP | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| INTERNAL_HOST | 100.0% / 0.0% / 0.0% | 11.4% / 57.0% / 31.6% | 11.4% / 57.0% / 31.6% |
| **Macro average** (9 categories, equal weight) | 66.7% / 0.0% / 33.3% | 63.0% / 15.4% / 21.6% | 63.0% / 14.5% / 22.5% |

| Identifying core fully masked | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) |
| --- | --- | --- | --- |
| PHONE | 0.0% | 93.8% | 93.8% |
| HOME_PATH | 100.0% | 5.8% | 5.8% |
| INTERNAL_HOST | 100.0% | 68.4% | 68.4% |

## English prompts: precision, restore, latency (dev)

| System | Region precision | Restore exact | Median ms | p95 ms |
| --- | --- | --- | --- | --- |
| redaction-proxy rules | 95.7% | 100.0% | 0.07 | 0.21 |
| Presidio 2.2.364 (en_core_web_sm, cutoff 0) | 55.6% | n/a | 7.73 | 9.88 |
| Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) | 62.7% | n/a | 7.59 | 9.77 |

| Hard negatives masked (lower is better) | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) |
| --- | --- | --- | --- |
| order-number | 0.0% | 100.0% | 63.8% |
| uuid | 0.0% | 36.1% | 16.8% |
| code-identifier | 0.0% | 14.3% | 14.3% |
| version | 0.0% | 57.0% | 20.3% |
| commit-hash | 47.3% | 3.6% | 3.6% |
| epoch-millis | 0.0% | 100.0% | 0.0% |
| sha256 | 0.0% | 14.0% | 14.0% |
| tracking-number | 0.0% | 100.0% | 44.4% |

## All languages by category (dev)

Systems marked "reference only: English analyzer" analyze every prompt as English, so their results outside English are for reference only. Each cell: fully masked / partly masked / untouched, as a share of the sensitive values in that row.

| Category | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- |
| PERSON | 0.0% / 0.0% / 100.0% | 27.4% / 0.0% / 72.6% | 27.4% / 0.0% / 72.6% |
| EMAIL | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| PHONE | 31.6% / 0.0% / 68.4% | 90.2% / 8.8% / 1.0% | 90.2% / 8.8% / 1.0% |
| NATIONAL_ID | 29.0% / 0.5% / 70.5% | 94.2% / 0.0% / 5.8% | 53.6% / 0.0% / 46.4% |
| CARD | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| SECRET | 100.0% / 0.0% / 0.0% | 7.9% / 20.1% / 72.0% | 7.9% / 12.4% / 79.7% |
| HOME_PATH | 100.0% / 0.0% / 0.0% | 0.5% / 29.0% / 70.5% | 0.5% / 29.0% / 70.5% |
| PRIVATE_IP | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| INTERNAL_HOST | 100.0% / 0.0% / 0.0% | 10.3% / 58.1% / 31.6% | 10.3% / 58.1% / 31.6% |
| **Macro average** (9 categories, equal weight) | 73.4% / 0.1% / 26.5% | 58.9% / 12.9% / 28.2% | 54.4% / 12.0% / 33.5% |

| Identifying core fully masked | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- |
| PHONE | 31.6% | 98.4% | 98.4% |
| HOME_PATH | 100.0% | 9.4% | 9.4% |
| INTERNAL_HOST | 100.0% | 68.4% | 68.4% |

| Language | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- |
| en | 74.7% fully masked, 95.7% precision | 58.6% fully masked, 55.6% precision | 58.6% fully masked, 62.7% precision |
| zh-TW | 86.9% fully masked, 97.0% precision | 48.8% fully masked, 57.8% precision (reference only: English analyzer) | 42.1% fully masked, 63.4% precision (reference only: English analyzer) |
| zh-CN | 75.3% fully masked, 96.1% precision | 48.7% fully masked, 52.5% precision (reference only: English analyzer) | 48.7% fully masked, 59.0% precision (reference only: English analyzer) |
| ja | 77.5% fully masked, 95.1% precision | 52.7% fully masked, 55.3% precision (reference only: English analyzer) | 48.7% fully masked, 61.9% precision (reference only: English analyzer) |

<details><summary>All languages: hard negatives masked, and results by format</summary>

| Hard negatives masked (lower is better) | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- |
| order-number | 0.0% | 100.0% | 58.9% |
| uuid | 0.0% | 38.7% | 14.2% |
| code-identifier | 0.0% | 13.4% | 13.4% |
| version | 0.0% | 53.3% | 18.3% |
| commit-hash | 46.2% | 9.0% | 9.0% |
| epoch-millis | 0.0% | 100.0% | 2.5% |
| sha256 | 0.5% | 10.0% | 10.0% |
| tracking-number | 0.0% | 100.0% | 77.2% |

| Format | redaction-proxy rules | Presidio 2.2.364 (en_core_web_sm, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_sm, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- |
| chat | 54.3% fully masked, 100.0% precision | 84.1% fully masked, 64.5% precision | 76.2% fully masked, 71.0% precision |
| code | 83.7% fully masked, 83.1% precision | 40.5% fully masked, 57.1% precision | 40.5% fully masked, 61.6% precision |
| log | 100.0% fully masked, 99.8% precision | 43.5% fully masked, 37.9% precision | 43.5% fully masked, 46.5% precision |
| config | 100.0% fully masked, 100.0% precision | 38.5% fully masked, 82.4% precision | 38.5% fully masked, 93.4% precision |
| email | 42.5% fully masked, 100.0% precision | 73.1% fully masked, 63.8% precision | 65.6% fully masked, 69.3% precision |
| stacktrace | 100.0% fully masked, 100.0% precision | 29.9% fully masked, 36.4% precision | 29.9% fully masked, 39.2% precision |

</details>

## Notes
- Presidio: presidio-analyzer 2.2.364, spaCy 3.8.16, en_core_web_sm 3.8.0, not the default en_core_web_lg; default recognizers; language "en" for every prompt; the cutoff is Presidio's `score_threshold`, below which detections are dropped; latency is analysis only.
- Matching ignores category names. Fully masked: detections cover every character of the value. Partly masked: a detection overlaps the value but leaves part of it in the text. Untouched: no detection overlaps the value. Identifying core: the part of a value that names someone or something (a phone number without its country code, the user name of a home path, the first label of a host name); a system that masks only that part still hides who it is.
- Region precision: a masked region (overlapping detections merged) counts when it overlaps a sensitive value; one detection spanning a whole prompt would score 100%. Restore exact: in the same process, restoring the masked text with the same placeholder registry gives the original byte for byte; no model is involved.
- Latency is per prompt, in process, after start-up (model loading excluded). It compares in-process regular expressions with Python and spaCy named-entity recognition, and the proxy's time includes restoring the masked text while Presidio's is analysis only.
- Edited after results were seen: `session={uuid}` in the log templates was relabelled `request_id={uuid}` after the first run, in which the rules masked every such UUID. A session id is a credential, so the alternative was to keep it and label it SECRET.
- Edited after results were seen: a bare commit hash after a version and an `etag={sha256}` context were added after the first run; they added rules false positives.
