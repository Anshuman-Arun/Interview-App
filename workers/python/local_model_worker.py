#!/usr/bin/env python3
"""Production local speech/TTS worker for Interview App.

The desktop process owns lifecycle and model paths. This worker only binds to
loopback, requires a per-process bearer token, emits one bounded readiness
handshake, and never downloads model assets itself.
"""

from __future__ import annotations

import argparse
import base64
import hmac
import hashlib
import json
import math
import os
import platform
import stat
import sys
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path
from typing import Any

WORKER_COMPONENT_VERSION = "2"
WORKER_PROTOCOL_VERSION = 2
MOONSHINE_VERSION = "0.1.5"
ONNXRUNTIME_VERSION = "1.29.0"
PYTHON_DEPENDENCY_LOCK_VERSION = "1"
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
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_TRANSCRIPT_CHARS = 20_000
MAX_WORDS = 1_000
MAX_TTS_TEXT_CHARS = 4_000
MAX_TTS_SECONDS = 60
MAX_TTS_CANCELLATION_TOMBSTONES = 256
MAX_VAD_STREAMS = 64
MAX_VAD_EVICTED_STREAM_TOMBSTONES = 4_096
MAX_SPEECH_NATIVE_RESERVATIONS = 4
MAX_HTTP_CONNECTIONS = 16
HTTP_SOCKET_TIMEOUT_SECONDS = 5.0
SILERO_WINDOW_16K = 512
SILERO_CONTEXT_16K = 64

SPEECH_MODEL_IDENTITY = (
    "moonshine-tiny-en@35d84fc0eb2d7451da9973c990e8a77066abb105+"
    "silero-v6.2.1@7e30209a3e901f9842f81b225f3e93d8199902b1"
)
TTS_MODEL_IDENTITY = "kokoro-af-heart+35d84fc0eb2d7451da9973c990e8a77066abb105"

SPEECH_ASSET_SPECS = {
    "decoder_model_merged.ort": (
        30_412_256,
        "cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0",
    ),
    "encoder_model.ort": (
        13_281_600,
        "94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221",
    ),
    "tokenizer.bin": (
        249_974,
        "6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d",
    ),
}
SILERO_ASSET_SPEC = (
    2_327_524,
    "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
)
TTS_ASSET_SPECS = {
    "en_us/dict_filtered_heteronyms.tsv": (
        2_900_453,
        "8fb0fa0e3ce1a74b864f03c06ace015257660fa2116c6157d11061f4e35bb6b7",
    ),
    "en_us/g2p-config.json": (
        60,
        "f10e652b28c49edd90a94ceb139b94d2368de5814650d81289fcb985fe1ca0f5",
    ),
    "en_us/oov/model.ort": (
        22_143_488,
        "ef8d07a0577a07617fabf5282d80d680e4e17ad07a763e7e3748417f94554d94",
    ),
    "en_us/oov/onnx-config.json": (
        4_641,
        "60a7cf2592ae66702f56e4368a8614e72235eef89205de96f4cf6bace96c5692",
    ),
    "kokoro/config.json": (
        2_351,
        "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
    ),
    "kokoro/model.ort": (
        92_586_320,
        "ffe5ac61b1035e787d37451457d52052ce34ef4fe9e014ceed1aad55a6d915da",
    ),
    "kokoro/voices/af_heart.kokorovoice": (
        522_252,
        "908e14de5b4709da55562129164e618f5d135fcc34dac419e0c3de5189b72d2c",
    ),
}


class ProtocolError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def _is_linklike(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction(path)) if callable(is_junction) else False


def require_file(path: str, label: str) -> Path:
    original = Path(path)
    if _is_linklike(original):
        raise RuntimeError(f"{label} may not be a symlink or junction")
    candidate = original.resolve(strict=True)
    if not candidate.is_file() or _is_linklike(candidate):
        raise RuntimeError(f"{label} is not a regular file")
    return candidate


