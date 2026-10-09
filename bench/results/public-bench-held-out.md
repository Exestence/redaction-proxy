# Public redaction benchmark: held-out set

**held-out set.** Frozen file `heldout-v1.jsonl`, SHA-256 `be2ebb9531001f5e1b06dd3353dd6a9e445ef8b1131424da642de38b4fc3e553`: 1518 synthetic prompts, 6453 sensitive values, 2215 hard negatives. Built-in rules `rules-6`; each system names its rule set. Reproduce with `pnpm run bench:public --heldout <path to heldout-v1.jsonl> --name-model <model directory>`.

## English prompts by category (held-out)

Each cell: fully masked / partly masked / untouched, as a share of the sensitive values in that row.

| Category | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) |
| --- | --- | --- | --- | --- | --- |
| PERSON | 0.0% / 0.0% / 100.0% | 0.0% / 0.0% / 100.0% | 70.4% / 2.5% / 27.1% | 63.0% / 3.9% / 33.1% | 63.0% / 3.9% / 33.1% |
| EMAIL | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 55.8% / 10.0% / 34.2% | 55.8% / 10.0% / 34.2% |
| PHONE | 2.7% / 0.0% / 97.3% | 4.7% / 0.0% / 95.3% | 4.7% / 0.0% / 95.3% | 85.3% / 12.0% / 2.7% | 82.0% / 6.0% / 12.0% |
| NATIONAL_ID | 0.0% / 0.0% / 100.0% | 92.6% / 0.0% / 7.4% | 92.6% / 0.0% / 7.4% | 85.2% / 1.9% / 13.0% | 77.8% / 0.0% / 22.2% |
| CARD | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 85.7% / 4.8% / 9.5% | 81.0% / 4.8% / 14.3% |
| IBAN | 0.0% / 24.2% / 75.8% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 97.0% / 3.0% / 0.0% | 97.0% / 3.0% / 0.0% |
| SECRET | 70.4% / 1.4% / 28.2% | 70.4% / 1.4% / 28.2% | 70.4% / 2.3% / 27.2% | 9.9% / 8.9% / 81.2% | 9.9% / 7.0% / 83.1% |
| PATH | 3.6% / 87.4% / 9.0% | 3.6% / 87.4% / 9.0% | 3.6% / 87.4% / 9.0% | 0.0% / 45.0% / 55.0% | 0.0% / 45.0% / 55.0% |
| HOST | 69.5% / 0.0% / 30.5% | 69.5% / 0.0% / 30.5% | 69.5% / 0.0% / 30.5% | 40.1% / 46.5% / 13.5% | 40.1% / 46.1% / 13.8% |
| ADDRESS | 0.0% / 0.0% / 100.0% | 0.0% / 0.0% / 100.0% | 0.0% / 59.5% / 40.5% | 0.0% / 100.0% / 0.0% | 0.0% / 100.0% / 0.0% |
| **Macro average** (10 categories, equal weight) | 34.6% / 11.3% / 54.1% | 54.1% / 8.9% / 37.0% | 61.1% / 15.2% / 23.7% | 52.2% / 23.6% / 24.2% | 50.7% / 22.6% / 26.8% |

| Identifying core fully masked | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) |
| --- | --- | --- | --- | --- | --- |
| EMAIL | 100.0% | 100.0% | 100.0% | 55.8% | 55.8% |
| PHONE | 0.0% | 0.0% | 0.0% | 91.4% | 82.8% |
| PATH | 97.0% | 97.0% | 97.0% | 5.0% | 5.0% |
| HOST | 58.9% | 58.9% | 58.9% | 88.7% | 88.1% |

## English prompts: precision, restore, latency (held-out)

| System | Region precision | Restore exact | Median ms | p95 ms |
| --- | --- | --- | --- | --- |
| rules, core default | 95.2% | 100.0% | 0.06 | 0.13 |
| rules, proxy default | 95.7% | 100.0% | 0.07 | 0.13 |
| rules + name model (experimental) | 92.5% | 100.0% | 7.44 | 21.99 |
| Presidio 2.2.364 (en_core_web_lg, cutoff 0) | 64.7% | n/a | 8.59 | 14.04 |
| Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) | 69.0% | n/a | 8.57 | 13.51 |

