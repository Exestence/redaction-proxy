# Presidio comparison

`pnpm run bench:public` compares the built-in rules with [Microsoft Presidio](https://github.com/microsoft/presidio) on the same dataset when a Python environment exists here; otherwise it reports Presidio as skipped. Everything installs into `bench/presidio/.venv` (ignored by git); nothing is installed globally. Requires [uv](https://docs.astral.sh/uv/).

```sh
pnpm run bench:presidio:setup   # presidio-analyzer, pinned in requirements.txt
```

Then install one spaCy model:

| Model | Size | Command | Result |
| --- | --- | --- | --- |
| `en_core_web_lg` | 400 MB | `uv pip install --python bench/presidio/.venv/bin/python https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl` | Presidio's default configuration |
| `en_core_web_sm` | 13 MB | `uv pip install --python bench/presidio/.venv/bin/python https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl` | Same recognizers, smaller NER model; the report marks the run non-default |

`run_presidio.py` prefers `en_core_web_lg` when both are installed. `python -m spacy download` does not work here, because uv environments have no pip.

Presidio runs twice, at score cutoff 0 (its library default, which keeps every detection) and 0.4; the cutoff is passed as the analyzer's `score_threshold` and named in each row. Only the analyzer runs: its detected ranges are scored, and latency is analysis time. The anonymizer's `replace` operator cannot be reversed, so restore exactness is reported as n/a.

Presidio's default configuration supports English only, so every sample is analyzed with `language="en"`. The headline comparison therefore uses the English prompts; results on Chinese and Japanese prompts are marked "reference only: English analyzer". Pattern recognizers (e-mail, card, IP, phone) still fire there, and person-name detection works on English names only. The report names the installed presidio-analyzer, spaCy, and spaCy model versions.