def require_directory(path: str, label: str) -> Path:
    original = Path(path)
    if _is_linklike(original):
        raise RuntimeError(f"{label} may not be a symlink or junction")
    candidate = original.resolve(strict=True)
    if not candidate.is_dir() or _is_linklike(candidate):
        raise RuntimeError(f"{label} is not a regular directory")
    return candidate


def verify_asset_file(
    candidate: Path,
    *,
    expected_size: int,
    expected_sha256: str,
    label: str,
) -> Path:
    if _is_linklike(candidate):
        raise RuntimeError(f"{label} may not be a symlink or junction")
    before = os.lstat(candidate)
    if not stat.S_ISREG(before.st_mode) or before.st_size != expected_size:
        raise RuntimeError(f"{label} has an unexpected file identity or size")

    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(candidate, flags)
    digest = hashlib.sha256()
    total = 0
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != expected_size:
            raise RuntimeError(f"{label} changed before verification")
        if (
            getattr(before, "st_dev", None) != getattr(opened, "st_dev", None)
            or getattr(before, "st_ino", None) != getattr(opened, "st_ino", None)
        ):
            raise RuntimeError(f"{label} changed before verification")
        while True:
            chunk = os.read(fd, min(1024 * 1024, expected_size - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > expected_size:
                raise RuntimeError(f"{label} exceeds its expected size")
            digest.update(chunk)
    finally:
        os.close(fd)

    after = os.lstat(candidate)
    if (
        total != expected_size
        or digest.hexdigest() != expected_sha256
        or getattr(before, "st_dev", None) != getattr(after, "st_dev", None)
        or getattr(before, "st_ino", None) != getattr(after, "st_ino", None)
        or before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
    ):
        raise RuntimeError(f"{label} failed immutable digest verification")
    return candidate.resolve(strict=True)


def verify_asset_tree(
    root: Path,
    specs: dict[str, tuple[int, str]],
    label: str,
) -> None:
    for relative, (expected_size, expected_sha256) in specs.items():
        parts = Path(relative).parts
        if (
            Path(relative).is_absolute()
            or not parts
            or any(part in ("", ".", "..") for part in parts)
        ):
            raise RuntimeError(f"{label} contains an invalid relative asset path")
        parent = root
        for part in parts[:-1]:
            parent = parent / part
            if _is_linklike(parent):
                raise RuntimeError(f"{label} contains a symlink or junction")
            metadata = os.lstat(parent)
            if not stat.S_ISDIR(metadata.st_mode):
                raise RuntimeError(f"{label} contains a non-directory parent")
        verify_asset_file(
            root.joinpath(*parts),
            expected_size=expected_size,
            expected_sha256=expected_sha256,
            label=f"{label} asset {relative}",
        )


def require_runtime_environment() -> None:
    interpreter = sys.version_info[:2]
    if platform.python_implementation() != "CPython":
        raise RuntimeError("desktop local model runtime requires CPython")
    if not (MIN_PYTHON <= interpreter < MAX_PYTHON_EXCLUSIVE):
        raise RuntimeError("desktop local model runtime requires CPython 3.12 or 3.13")
    for distribution, expected in EXPECTED_DISTRIBUTIONS.items():
        if version(distribution) != expected:
            raise RuntimeError(f"{distribution} package version mismatch")


def require_worker_token() -> str:
    token = os.environ.get("INTERVIEW_LOCAL_WORKER_TOKEN", "")
    if len(token) != 64 or any(ch not in "0123456789abcdef" for ch in token):
        raise RuntimeError("worker authentication token is missing or invalid")
    return token


def decode_pcm(value: Any, *, max_bytes: int = 12 * 1024 * 1024) -> bytes:
    if not isinstance(value, str) or len(value) > ((max_bytes + 2) // 3) * 4 + 8:
        raise ProtocolError(400, "INVALID_PCM")
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ProtocolError(400, "INVALID_PCM") from exc
    if not raw or len(raw) > max_bytes or len(raw) % 4 != 0:
        raise ProtocolError(400, "INVALID_PCM")
    return raw


def finite_float(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProtocolError(400, label)
    result = float(value)
    if not math.isfinite(result):
        raise ProtocolError(400, label)
    return result


class SileroState:
    def __init__(self, np_module: Any) -> None:
        self.state = np_module.zeros((2, 1, 128), dtype=np_module.float32)
        self.context = np_module.zeros((1, SILERO_CONTEXT_16K), dtype=np_module.float32)
        self.pending = np_module.empty((0,), dtype=np_module.float32)
        self.pending_48k = np_module.empty((0,), dtype=np_module.float32)
        self.input_sample_rate: int | None = None
        self.last_probability = 0.0


class SpeechRuntime:
    def __init__(self, *, silero_model: Path, moonshine_model_root: Path) -> None:
        import numpy as np
        import onnxruntime as ort
        import moonshine_voice
        from moonshine_voice.moonshine_api import ModelArch
        from moonshine_voice.transcriber import Transcriber

        if getattr(moonshine_voice, "__version__", None) != MOONSHINE_VERSION:
            raise RuntimeError("moonshine-voice version mismatch")
        if getattr(ort, "__version__", None) != ONNXRUNTIME_VERSION:
            raise RuntimeError("onnxruntime version mismatch")

        available_providers = ort.get_available_providers()
        if "CPUExecutionProvider" not in available_providers:
            raise RuntimeError("onnxruntime CPUExecutionProvider is unavailable")
        providers = ["CPUExecutionProvider"]
        session_options = ort.SessionOptions()
        session_options.inter_op_num_threads = 1
        session_options.intra_op_num_threads = 1
        self._silero = ort.InferenceSession(
            str(silero_model), providers=providers, sess_options=session_options
        )
        self._transcriber = Transcriber(str(moonshine_model_root), model_arch=ModelArch.TINY)
        self._np = np
        self._states: OrderedDict[str, SileroState] = OrderedDict()
        self._evicted_streams: OrderedDict[str, None] = OrderedDict()
        self._vad_lock = threading.Lock()
        self._vad_slots = threading.BoundedSemaphore(MAX_SPEECH_NATIVE_RESERVATIONS)
        self._stt_lock = threading.Lock()
        self._stt_slots = threading.BoundedSemaphore(MAX_SPEECH_NATIVE_RESERVATIONS)
        self.runtime_version = (
            f"moonshine-voice/{MOONSHINE_VERSION};"
            f"onnxruntime/{ONNXRUNTIME_VERSION};deps/{PYTHON_DEPENDENCY_LOCK_VERSION}"
        )

    def close(self) -> None:
        close = getattr(self._transcriber, "close", None)
        if callable(close):
            close()

    def score_vad(self, body: dict[str, Any]) -> dict[str, Any]:
        stream_id = body.get("streamId")
        sample_rate = body.get("sampleRate")
        if not isinstance(stream_id, str) or not (1 <= len(stream_id) <= 128):
            raise ProtocolError(400, "INVALID_STREAM")
        if sample_rate not in (16_000, 48_000):
            raise ProtocolError(400, "INVALID_SAMPLE_RATE")
        raw = decode_pcm(body.get("pcmF32Base64"), max_bytes=48_000 * 4 // 10 + 4)
        samples = self._np.frombuffer(raw, dtype="<f4").astype(self._np.float32, copy=True)
        if not self._np.isfinite(samples).all():
            raise ProtocolError(400, "INVALID_PCM")
        if not self._vad_slots.acquire(blocking=False):
            raise ProtocolError(429, "VAD_BUSY")
        try:
            with self._vad_lock:
                state = self._states.pop(stream_id, None)
                if state is None:
                    if stream_id in self._evicted_streams:
                        raise ProtocolError(409, "VAD_STREAM_STATE_EVICTED")
                    state = SileroState(self._np)
                if state.input_sample_rate is None:
                    state.input_sample_rate = int(sample_rate)
                elif state.input_sample_rate != int(sample_rate):
                    raise ProtocolError(400, "STREAM_SAMPLE_RATE_CHANGED")
                self._states[stream_id] = state
                while len(self._states) > MAX_VAD_STREAMS:
                    evicted_stream_id, _ = self._states.popitem(last=False)
                    self._evicted_streams.pop(evicted_stream_id, None)
                    self._evicted_streams[evicted_stream_id] = None
                while len(self._evicted_streams) > MAX_VAD_EVICTED_STREAM_TOMBSTONES:
                    self._evicted_streams.popitem(last=False)

                if sample_rate == 48_000:
                    source = self._np.concatenate((state.pending_48k, samples))
                    usable = (source.size // 3) * 3
                    if usable > 0:
                        # Match Silero v6.2.1's official 48 kHz preprocessing
                        # (x[:, ::3]) while preserving decimation phase across
                        # arbitrary HTTP frame boundaries.
                        samples = source[:usable:3].astype(
                            self._np.float32, copy=False
                        )
                    else:
                        samples = self._np.empty((0,), dtype=self._np.float32)
                    state.pending_48k = source[usable:].copy()

                state.pending = self._np.concatenate((state.pending, samples))
                while state.pending.size >= SILERO_WINDOW_16K:
                    window = state.pending[:SILERO_WINDOW_16K]
                    state.pending = state.pending[SILERO_WINDOW_16K:]
                    model_input = self._np.concatenate((state.context, window.reshape(1, -1)), axis=1)
                    output, recurrent = self._silero.run(
                        None,
                        {
                            "input": model_input,
                            "state": state.state,
                            "sr": self._np.array(16_000, dtype="int64"),
                        },
                    )
                    state.state = recurrent
                    state.context = model_input[:, -SILERO_CONTEXT_16K:]
                    probability = float(self._np.asarray(output).reshape(-1)[-1])
                    if not math.isfinite(probability):
                        raise RuntimeError("Silero returned non-finite probability")
                    state.last_probability = min(1.0, max(0.0, probability))
                return {"speechProbability": state.last_probability}
        finally:
            self._vad_slots.release()

    def transcribe(self, body: dict[str, Any]) -> dict[str, Any]:
        request_id = body.get("requestId")
        utterance_id = body.get("utteranceId")
        sample_rate = body.get("sampleRate")
        if not isinstance(request_id, str) or not (1 <= len(request_id) <= 128):
            raise ProtocolError(400, "INVALID_REQUEST_ID")
        if not isinstance(utterance_id, str) or not (1 <= len(utterance_id) <= 128):
            raise ProtocolError(400, "INVALID_UTTERANCE_ID")
        if sample_rate not in (16_000, 48_000):
            raise ProtocolError(400, "INVALID_SAMPLE_RATE")
        raw = decode_pcm(body.get("pcmF32Base64"))
        samples = self._np.frombuffer(raw, dtype="<f4").astype(self._np.float32, copy=True)
        if not self._np.isfinite(samples).all():
            raise ProtocolError(400, "INVALID_PCM")
        if samples.size / int(sample_rate) > 60.001:
            raise ProtocolError(413, "AUDIO_TOO_LONG")

        # The application may admit multiple authoritative speech streams.
        # Bound the number of HTTP handlers allowed to wait for the one native
        # batch lane. A hung native call must not turn repeated client timeouts
        # into unbounded blocked Python threads.
        if not self._stt_slots.acquire(blocking=False):
            raise ProtocolError(429, "STT_BUSY")
        try:
            with self._stt_lock:
                transcript = self._transcriber.transcribe_without_streaming(
                    samples.tolist(), sample_rate=int(sample_rate)
                )
        finally:
            self._stt_slots.release()

        lines = list(getattr(transcript, "lines", []) or [])
        text = "\n".join(
            str(getattr(line, "text", "")).strip() for line in lines
            if str(getattr(line, "text", "")).strip()
        )
        if len(text) > MAX_TRANSCRIPT_CHARS:
            raise RuntimeError("Moonshine transcript exceeds output bound")

        words: list[dict[str, Any]] = []
        confidences: list[float] = []
        for line in lines:
            for word in list(getattr(line, "words", None) or []):
                if len(words) >= MAX_WORDS:
                    break
                word_text = str(getattr(word, "word", ""))
                if not word_text or len(word_text) > 128:
                    continue
                start = finite_float(getattr(word, "start", None), "INVALID_WORD")
                end = finite_float(getattr(word, "end", None), "INVALID_WORD")
                confidence = finite_float(getattr(word, "confidence", None), "INVALID_WORD")
                if start < 0 or end < start or confidence < 0 or confidence > 1:
                    continue
                item: dict[str, Any] = {
                    "word": word_text,
                    "startMs": start * 1000.0,
                    "endMs": end * 1000.0,
                    "confidence": confidence,
                }
                words.append(item)
                confidences.append(confidence)

        result: dict[str, Any] = {"text": text}
        if confidences:
            result["confidence"] = sum(confidences) / len(confidences)
        if words:
            result["words"] = words
        return result


class TtsRuntime:
    def __init__(self, *, asset_root: Path) -> None:
        import numpy as np
        import moonshine_voice
        from moonshine_voice.tts import TextToSpeech

        if getattr(moonshine_voice, "__version__", None) != MOONSHINE_VERSION:
            raise RuntimeError("moonshine-voice version mismatch")
        self._np = np
        self._tts = (
            TextToSpeech()
            .language("en_us")
            .voice("kokoro_af_heart")
            .models_from(asset_root, download=False)
        )
        self._tts.load()
        self._synthesis_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._current_request_id: str | None = None
        self._cancelled_request_ids: OrderedDict[str, None] = OrderedDict()
        self.runtime_version = (
            f"moonshine-voice/{MOONSHINE_VERSION};deps/{PYTHON_DEPENDENCY_LOCK_VERSION}"
        )

    def close(self) -> None:
        with self._state_lock:
            current = self._current_request_id
        if current is not None:
            try:
                self._tts.cancel_stream()
            except Exception:
                pass
        self._tts.close()

    def synthesize(self, body: dict[str, Any]) -> dict[str, Any]:
        request_id = body.get("requestId")
        text = body.get("text")
        voice = body.get("voice")
        language = body.get("language")
        sample_rate = body.get("sampleRate")
        speed = finite_float(body.get("speed"), "INVALID_SPEED")
        if not isinstance(request_id, str) or not (1 <= len(request_id) <= 128):
            raise ProtocolError(400, "INVALID_REQUEST_ID")
        if not isinstance(text, str) or not text or len(text) > MAX_TTS_TEXT_CHARS:
            raise ProtocolError(400, "INVALID_TEXT")
        if voice != "kokoro_af_heart" or language != "en-US" or sample_rate != 24_000:
            raise ProtocolError(400, "UNSUPPORTED_TTS_CONFIGURATION")
        # Moonshine's cancellable TTS path is the streaming API. It does not
        # expose per-request speed mutation, and desktop v1 always requests 1x.
        if speed != 1.0:
            raise ProtocolError(400, "UNSUPPORTED_TTS_SPEED")

        if not self._synthesis_lock.acquire(blocking=False):
            raise ProtocolError(429, "TTS_BUSY")
        try:
            with self._state_lock:
                if request_id in self._cancelled_request_ids:
                    self._cancelled_request_ids.pop(request_id, None)
                    raise ProtocolError(409, "CANCELLED")
                if self._current_request_id is not None:
                    raise ProtocolError(409, "TTS_BUSY")
                self._current_request_id = request_id

            chunks: list[Any] = []
            frame_count = 0
            try:
                for chunk in self._tts.stream(text):
                    with self._state_lock:
                        if request_id in self._cancelled_request_ids:
                            raise ProtocolError(409, "CANCELLED")
                    if int(chunk.sample_rate) != 24_000:
                        raise RuntimeError("Kokoro returned unexpected sample rate")
                    pcm_chunk = self._np.asarray(chunk.samples, dtype="<f4").reshape(-1)
                    if pcm_chunk.size == 0:
                        continue
                    if not self._np.isfinite(pcm_chunk).all() or bool(
                        (self._np.abs(pcm_chunk) > 1.001).any()
                    ):
                        raise RuntimeError("Kokoro returned invalid PCM")
                    frame_count += int(pcm_chunk.size)
                    if frame_count > 24_000 * MAX_TTS_SECONDS:
                        raise RuntimeError("Kokoro output exceeds PCM bound")
                    chunks.append(pcm_chunk.copy())

                with self._state_lock:
                    if request_id in self._cancelled_request_ids:
                        raise ProtocolError(409, "CANCELLED")
                if not chunks:
                    raise RuntimeError("Kokoro returned no PCM")
                pcm = self._np.concatenate(chunks).astype("<f4", copy=False)
            finally:
                with self._state_lock:
                    self._current_request_id = None
                    self._cancelled_request_ids.pop(request_id, None)
        finally:
            self._synthesis_lock.release()

        raw = pcm.tobytes(order="C")
        encoded = base64.b64encode(raw).decode("ascii")
        result = {
            "pcmF32Base64": encoded,
            "sampleRate": 24_000,
            "channels": 1,
            "durationMs": (pcm.size / 24_000) * 1000.0,
        }
        if len(encoded) > MAX_RESPONSE_BYTES:
            raise RuntimeError("Kokoro response exceeds transport bound")
        return result

    def cancel(self, body: dict[str, Any]) -> dict[str, Any]:
        request_id = body.get("requestId")
        if not isinstance(request_id, str) or not (1 <= len(request_id) <= 128):
            raise ProtocolError(400, "INVALID_REQUEST_ID")

        # Cancellation may beat the synthesis HTTP handler even though the
        # TypeScript request manager has already marked the model call in flight.
        # Tombstone the exact request so a later handler cannot start Moonshine.
        with self._state_lock:
            self._cancelled_request_ids.pop(request_id, None)
            self._cancelled_request_ids[request_id] = None
            while len(self._cancelled_request_ids) > MAX_TTS_CANCELLATION_TOMBSTONES:
                self._cancelled_request_ids.popitem(last=False)

            if self._current_request_id != request_id:
                return {"accepted": True}

            # Moonshine explicitly documents cancel_stream() as safe for
            # barge-in from another thread while stream() is producing chunks.
            try:
                self._tts.cancel_stream()
            except Exception:
                self._cancelled_request_ids.pop(request_id, None)
                raise
        return {"accepted": True}


class WorkerServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = False
    request_queue_size = MAX_HTTP_CONNECTIONS

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], *, token: str, component: str, runtime: Any) -> None:
        super().__init__(address, handler)
        self.worker_token = token
        self.component = component
        self.runtime = runtime
        self._request_slots = threading.BoundedSemaphore(MAX_HTTP_CONNECTIONS)

    def get_request(self):
        request, client_address = super().get_request()
        request.settimeout(HTTP_SOCKET_TIMEOUT_SECONDS)
        return request, client_address

    def process_request(self, request, client_address) -> None:
        if not self._request_slots.acquire(blocking=False):
            try:
                request.close()
            finally:
                return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


class Handler(BaseHTTPRequestHandler):
    server: WorkerServer
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "NOT_FOUND"})
            return
        if not self._authorized():
            self._send_json(401, {"error": "UNAUTHORIZED"})
            return
        self._send_json(200, {"status": "READY", "component": self.server.component})

    def do_POST(self) -> None:
        if not self._authorized():
            self._send_json(401, {"error": "UNAUTHORIZED"})
            return
        try:
            body = self._read_json()
            if self.server.component == "speech" and self.path == "/v1/vad":
                output = self.server.runtime.score_vad(body)
            elif self.server.component == "speech" and self.path == "/v1/stt":
                output = self.server.runtime.transcribe(body)
            elif self.server.component == "tts" and self.path == "/v1/tts":
                output = self.server.runtime.synthesize(body)
            elif self.server.component == "tts" and self.path == "/v1/tts/cancel":
                output = self.server.runtime.cancel(body)
            else:
                raise ProtocolError(404, "NOT_FOUND")
            self._send_json(200, output)
        except ProtocolError as exc:
            self._send_json(exc.status, {"error": exc.code})
        except Exception:
            self._send_json(500, {"error": "RUNTIME_FAILURE"})

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.worker_token}"
        return hmac.compare_digest(header, expected)

    def _read_json(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isascii() or not raw_length.isdecimal():
            raise ProtocolError(411, "CONTENT_LENGTH_REQUIRED")
        length = int(raw_length)
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ProtocolError(413, "REQUEST_TOO_LARGE")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ProtocolError(400, "TRUNCATED_REQUEST")
        try:
            value = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise ProtocolError(400, "INVALID_JSON") from exc
        if not isinstance(value, dict):
            raise ProtocolError(400, "INVALID_JSON")
        return value

    def _send_json(self, status: int, value: dict[str, Any]) -> None:
        data = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        if len(data) > MAX_RESPONSE_BYTES:
            status = 500
            data = b'{"error":"RESPONSE_TOO_LARGE"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--component", choices=("speech", "tts"), required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--silero-model")
    parser.add_argument("--moonshine-model-root")
    parser.add_argument("--tts-asset-root")
    args = parser.parse_args()
    if args.port != 0:
        raise RuntimeError("production worker requires dynamic loopback port allocation")
    return args


def main() -> int:
    args = parse_args()
    require_runtime_environment()
    token = require_worker_token()
    runtime: Any
    if args.component == "speech":
        if not args.silero_model or not args.moonshine_model_root:
            raise RuntimeError("speech model paths are required")
        silero_model = require_file(args.silero_model, "Silero model")
        moonshine_model_root = require_directory(
            args.moonshine_model_root, "Moonshine model root"
        )
        verify_asset_file(
            silero_model,
            expected_size=SILERO_ASSET_SPEC[0],
            expected_sha256=SILERO_ASSET_SPEC[1],
            label="Silero model",
        )
        verify_asset_tree(
            moonshine_model_root,
            SPEECH_ASSET_SPECS,
            "Moonshine model root",
        )
        runtime = SpeechRuntime(
            silero_model=silero_model,
            moonshine_model_root=moonshine_model_root,
        )
        model_identity = SPEECH_MODEL_IDENTITY
        capabilities = ["vad", "stt"]
    else:
        if not args.tts_asset_root:
            raise RuntimeError("TTS asset root is required")
        tts_asset_root = require_directory(args.tts_asset_root, "TTS asset root")
        verify_asset_tree(tts_asset_root, TTS_ASSET_SPECS, "TTS asset root")
        runtime = TtsRuntime(asset_root=tts_asset_root)
        model_identity = TTS_MODEL_IDENTITY
        capabilities = ["tts"]

    server = WorkerServer(("127.0.0.1", 0), Handler, token=token, component=args.component, runtime=runtime)
    port = int(server.server_address[1])

    def stdin_monitor() -> None:
        try:
            for line in sys.stdin:
                if line.rstrip("\r\n") == "shutdown":
                    server.shutdown()
                    return
        except Exception:
            return

    monitor = threading.Thread(target=stdin_monitor, name="desktop-worker-stdin", daemon=True)
    monitor.start()
    ready = {
        "ready": True,
        "detail": f"{args.component} local model worker ready",
        "handshake": {
            "componentVersion": WORKER_COMPONENT_VERSION,
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "workerType": args.component,
            "runtimeVersion": runtime.runtime_version,
            "modelVersionOrHash": model_identity,
            "capabilities": capabilities,
            "metadata": {
                "port": port,
            },
        },
    }
    print(json.dumps(ready, separators=(",", ":"), ensure_ascii=True), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        runtime.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"local model worker startup failed: {type(exc).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(2)