| Hard negatives masked (lower is better) | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) |
| --- | --- | --- | --- | --- | --- |
| user_agent | 0.0% | 0.0% | 100.0% | 100.0% | 75.0% |
| version | 0.0% | 0.0% | 2.6% | 37.7% | 20.8% |
| request_id | 11.1% | 11.1% | 11.1% | 8.3% | 0.0% |
| public_certificate | 100.0% | 100.0% | 100.0% | 50.0% | 50.0% |
| uuid | 7.7% | 7.7% | 7.7% | 32.7% | 3.8% |
| placeholder | 19.2% | 19.2% | 19.2% | 26.9% | 26.9% |
| memory_address | 0.0% | 0.0% | 0.0% | 20.0% | 10.0% |
| epoch_timestamp | 0.0% | 0.0% | 0.0% | 100.0% | 69.8% |
| phone_shaped_number | 0.0% | 0.0% | 0.0% | 100.0% | 66.7% |
| order_number | 0.0% | 0.0% | 0.0% | 48.8% | 20.9% |
| tracking_number | 5.0% | 5.0% | 5.0% | 30.0% | 15.0% |
| etag | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| phone_shaped_arithmetic | 0.0% | 0.0% | 0.0% | 50.0% | 50.0% |
| isbn | 0.0% | 0.0% | 0.0% | 61.1% | 16.7% |
| commit_hash | 9.5% | 9.5% | 9.5% | 6.8% | 2.7% |
| resource_id | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| publishable_key | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| code_identifier | 0.0% | 0.0% | 0.0% | 23.1% | 23.1% |
| cloud_account_id | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |
| masked_value | 0.0% | 0.0% | 14.3% | 0.0% | 0.0% |
| key_fingerprint | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| public_host | 15.4% | 15.4% | 15.4% | 100.0% | 100.0% |
| integrity_hash | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| image_digest | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| checksum | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| key_id | 50.0% | 50.0% | 50.0% | 0.0% | 0.0% |
| service_account | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| numeric_id | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ipv4_doc | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |
| ipv6_doc | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |
| common_word | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| queue_id | 0.0% | 0.0% | 0.0% | 11.1% | 11.1% |
| bot_email | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |

## All languages by category (held-out)

Systems marked "reference only: English analyzer" analyze every prompt as English, so their results outside English are for reference only. Each cell: fully masked / partly masked / untouched, as a share of the sensitive values in that row.

| Category | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| PERSON | 0.0% / 0.0% / 100.0% | 0.0% / 0.0% / 100.0% | 65.0% / 3.9% / 31.1% | 22.5% / 1.5% / 75.9% | 22.5% / 1.5% / 75.9% |
| EMAIL | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 53.5% / 12.0% / 34.5% | 53.5% / 12.0% / 34.5% |
| PHONE | 24.9% / 0.0% / 75.1% | 40.6% / 0.0% / 59.4% | 40.6% / 0.0% / 59.4% | 89.7% / 5.1% / 5.1% | 86.3% / 3.3% / 10.4% |
| NATIONAL_ID | 16.1% / 0.4% / 83.5% | 72.2% / 0.0% / 27.8% | 72.2% / 0.0% / 27.8% | 60.0% / 5.7% / 34.3% | 28.7% / 3.9% / 67.4% |
| CARD | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 86.9% / 2.8% / 10.3% | 85.0% / 2.8% / 12.1% |
| IBAN | 0.0% / 14.2% / 85.8% | 100.0% / 0.0% / 0.0% | 100.0% / 0.0% / 0.0% | 99.2% / 0.8% / 0.0% | 99.2% / 0.8% / 0.0% |
| SECRET | 73.1% / 0.7% / 26.2% | 73.1% / 0.7% / 26.2% | 73.1% / 1.1% / 25.8% | 9.7% / 10.0% / 80.2% | 9.7% / 6.1% / 84.2% |
| PATH | 4.1% / 89.1% / 6.8% | 4.1% / 89.1% / 6.8% | 4.1% / 89.1% / 6.8% | 0.2% / 42.1% / 57.7% | 0.2% / 42.1% / 57.7% |
| HOST | 70.1% / 0.0% / 29.9% | 70.1% / 0.0% / 29.9% | 70.1% / 0.0% / 29.9% | 41.3% / 44.4% / 14.3% | 41.3% / 44.2% / 14.6% |
| ADDRESS | 0.0% / 0.0% / 100.0% | 0.0% / 0.0% / 100.0% | 17.7% / 38.4% / 43.9% | 3.3% / 39.0% / 57.7% | 3.3% / 39.0% / 57.7% |
| **Macro average** (10 categories, equal weight) | 38.8% / 10.4% / 50.7% | 56.0% / 9.0% / 35.0% | 64.3% / 13.2% / 22.5% | 46.6% / 16.3% / 37.0% | 43.0% / 15.6% / 41.5% |

| Identifying core fully masked | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| EMAIL | 100.0% | 100.0% | 100.0% | 54.0% | 54.0% |
| PHONE | 24.0% | 52.4% | 52.4% | 95.8% | 92.7% |
| PATH | 98.7% | 98.7% | 98.7% | 4.2% | 4.2% |
| HOST | 58.5% | 58.5% | 58.5% | 86.4% | 86.0% |

