#!/usr/bin/env python3
"""Weight-free compatibility gate for the pinned desktop model runtime."""

from __future__ import annotations

import inspect
from importlib.metadata import version

import moonshine_voice
import onnxruntime as ort
from moonshine_voice.moonshine_api import ModelArch
from moonshine_voice.transcriber import Transcriber
from moonshine_voice.tts import TextToSpeech

EXPECTED_MOONSHINE = "0.1.5"
EXPECTED_ONNXRUNTIME = "1.29.0"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    require(
        version("moonshine-voice") == EXPECTED_MOONSHINE,
        "moonshine-voice package version mismatch",
    )
    require(
        getattr(moonshine_voice, "__version__", None) == EXPECTED_MOONSHINE,
        "moonshine_voice runtime version mismatch",
    )
    require(
        getattr(ort, "__version__", None) == EXPECTED_ONNXRUNTIME,
        "onnxruntime version mismatch",
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
