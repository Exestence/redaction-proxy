# Public redaction benchmark: dev set

**dev set.** Generated from `bench/public/templates.ts`, seed 20261005, 50 prompts per language and format: 1200 synthetic prompts, 3122 sensitive values, 1966 hard negatives. Built-in rules `rules-6`; each system names its rule set. Reproduce with `pnpm run bench:public --seed 20261005 --per-cell 50 --name-model <model directory>`.

## English prompts by category (dev)

Each cell: fully masked / partly masked / untouched, as a share of the sensitive values in that row.

| Category | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) |
| --- | --- | --- | --- | --- | --- |
| PERSON | 0.0% / 0.0% / 100.0% | 0.0% / 0.0% / 100.0% | 74.7% / 0.0% / 25.3% | 98.9% / 0.0% / 1.1% | 98.9% / 0.0% / 1.1% |
| EMAIL | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| PHONE | 0.0% / 0.0% / 100.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 60.4% / 33.3% / 6.3% | 60.4% / 33.3% / 6.3% |
| NATIONAL_ID | 0.0% / 0.0% / 100.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| CARD | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| SECRET | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 4.0% / 17.6% / 78.4% | 4.0% / 4.8% / 91.2% |
| HOME_PATH | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 0.0% / 57.3% / 42.7% | 0.0% / 57.3% / 42.7% |
| PRIVATE_IP | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| INTERNAL_HOST | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 6.3% / 64.6% / 29.1% | 6.3% / 64.6% / 29.1% |
| **Macro average** (9 categories, equal weight) | 66.7% / 0.0% / 33.3% | 88.9% / 0.0% / 11.1% | 97.2% / 0.0% / 2.8% | 63.3% / 19.2% / 17.5% | 63.3% / 17.8% / 18.9% |

| Identifying core fully masked | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) |
| --- | --- | --- | --- | --- | --- |
| PHONE | 0.0% | 100.0% | 100.0% | 93.8% | 93.8% |
| HOME_PATH | 100.0% | 100.0% | 100.0% | 31.1% | 31.1% |
| INTERNAL_HOST | 100.0% | 100.0% | 100.0% | 69.6% | 69.6% |

## English prompts: precision, restore, latency (dev)

| System | Region precision | Restore exact | Median ms | p95 ms |
| --- | --- | --- | --- | --- |
| rules, core default | 95.7% | 100.0% | 0.05 | 0.13 |
| rules, proxy default | 96.3% | 100.0% | 0.05 | 0.09 |
| rules + name model (experimental) | 96.6% | 100.0% | 5.81 | 12.73 |
| Presidio 2.2.364 (en_core_web_lg, cutoff 0) | 62.4% | n/a | 6.05 | 8.42 |
| Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) | 72.1% | n/a | 6.14 | 8.11 |

| Hard negatives masked (lower is better) | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) |
| --- | --- | --- | --- | --- | --- |
| order-number | 0.0% | 0.0% | 0.0% | 100.0% | 58.5% |
| uuid | 0.0% | 0.0% | 0.0% | 24.4% | 4.2% |
| code-identifier | 0.0% | 0.0% | 0.0% | 8.2% | 8.2% |
| version | 0.0% | 0.0% | 0.0% | 53.2% | 16.5% |
| commit-hash | 47.3% | 47.3% | 47.3% | 0.0% | 0.0% |
| epoch-millis | 0.0% | 0.0% | 0.0% | 100.0% | 9.5% |
| sha256 | 0.0% | 0.0% | 0.0% | 12.0% | 12.0% |
| tracking-number | 0.0% | 0.0% | 0.0% | 100.0% | 0.0% |

## All languages by category (dev)

Systems marked "reference only: English analyzer" analyze every prompt as English, so their results outside English are for reference only. Each cell: fully masked / partly masked / untouched, as a share of the sensitive values in that row.

| Category | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| PERSON | 0.0% / 0.0% / 100.0% | 0.0% / 0.0% / 100.0% | 66.2% / 8.7% / 25.1% | 32.8% / 0.0% / 67.2% | 32.8% / 0.0% / 67.2% |
| EMAIL | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| PHONE | 31.6% / 0.0% / 68.4% | 85.5% / 0.0% / 14.5% | 85.5% / 0.0% / 14.5% | 90.2% / 8.3% / 1.6% | 86.5% / 8.3% / 5.2% |
| NATIONAL_ID | 29.0% / 0.5% / 70.5% | 89.9% / 0.0% / 10.1% | 89.9% / 0.0% / 10.1% | 79.7% / 0.0% / 20.3% | 33.3% / 0.0% / 66.7% |
| CARD | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| SECRET | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 3.7% / 23.0% / 73.3% | 3.7% / 8.7% / 87.6% |
| HOME_PATH | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 0.0% / 49.6% / 50.4% | 0.0% / 49.6% / 50.4% |
| PRIVATE_IP | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| INTERNAL_HOST | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 3.1% / 66.3% / 30.6% | 3.1% / 66.3% / 30.6% |
| **Macro average** (9 categories, equal weight) | 73.4% / 0.1% / 26.5% | 86.1% / 0.0% / 13.9% | 93.5% / 1.0% / 5.5% | 56.6% / 16.4% / 27.0% | 51.1% / 14.8% / 34.2% |

| Identifying core fully masked | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| PHONE | 31.6% | 85.5% | 85.5% | 98.4% | 94.8% |
| HOME_PATH | 100.0% | 100.0% | 100.0% | 29.0% | 29.0% |
| INTERNAL_HOST | 100.0% | 100.0% | 100.0% | 68.8% | 68.8% |