| Language | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| ja | 43.4% fully masked, 95.0% precision | 50.8% fully masked, 95.6% precision | 62.8% fully masked, 92.4% precision | 34.0% fully masked, 57.4% precision (reference only: English analyzer) | 33.2% fully masked, 61.2% precision (reference only: English analyzer) |
| en | 41.7% fully masked, 95.2% precision | 47.6% fully masked, 95.7% precision | 61.4% fully masked, 92.5% precision | 45.8% fully masked, 64.7% precision | 45.1% fully masked, 69.0% precision |
| zh-CN | 42.0% fully masked, 94.5% precision | 49.7% fully masked, 95.2% precision | 63.2% fully masked, 92.8% precision | 30.4% fully masked, 54.8% precision (reference only: English analyzer) | 29.6% fully masked, 58.2% precision (reference only: English analyzer) |
| zh-TW | 52.9% fully masked, 95.8% precision | 54.9% fully masked, 96.0% precision | 69.6% fully masked, 91.9% precision | 37.7% fully masked, 57.5% precision (reference only: English analyzer) | 34.2% fully masked, 60.2% precision (reference only: English analyzer) |
| de | 38.9% fully masked, 96.9% precision | 43.8% fully masked, 97.2% precision | 56.6% fully masked, 91.9% precision | 42.3% fully masked, 57.8% precision (reference only: English analyzer) | 40.0% fully masked, 59.5% precision (reference only: English analyzer) |
| fr | 49.6% fully masked, 95.1% precision | 55.8% fully masked, 95.5% precision | 67.8% fully masked, 91.2% precision | 43.1% fully masked, 56.8% precision (reference only: English analyzer) | 41.3% fully masked, 59.6% precision (reference only: English analyzer) |
| ko | 49.0% fully masked, 94.6% precision | 54.1% fully masked, 95.1% precision | 63.9% fully masked, 90.1% precision | 35.3% fully masked, 54.2% precision (reference only: English analyzer) | 32.9% fully masked, 57.8% precision (reference only: English analyzer) |

<details><summary>All languages: hard negatives masked, and results by format</summary>

| Hard negatives masked (lower is better) | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| public_host | 11.7% | 11.7% | 11.7% | 100.0% | 100.0% |
| publishable_key | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| uuid | 7.6% | 7.6% | 7.6% | 34.1% | 7.6% |
| commit_hash | 12.1% | 12.1% | 12.4% | 7.6% | 4.8% |
| version | 0.0% | 0.0% | 1.0% | 33.2% | 19.3% |
| request_id | 13.3% | 13.3% | 13.3% | 10.0% | 6.0% |
| image_digest | 0.0% | 0.0% | 0.0% | 13.6% | 13.6% |
| etag | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| epoch_timestamp | 0.0% | 0.0% | 0.0% | 100.0% | 70.0% |
| phone_shaped_number | 0.0% | 0.0% | 0.0% | 100.0% | 60.9% |
| user_agent | 0.0% | 0.0% | 90.9% | 100.0% | 77.3% |
| integrity_hash | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| order_number | 1.7% | 1.7% | 1.7% | 53.4% | 33.0% |
| key_id | 44.4% | 44.4% | 44.4% | 5.6% | 5.6% |
| resource_id | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| cloud_account_id | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |
| memory_address | 0.0% | 0.0% | 0.0% | 8.6% | 5.2% |
| code_identifier | 0.0% | 0.0% | 0.0% | 27.5% | 27.5% |
| public_certificate | 100.0% | 100.0% | 100.0% | 36.4% | 36.4% |
| masked_value | 0.0% | 0.0% | 12.2% | 0.0% | 0.0% |
| key_fingerprint | 0.0% | 0.0% | 0.0% | 10.5% | 10.5% |
| phone_shaped_arithmetic | 0.0% | 0.0% | 0.0% | 55.0% | 55.0% |
| service_account | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| numeric_id | 0.0% | 0.0% | 0.0% | 50.0% | 50.0% |
| placeholder | 20.5% | 20.5% | 20.5% | 26.9% | 26.9% |
| tracking_number | 2.4% | 2.4% | 2.4% | 30.6% | 15.3% |
| isbn | 0.0% | 0.0% | 1.3% | 73.3% | 40.0% |
| common_word | 0.0% | 0.0% | 13.0% | 4.3% | 4.3% |
| ipv4_doc | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |
| ipv6_doc | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |
| checksum | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bot_email | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% |
| queue_id | 0.0% | 0.0% | 0.0% | 7.1% | 3.6% |

