from __future__ import annotations

import base64
import hashlib
import importlib.util
import sys
import tempfile
import threading
import unittest
from collections import OrderedDict
from pathlib import Path

import numpy as np

WORKER_PATH = Path(__file__).with_name("local_model_worker.py")
SPEC = importlib.util.spec_from_file_location("interview_local_model_worker_tested", WORKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load production local model worker for tests")
worker = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = worker
SPEC.loader.exec_module(worker)


def pcm_base64(values: list[float]) -> str:
    return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode("ascii")


class _FakeSilero:
    def __init__(self) -> None:
        self.calls: list[np.ndarray] = []

    def run(self, _outputs, feeds):
        model_input = np.asarray(feeds["input"], dtype=np.float32)
        self.calls.append(model_input.copy())
        return np.asarray([[0.75]], dtype=np.float32), np.asarray(
            feeds["state"], dtype=np.float32
        ).copy()


class _FakeTranscript:
    lines: list[object] = []


class _FakeTranscriber:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe_without_streaming(self, _samples, *, sample_rate: int):
        self.calls += 1
        if sample_rate != 16_000:
            raise AssertionError("unexpected sample rate")
        return _FakeTranscript()


class _FakeTts:
    def __init__(self) -> None:
        self.cancel_calls = 0

    def cancel_stream(self) -> None:
        self.cancel_calls += 1


class ProductionWorkerUnitTests(unittest.TestCase):
    def test_runtime_environment_accepts_the_exact_installed_lock(self) -> None:
        worker.require_runtime_environment()

    def test_runtime_environment_rejects_distribution_drift(self) -> None:
        original = worker.version

        def drifted(distribution: str) -> str:
            if distribution == "numpy":
                return "0.0.0"
            return original(distribution)

        worker.version = drifted
        try:
            with self.assertRaisesRegex(RuntimeError, "numpy package version mismatch"):
                worker.require_runtime_environment()
        finally:
            worker.version = original

    def test_verify_asset_file_rejects_post_manifest_byte_drift(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            candidate = Path(root) / "model.bin"
            payload = b"verified-model-bytes"
            candidate.write_bytes(payload)
            expected = hashlib.sha256(payload).hexdigest()
            resolved = worker.verify_asset_file(
                candidate,
                expected_size=len(payload),
                expected_sha256=expected,
                label="fixture model",
            )
            self.assertEqual(resolved, candidate.resolve())

            tampered = b"tampered-model-bytes"
            candidate.write_bytes(tampered)
            with self.assertRaisesRegex(RuntimeError, "immutable digest verification"):
                worker.verify_asset_file(
                    candidate,
                    expected_size=len(tampered),
                    expected_sha256=expected,
                    label="fixture model",
                )

    def test_vad_48k_downsampling_preserves_phase_across_http_frames(self) -> None:
        runtime = object.__new__(worker.SpeechRuntime)
        runtime._np = np
        runtime._silero = _FakeSilero()
        runtime._states = OrderedDict()
        runtime._vad_lock = threading.Lock()
        runtime._vad_slots = threading.BoundedSemaphore(
            worker.MAX_SPEECH_NATIVE_RESERVATIONS
        )

        first = runtime.score_vad({
            "streamId": "stream-a",
            "sampleRate": 48_000,
            "pcmF32Base64": pcm_base64([0.0, 0.3]),
        })
        self.assertEqual(first, {"speechProbability": 0.0})
        state = runtime._states["stream-a"]
        self.assertEqual(state.pending_48k.size, 2)
        self.assertEqual(state.pending.size, 0)

        second = runtime.score_vad({
            "streamId": "stream-a",
            "sampleRate": 48_000,
            "pcmF32Base64": pcm_base64([0.6]),
        })
        self.assertEqual(second, {"speechProbability": 0.0})
        state = runtime._states["stream-a"]
        self.assertEqual(state.pending_48k.size, 0)
        self.assertEqual(state.pending.size, 1)
        self.assertAlmostEqual(float(state.pending[0]), 0.0, places=6)

    def test_vad_rejects_sample_rate_change_for_existing_stream(self) -> None:
        runtime = object.__new__(worker.SpeechRuntime)
        runtime._np = np
        runtime._silero = _FakeSilero()
        runtime._states = OrderedDict()
        runtime._vad_lock = threading.Lock()
        runtime._vad_slots = threading.BoundedSemaphore(
            worker.MAX_SPEECH_NATIVE_RESERVATIONS
        )

        runtime.score_vad({
            "streamId": "stream-a",
            "sampleRate": 16_000,
            "pcmF32Base64": pcm_base64([0.0]),
        })
        with self.assertRaises(worker.ProtocolError) as raised:
            runtime.score_vad({
                "streamId": "stream-a",
                "sampleRate": 48_000,
                "pcmF32Base64": pcm_base64([0.0, 0.0, 0.0]),
            })
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.code, "STREAM_SAMPLE_RATE_CHANGED")

    def test_stt_waits_for_the_single_native_batch_lane_instead_of_failing_busy(self) -> None:
        runtime = object.__new__(worker.SpeechRuntime)
        runtime._np = np
        runtime._stt_lock = threading.Lock()
        runtime._stt_slots = threading.BoundedSemaphore(
            worker.MAX_SPEECH_NATIVE_RESERVATIONS
        )
        runtime._transcriber = _FakeTranscriber()
        runtime._stt_lock.acquire()
        completed = threading.Event()
        outcome: dict[str, object] = {}

        def run_transcription() -> None:
            try:
                outcome["value"] = runtime.transcribe({
                    "requestId": "request-1",
                    "utteranceId": "utterance-1",
                    "sampleRate": 16_000,
                    "pcmF32Base64": pcm_base64([0.0]),
                })
            except Exception as exc:
                outcome["error"] = exc
            finally:
                completed.set()

        thread = threading.Thread(target=run_transcription)
        thread.start()
        self.assertFalse(completed.wait(0.05))
        self.assertEqual(runtime._transcriber.calls, 0)

        runtime._stt_lock.release()
        self.assertTrue(completed.wait(1.0))
        thread.join(timeout=1.0)
        self.assertNotIn("error", outcome)
        self.assertEqual(outcome.get("value"), {"text": ""})
        self.assertEqual(runtime._transcriber.calls, 1)

    def test_tts_cancel_before_synthesis_registration_prevents_model_start(self) -> None:
        runtime = object.__new__(worker.TtsRuntime)
        fake = _FakeTts()
        runtime._np = np
        runtime._tts = fake
        runtime._synthesis_lock = threading.Lock()
        runtime._state_lock = threading.Lock()
        runtime._current_request_id = None
        runtime._cancelled_request_ids = OrderedDict()

        self.assertEqual(runtime.cancel({"requestId": "pre-cancelled"}), {"accepted": True})
        with self.assertRaises(worker.ProtocolError) as raised:
            runtime.synthesize({
                "requestId": "pre-cancelled",
                "text": "This must never enter Moonshine.",
                "voice": "kokoro_af_heart",
                "language": "en-US",
                "speed": 1.0,
                "sampleRate": 24_000,
            })
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(raised.exception.code, "CANCELLED")
        self.assertEqual(fake.cancel_calls, 0)

    def test_tts_cancel_is_bound_to_the_exact_active_request(self) -> None:
        runtime = object.__new__(worker.TtsRuntime)
        fake = _FakeTts()
        runtime._tts = fake
        runtime._state_lock = threading.Lock()
        runtime._current_request_id = "active-request"
        runtime._cancelled_request_ids = OrderedDict()

        self.assertEqual(runtime.cancel({"requestId": "other-request"}), {"accepted": True})
        self.assertEqual(fake.cancel_calls, 0)
        self.assertIn("other-request", runtime._cancelled_request_ids)

        self.assertEqual(runtime.cancel({"requestId": "active-request"}), {"accepted": True})
        self.assertEqual(fake.cancel_calls, 1)
        self.assertIn("active-request", runtime._cancelled_request_ids)


if __name__ == "__main__":
    unittest.main()