| Language | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| en | 74.7% fully masked, 95.7% precision | 87.7% fully masked, 96.3% precision | 96.9% fully masked, 96.6% precision | 58.9% fully masked, 62.4% precision | 58.9% fully masked, 72.1% precision |
| zh-TW | 86.9% fully masked, 97.0% precision | 86.9% fully masked, 97.0% precision | 94.8% fully masked, 97.2% precision | 48.2% fully masked, 61.2% precision (reference only: English analyzer) | 41.2% fully masked, 68.7% precision (reference only: English analyzer) |
| zh-CN | 75.3% fully masked, 96.1% precision | 81.0% fully masked, 96.4% precision | 88.7% fully masked, 96.7% precision | 45.0% fully masked, 56.0% precision (reference only: English analyzer) | 44.1% fully masked, 64.4% precision (reference only: English analyzer) |
| ja | 77.5% fully masked, 95.1% precision | 88.2% fully masked, 95.8% precision | 96.5% fully masked, 96.2% precision | 49.7% fully masked, 60.4% precision (reference only: English analyzer) | 44.4% fully masked, 70.0% precision (reference only: English analyzer) |

<details><summary>All languages: hard negatives masked, and results by format</summary>

| Hard negatives masked (lower is better) | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| order-number | 0.0% | 0.0% | 0.0% | 100.0% | 55.3% |
| uuid | 0.0% | 0.0% | 0.0% | 34.3% | 9.8% |
| code-identifier | 0.0% | 0.0% | 0.0% | 5.6% | 5.6% |
| version | 0.0% | 0.0% | 0.0% | 52.6% | 15.9% |
| commit-hash | 46.2% | 46.2% | 46.2% | 2.3% | 2.3% |
| epoch-millis | 0.0% | 0.0% | 0.0% | 100.0% | 6.2% |
| sha256 | 0.5% | 0.0% | 0.0% | 8.5% | 8.5% |
| tracking-number | 0.0% | 0.0% | 0.0% | 100.0% | 15.8% |

| Format | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| chat | 54.3% fully masked, 100.0% precision | 76.2% fully masked, 100.0% precision | 94.3% fully masked, 100.0% precision | 80.7% fully masked, 66.5% precision | 69.5% fully masked, 75.7% precision |
| code | 83.7% fully masked, 83.1% precision | 83.7% fully masked, 83.1% precision | 83.7% fully masked, 83.1% precision | 38.5% fully masked, 62.6% precision | 38.5% fully masked, 67.9% precision |
| log | 100.0% fully masked, 99.8% precision | 100.0% fully masked, 100.0% precision | 100.0% fully masked, 100.0% precision | 41.3% fully masked, 41.9% precision | 41.3% fully masked, 52.8% precision |
| config | 100.0% fully masked, 100.0% precision | 100.0% fully masked, 100.0% precision | 100.0% fully masked, 100.0% precision | 36.0% fully masked, 84.2% precision | 36.0% fully masked, 95.0% precision |
| email | 42.5% fully masked, 100.0% precision | 62.8% fully masked, 100.0% precision | 90.9% fully masked, 100.0% precision | 74.1% fully masked, 61.8% precision | 66.1% fully masked, 73.4% precision |
| stacktrace | 100.0% fully masked, 100.0% precision | 100.0% fully masked, 100.0% precision | 100.0% fully masked, 100.0% precision | 27.8% fully masked, 50.7% precision | 27.8% fully masked, 57.9% precision |

</details>

## Notes
- rules + name model (experimental): the proxy-default rules plus the nym name model (`rules-6+intl-2+ext-1+nym-edge-int8-2`, shipped `nameModel` defaults), through the code path the proxy uses for user-written text. Each prompt is one user message; the model reads only its prose lines and skips code, log, config, and data lines by design, so it cannot find names there except by propagation of a value found in prose. Sensitive values inside prose lines, by format: chat 100%, code 0%, log 60%, config 0%, email 100%, stacktrace 0%. Its latency includes inference.
- Presidio: presidio-analyzer 2.2.364, spaCy 3.8.16, en_core_web_lg 3.8.0, the default model; default recognizers; language "en" for every prompt; the cutoff is Presidio's `score_threshold`, below which detections are dropped; latency is analysis only.
- Matching ignores category names. Fully masked: detections cover every character of the value. Partly masked: a detection overlaps the value but leaves part of it in the text. Untouched: no detection overlaps the value. Identifying core: the part of a value that names someone or something (a phone number without its country code, the user name of a home path, the first label of a host name); a system that masks only that part still hides who it is.
- Region precision: a masked region (overlapping detections merged) counts when it overlaps a sensitive value; one detection spanning a whole prompt would score 100%. Restore exact: in the same process, restoring the masked text with the same placeholder registry gives the original byte for byte; no model is involved.
- Latency is per prompt, in process, after start-up (model loading excluded). It compares in-process regular expressions with Python and spaCy named-entity recognition, and the proxy's time includes restoring the masked text while Presidio's is analysis only.
- Edited after results were seen: `session={uuid}` in the log templates was relabelled `request_id={uuid}` after the first run, in which the rules masked every such UUID. A session id is a credential, so the alternative was to keep it and label it SECRET.
- Edited after results were seen: a bare commit hash after a version and an `etag={sha256}` context were added after the first run; they added rules false positives.
