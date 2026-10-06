"""Run Microsoft Presidio's analyzer over the public benchmark dataset.

Usage: run_presidio.py <dataset.jsonl> <output.jsonl> <score cutoff>

Analyzes every sample with Presidio's default recognizers, dropping
detections scored below the cutoff, and writes one JSONL line per sample with
the detected ranges as UTF-16 offsets, so the TypeScript side scores them
exactly like its own spans. The first output line describes the run.

Presidio's default configuration loads the spaCy model en_core_web_lg. When
only en_core_web_sm is installed, the same recognizers run on the small model
and the run is marked non-default.
"""

import json
import sys
import time
from importlib.metadata import version

import spacy
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

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
    print(f"no spaCy model: install {DEFAULT_MODEL} or {SMALL_MODEL}", file=sys.stderr)
    sys.exit(MISSING_MODEL_EXIT_CODE)


def utf16_offset(text: str, index: int) -> int:
    """Convert a code-point index into the UTF-16 offset JavaScript uses."""
    return len(text[:index].encode("utf-16-le")) // 2


def analyze_sample(analyzer: AnalyzerEngine, sample: dict, cutoff: float) -> dict:
    """Analyze one sample and time the analysis."""
    text = sample["text"]
    started = time.perf_counter()
    results = analyzer.analyze(text=text, language=LANGUAGE, score_threshold=cutoff)
    elapsed = (time.perf_counter() - started) * MILLISECONDS_PER_SECOND
    detected = [{"start": utf16_offset(text, r.start), "end": utf16_offset(text, r.end)} for r in results]
    return {"id": sample["id"], "detected": detected, "milliseconds": elapsed}


def main(dataset_path: str, output_path: str, cutoff: float) -> None:
    analyzer, model = create_analyzer()
    with open(dataset_path, encoding="utf-8") as dataset, open(output_path, "w", encoding="utf-8") as output:
        header = {
            "presidioVersion": version("presidio-analyzer"),
            "spacyVersion": spacy.__version__,
            "model": model,
            "modelVersion": version(model),
            "defaultConfig": model == DEFAULT_MODEL,
        }
        output.write(json.dumps(header) + "\n")
        for line in dataset:
            output.write(json.dumps(analyze_sample(analyzer, json.loads(line), cutoff)) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]))
