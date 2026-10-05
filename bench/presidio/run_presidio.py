"""Run Microsoft Presidio over the public benchmark dataset.

Reads the dataset JSONL that `pnpm run bench:public` writes, analyzes and
anonymizes every sample with Presidio's default recognizers, and writes one
JSONL line per sample with the detected ranges as UTF-16 offsets, so the
TypeScript side scores them exactly like its own spans. The first output line
describes the run.

Presidio's default configuration loads the spaCy model en_core_web_lg. When
only en_core_web_sm is installed, the same recognizers run on the small model
and the run is marked non-default.
"""

import json
import sys
import time

import spacy
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine

DEFAULT_MODEL = "en_core_web_lg"
SMALL_MODEL = "en_core_web_sm"
# Presidio's default configuration supports English only; zh and ja text is analyzed as English.
LANGUAGE = "en"
MISSING_MODEL_EXIT_CODE = 3
MILLISECONDS_PER_SECOND = 1000


def create_analyzer() -> tuple[AnalyzerEngine, str]:
    """Return Presidio's default analyzer, or the same analyzer on the small spaCy model."""
    if spacy.util.is_package(DEFAULT_MODEL):
        return AnalyzerEngine(), DEFAULT_MODEL
    if spacy.util.is_package(SMALL_MODEL):
        configuration = {"nlp_engine_name": "spacy", "models": [{"lang_code": LANGUAGE, "model_name": SMALL_MODEL}]}
        engine = NlpEngineProvider(nlp_configuration=configuration).create_engine()
        return AnalyzerEngine(nlp_engine=engine), SMALL_MODEL
    print(f"no spaCy model: install {DEFAULT_MODEL} (see bench/presidio/README.md)", file=sys.stderr)
    sys.exit(MISSING_MODEL_EXIT_CODE)


def utf16_offset(text: str, index: int) -> int:
    """Convert a code-point index into the UTF-16 offset JavaScript uses."""
    return len(text[:index].encode("utf-16-le")) // 2


def process_sample(analyzer: AnalyzerEngine, anonymizer: AnonymizerEngine, sample: dict) -> dict:
    """Analyze and anonymize one sample, timing both steps together."""
    text = sample["text"]
    started = time.perf_counter()
    results = analyzer.analyze(text=text, language=LANGUAGE)
    masked = anonymizer.anonymize(text=text, analyzer_results=results).text
    elapsed = (time.perf_counter() - started) * MILLISECONDS_PER_SECOND
    detected = [{"start": utf16_offset(text, r.start), "end": utf16_offset(text, r.end)} for r in results]
    return {"id": sample["id"], "detected": detected, "masked": masked, "milliseconds": elapsed}


def main(dataset_path: str, output_path: str) -> None:
    analyzer, model = create_analyzer()
    anonymizer = AnonymizerEngine()
    with open(dataset_path, encoding="utf-8") as dataset, open(output_path, "w", encoding="utf-8") as output:
        output.write(json.dumps({"model": model, "defaultConfig": model == DEFAULT_MODEL}) + "\n")
        for line in dataset:
            outcome = process_sample(analyzer, anonymizer, json.loads(line))
            output.write(json.dumps(outcome, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