| Format | rules, core default | rules, proxy default | rules + name model (experimental) | Presidio 2.2.364 (en_core_web_lg, cutoff 0) (reference only: English analyzer) | Presidio 2.2.364 (en_core_web_lg, cutoff 0.4) (reference only: English analyzer) |
| --- | --- | --- | --- | --- | --- |
| config | 69.3% fully masked, 90.7% precision | 69.9% fully masked, 90.7% precision | 71.1% fully masked, 90.9% precision | 25.5% fully masked, 68.4% precision | 25.3% fully masked, 71.6% precision |
| chat | 27.5% fully masked, 97.8% precision | 40.7% fully masked, 98.5% precision | 67.9% fully masked, 93.7% precision | 39.3% fully masked, 76.4% precision | 36.1% fully masked, 77.4% precision |
| code | 54.5% fully masked, 94.8% precision | 60.3% fully masked, 95.2% precision | 60.3% fully masked, 94.7% precision | 34.6% fully masked, 61.9% precision | 32.2% fully masked, 63.2% precision |
| email | 29.7% fully masked, 99.1% precision | 38.7% fully masked, 99.3% precision | 76.6% fully masked, 94.7% precision | 41.0% fully masked, 76.7% precision | 39.5% fully masked, 80.1% precision |
| csv | 38.5% fully masked, 99.2% precision | 48.1% fully masked, 99.4% precision | 70.8% fully masked, 92.9% precision | 51.5% fully masked, 67.9% precision | 49.3% fully masked, 75.9% precision |
| sql | 29.0% fully masked, 100.0% precision | 39.6% fully masked, 100.0% precision | 39.6% fully masked, 100.0% precision | 45.3% fully masked, 59.2% precision | 42.4% fully masked, 61.6% precision |
| diff | 47.1% fully masked, 95.5% precision | 49.6% fully masked, 95.7% precision | 65.3% fully masked, 94.4% precision | 37.4% fully masked, 43.3% precision | 35.8% fully masked, 44.0% precision |
| log | 65.8% fully masked, 92.6% precision | 69.9% fully masked, 93.0% precision | 69.9% fully masked, 83.4% precision | 43.0% fully masked, 39.3% precision | 42.5% fully masked, 43.1% precision |
| stacktrace | 35.8% fully masked, 96.8% precision | 37.0% fully masked, 96.9% precision | 40.9% fully masked, 85.8% precision | 19.8% fully masked, 56.6% precision | 19.1% fully masked, 59.7% precision |
| markdown | 37.4% fully masked, 96.9% precision | 42.3% fully masked, 97.2% precision | 72.5% fully masked, 96.4% precision | 36.2% fully masked, 79.6% precision | 34.6% fully masked, 81.3% precision |
| shell | 60.4% fully masked, 91.9% precision | 60.7% fully masked, 91.9% precision | 65.6% fully masked, 92.1% precision | 28.2% fully masked, 49.3% precision | 27.8% fully masked, 56.1% precision |

</details>

## Notes
- rules + name model (experimental): the proxy-default rules plus the nym name model (`rules-6+intl-1+nym-edge-int8-2`, shipped `nameModel` defaults), through the code path the proxy uses for user-written text. Each prompt is one user message; the model reads only its prose lines and skips code, log, config, and data lines by design, so it cannot find names there except by propagation of a value found in prose. Sensitive values inside prose lines, by format: config 4%, chat 99%, code 6%, email 97%, csv 83%, sql 5%, diff 100%, log 34%, stacktrace 35%, markdown 95%, shell 48%. Its latency includes inference.
- Presidio: presidio-analyzer 2.2.364, spaCy 3.8.16, en_core_web_lg 3.8.0, the default model; default recognizers; language "en" for every prompt; the cutoff is Presidio's `score_threshold`, below which detections are dropped; latency is analysis only.
- Matching ignores category names. Fully masked: detections cover every character of the value. Partly masked: a detection overlaps the value but leaves part of it in the text. Untouched: no detection overlaps the value. Identifying core: the part of a value that names someone or something (a phone number without its country code, the user name of a home path, the first label of a host name); a system that masks only that part still hides who it is.
- Region precision: a masked region (overlapping detections merged) counts when it overlaps a sensitive value; one detection spanning a whole prompt would score 100%. Restore exact: in the same process, restoring the masked text with the same placeholder registry gives the original byte for byte; no model is involved.
- Latency is per prompt, in process, after start-up (model loading excluded). It compares in-process regular expressions with Python and spaCy named-entity recognition, and the proxy's time includes restoring the masked text while Presidio's is analysis only.
