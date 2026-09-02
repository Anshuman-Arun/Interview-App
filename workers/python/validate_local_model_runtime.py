#!/usr/bin/env python3
"""Weight-free compatibility gate for the pinned desktop model runtime."""

from __future__ import annotations

import inspect
import sys
from importlib.metadata import version

import moonshine_voice
import onnxruntime as ort
from moonshine_voice.moonshine_api import ModelArch
from moonshine_voice.transcriber import Transcriber
from moonshine_voice.tts import TextToSpeech

MIN_PYTHON = (3, 12)
MAX_PYTHON_EXCLUSIVE = (3, 14)
EXPECTED_DISTRIBUTIONS = {
    "moonshine-voice": "0.1.5",
    "onnxruntime": "1.29.0",
    "numpy": "2.5.2",
    "sounddevice": "0.5.6",
    "requests": "2.34.2",
    "tqdm": "4.70.0",
    "filelock": "3.32.5",
    "platformdirs": "4.11.7",
    "google-crc32c": "1.8.0",
    "flatbuffers": "25.12.19",
    "packaging": "26.3",
    "protobuf": "7.36.1",
    "charset-normalizer": "3.5.1",
    "idna": "3.19",
    "urllib3": "2.7.0",
    "certifi": "2026.7.22",
    "cffi": "2.1.1",
    "pycparser": "3.0",
}
if sys.platform == "win32":
    EXPECTED_DISTRIBUTIONS["colorama"] = "0.4.6"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    interpreter = sys.version_info[:2]
    require(
        MIN_PYTHON <= interpreter < MAX_PYTHON_EXCLUSIVE,
        "desktop local model runtime requires CPython 3.12 or 3.13",
    )

    for distribution, expected in EXPECTED_DISTRIBUTIONS.items():
        require(
            version(distribution) == expected,
            f"{distribution} package version mismatch",
        )

    require(
        getattr(moonshine_voice, "__version__", None) == EXPECTED_DISTRIBUTIONS["moonshine-voice"],
        "moonshine_voice runtime version mismatch",
    )
    require(
        getattr(ort, "__version__", None) == EXPECTED_DISTRIBUTIONS["onnxruntime"],
        "onnxruntime runtime version mismatch",
    )
    require(hasattr(ModelArch, "TINY"), "Moonshine ModelArch.TINY is unavailable")

    transcriber_parameters = inspect.signature(Transcriber).parameters
    require("model_path" in transcriber_parameters, "Transcriber model_path API drifted")
    require("model_arch" in transcriber_parameters, "Transcriber model_arch API drifted")
    require(
        hasattr(Transcriber, "transcribe_without_streaming"),
        "Moonshine batch transcription API is unavailable",
    )

    tts = TextToSpeech()
    for method_name in (
        "language",
        "voice",
        "models_from",
        "load",
        "stream",
        "cancel_stream",
        "close",
    ):
        require(
            callable(getattr(tts, method_name, None)),
            f"Moonshine TTS API is missing {method_name}()",
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
