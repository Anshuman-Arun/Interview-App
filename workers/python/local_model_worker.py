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
import json
import math
import os
import sys
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

WORKER_COMPONENT_VERSION = "1"
WORKER_PROTOCOL_VERSION = 1
MOONSHINE_VERSION = "0.1.5"
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_TRANSCRIPT_CHARS = 20_000
MAX_WORDS = 1_000
MAX_TTS_TEXT_CHARS = 4_000
MAX_TTS_SECONDS = 60
MAX_VAD_STREAMS = 64
SILERO_WINDOW_16K = 512
SILERO_CONTEXT_16K = 64

SPEECH_MODEL_IDENTITY = (
    "moonshine-tiny-en@35d84fc0eb2d7451da9973c990e8a77066abb105+"
    "silero-v6.2.1@7e30209a3e901f9842f81b225f3e93d8199902b1"
)
TTS_MODEL_IDENTITY = "kokoro-af-heart+35d84fc0eb2d7451da9973c990e8a77066abb105"


class ProtocolError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def require_file(path: str, label: str) -> Path:
    candidate = Path(path).resolve(strict=True)
    if not candidate.is_file() or candidate.is_symlink():
        raise RuntimeError(f"{label} is not a regular file")
    return candidate


def require_directory(path: str, label: str) -> Path:
    candidate = Path(path).resolve(strict=True)
    if not candidate.is_dir() or candidate.is_symlink():
        raise RuntimeError(f"{label} is not a regular directory")
    return candidate


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

        providers = ["CPUExecutionProvider"] if "CPUExecutionProvider" in ort.get_available_providers() else None
        session_options = ort.SessionOptions()
        session_options.inter_op_num_threads = 1
        session_options.intra_op_num_threads = 1
        self._silero = ort.InferenceSession(
            str(silero_model), providers=providers, sess_options=session_options
        )
        self._transcriber = Transcriber(str(moonshine_model_root), model_arch=ModelArch.TINY)
        self._np = np
        self._states: OrderedDict[str, SileroState] = OrderedDict()
        self._lock = threading.Lock()
        self.runtime_version = (
            f"moonshine-voice/{MOONSHINE_VERSION};onnxruntime/{getattr(ort, '__version__', 'unknown')}"
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
        if sample_rate == 48_000:
            samples = samples[::3]

        with self._lock:
            state = self._states.pop(stream_id, None)
            if state is None:
                state = SileroState(self._np)
            self._states[stream_id] = state
            while len(self._states) > MAX_VAD_STREAMS:
                self._states.popitem(last=False)

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

        with self._lock:
            transcript = self._transcriber.transcribe_without_streaming(
                samples.tolist(), sample_rate=int(sample_rate)
            )

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
        self._lock = threading.Lock()
        self.runtime_version = f"moonshine-voice/{MOONSHINE_VERSION}"

    def close(self) -> None:
        self._tts.close()

    def synthesize(self, body: dict[str, Any]) -> dict[str, Any]:
        text = body.get("text")
        voice = body.get("voice")
        language = body.get("language")
        sample_rate = body.get("sampleRate")
        speed = finite_float(body.get("speed"), "INVALID_SPEED")
        if not isinstance(text, str) or not text or len(text) > MAX_TTS_TEXT_CHARS:
            raise ProtocolError(400, "INVALID_TEXT")
        if voice != "kokoro_af_heart" or language != "en-US" or sample_rate != 24_000:
            raise ProtocolError(400, "UNSUPPORTED_TTS_CONFIGURATION")
        if speed < 0.5 or speed > 2.0:
            raise ProtocolError(400, "INVALID_SPEED")

        with self._lock:
            samples, actual_rate = self._tts.synthesize(text, speed=speed)
        if int(actual_rate) != 24_000:
            raise RuntimeError("Kokoro returned unexpected sample rate")
        pcm = self._np.asarray(samples, dtype="<f4").reshape(-1)
        if pcm.size == 0 or pcm.size > 24_000 * MAX_TTS_SECONDS:
            raise RuntimeError("Kokoro output exceeds PCM bound")
        if not self._np.isfinite(pcm).all() or bool((self._np.abs(pcm) > 1.001).any()):
            raise RuntimeError("Kokoro returned invalid PCM")
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


class WorkerServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], *, token: str, component: str, runtime: Any) -> None:
        super().__init__(address, handler)
        self.worker_token = token
        self.component = component
        self.runtime = runtime


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
    token = require_worker_token()
    runtime: Any
    if args.component == "speech":
        if not args.silero_model or not args.moonshine_model_root:
            raise RuntimeError("speech model paths are required")
        runtime = SpeechRuntime(
            silero_model=require_file(args.silero_model, "Silero model"),
            moonshine_model_root=require_directory(args.moonshine_model_root, "Moonshine model root"),
        )
        model_identity = SPEECH_MODEL_IDENTITY
        capabilities = ["vad", "stt"]
    else:
        if not args.tts_asset_root:
            raise RuntimeError("TTS asset root is required")
        runtime = TtsRuntime(asset_root=require_directory(args.tts_asset_root, "TTS asset root"))
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
            "modelVersionOrHash": model_identity,
            "capabilities": capabilities,
            "metadata": {
                "workerType": args.component,
                "runtimeVersion": runtime.runtime_version,
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
