# Presidio comparison

`pnpm run bench:public` compares the built-in rules with [Microsoft Presidio](https://github.com/microsoft/presidio) on the same dataset when a Python environment exists here; otherwise it reports Presidio as skipped. Everything installs into `bench/presidio/.venv` (ignored by git); nothing is installed globally. Requires [uv](https://docs.astral.sh/uv/).

```sh
pnpm run bench:presidio:setup   # presidio-analyzer + presidio-anonymizer, pinned in requirements.txt (about 150 MB)
```

Then install one spaCy model:

| Model | Size | Command | Result |
| --- | --- | --- | --- |
| `en_core_web_lg` | 400 MB | `uv pip install --python bench/presidio/.venv/bin/python https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl` | Presidio's default configuration |
| `en_core_web_sm` | 13 MB | `uv pip install --python bench/presidio/.venv/bin/python https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl` | Same recognizers, smaller NER model; the report marks the run non-default |

`run_presidio.py` prefers `en_core_web_lg` when both are installed. `python -m spacy download` does not work here, because uv environments have no pip.

Presidio's default configuration supports English only, so every sample is analyzed with `language="en"`: pattern recognizers (e-mail, card, IP, phone) still fire on Chinese and Japanese text, and person-name detection works on English names only. The anonymizer's default `replace` operator cannot be reversed, so restore exactness is reported as n/a.
