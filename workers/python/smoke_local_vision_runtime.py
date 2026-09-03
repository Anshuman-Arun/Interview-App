from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import statistics
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

RUNTIME_PATH = Path(__file__).with_name("local_vision_runtime.py")
RUNTIME_SPEC = importlib.util.spec_from_file_location(
    "interview_local_vision_runtime_smoke",
    RUNTIME_PATH,
)
if RUNTIME_SPEC is None or RUNTIME_SPEC.loader is None:
    raise RuntimeError("Could not load the production local vision runtime")
vision_runtime = importlib.util.module_from_spec(RUNTIME_SPEC)
sys.modules[RUNTIME_SPEC.name] = vision_runtime
RUNTIME_SPEC.loader.exec_module(vision_runtime)
VisionRuntime = vision_runtime.VisionRuntime

MODEL_FILES = {
    "image_resizer.onnx": {
        "size": 38_967_751,
        "sha256": "e0b075c39700f64d50400f39c8fc186bbb3b5d84d31864008313f376603aca9d",
    },
    "encoder.onnx": {
        "size": 89_008_136,
        "sha256": "01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d",
    },
    "decoder.onnx": {
        "size": 50_952_726,
        "sha256": "bd695497bf1b22279b7626f5916c79226e1e244c84355f8da7edfd2d921d0072",
    },
    "tokenizer.json": {
        "size": 24_174,
        "sha256": "1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019",
    },
}
MODEL_RELEASE_ROOT = (
    "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0"
)
UPSTREAM_REVISION = "68680550355330b4ac68acdb947e776bc11f46d7"
FIXTURES = {
    "1.png": {
        "size": 93_704,
        "git_blob_sha1": "73e1e0cc9b7567717fba60d6af603ab54a0ed18a",
        "expected": (
            r"\exp\left[\int d^{4}x g\phi\bar{\psi}\psi\right]="
            r"\sum_{n=0}^{\infty}\frac{g^{n}}{n!}"
            r"\left(\int d^{4}x\phi\bar{\psi}\psi\right)^{n}."
        ),
    },
    "2.png": {
        "size": 4_601,
        "git_blob_sha1": "8812b1ceefa24a9658ab2d15a34aa9ea227602c1",
        "expected": r"x^{2}+y^{2}=1",
    },
    "5.png": {
        "size": 171_763,
        "git_blob_sha1": "bdf4ad6a6fe5d75188ef8075c7fe5b5c53dc9e5e",
        "expected": r"x={\frac{-b\pm{\sqrt{b^{2}-4a c\ }}}{2a}}",
    },
    "6.png": {
        "size": 91_882,
        "git_blob_sha1": "961d2a545f3e95b9d654cfbfe79fa62af2e5e437",
        "expected": r"{\frac{x^{2}}{a^{2}}}-{\frac{y^{2}}{b^{2}}}=1",
    },
}
FIXTURE_ROOT = (
    f"https://raw.githubusercontent.com/RapidAI/RapidLaTeXOCR/"
    f"{UPSTREAM_REVISION}/tests/test_files"
)
MAX_DOWNLOAD_SECONDS = 180
CHUNK_BYTES = 1024 * 1024
MATH_PREFIX = "Visible math transcription: "


def download_exact(
    url: str,
    destination: Path,
    expected_size: int,
    *,
    expected_sha256: str | None = None,
    expected_git_blob_sha1: str | None = None,
) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "interview-app-vision-smoke/1"},
    )
    sha256 = hashlib.sha256()
    body = bytearray()
    with urllib.request.urlopen(request, timeout=MAX_DOWNLOAD_SECONDS) as response:
        while True:
            chunk = response.read(CHUNK_BYTES)
            if not chunk:
                break
            body.extend(chunk)
            sha256.update(chunk)
            if len(body) > expected_size:
                raise RuntimeError(f"{destination.name} exceeded pinned size")
    if len(body) != expected_size:
        raise RuntimeError(
            f"{destination.name} size mismatch: {len(body)} != {expected_size}"
        )
    if expected_sha256 is not None and sha256.hexdigest() != expected_sha256:
        raise RuntimeError(f"{destination.name} SHA-256 mismatch")
    if expected_git_blob_sha1 is not None:
        header = f"blob {len(body)}\0".encode("ascii")
        git_sha1 = hashlib.sha1(header + bytes(body)).hexdigest()
        if git_sha1 != expected_git_blob_sha1:
            raise RuntimeError(f"{destination.name} upstream Git blob identity mismatch")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)


def windows_peak_working_set_bytes() -> int | None:
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    ok = ctypes.windll.psapi.GetProcessMemoryInfo(
        ctypes.windll.kernel32.GetCurrentProcess(),
        ctypes.byref(counters),
        counters.cb,
    )
    if not ok:
        return None
    return int(counters.PeakWorkingSetSize)


def canonical_transcription(observation: dict[str, Any]) -> str:
    interpretation = observation.get("interpretation")
    if not isinstance(interpretation, str):
        return ""
    if interpretation.startswith(MATH_PREFIX):
        return interpretation[len(MATH_PREFIX):]
    return interpretation


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-root", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()

    root = Path(args.work_root).resolve()
    model_root = root / "models"
    fixture_root = root / "fixtures"
    model_root.mkdir(parents=True, exist_ok=True)
    fixture_root.mkdir(parents=True, exist_ok=True)

    for name, spec in MODEL_FILES.items():
        download_exact(
            f"{MODEL_RELEASE_ROOT}/{name}",
            model_root / name,
            int(spec["size"]),
            expected_sha256=str(spec["sha256"]),
        )
    for name, spec in FIXTURES.items():
        download_exact(
            f"{FIXTURE_ROOT}/{name}",
            fixture_root / name,
            int(spec["size"]),
            expected_git_blob_sha1=str(spec["git_blob_sha1"]),
        )

    load_started = time.perf_counter()
    runtime = VisionRuntime(model_root)
    load_seconds = time.perf_counter() - load_started

    fixture_reports: list[dict[str, Any]] = []
    latencies: list[float] = []
    failures: list[str] = []
    for name, spec in FIXTURES.items():
        payload = (fixture_root / name).read_bytes()
        started = time.perf_counter()
        observation = runtime.analyze(payload, "ANY")
        elapsed = time.perf_counter() - started
        latencies.append(elapsed)
        transcription = canonical_transcription(observation)
        exact = transcription == spec["expected"]
        if not exact:
            failures.append(
                f"{name}: expected {spec['expected']!r}, got {transcription!r}"
            )
        fixture_reports.append({
            "fixture": name,
            "latencySeconds": elapsed,
            "observationKind": observation.get("observationKind"),
            "confidence": observation.get("confidence"),
            "transcription": transcription,
            "expected": spec["expected"],
            "exactMatch": exact,
        })

    runtime.close()
    report = {
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "modelSetBytes": sum(int(spec["size"]) for spec in MODEL_FILES.values()),
        "modelRevision": UPSTREAM_REVISION,
        "coldModelLoadSeconds": load_seconds,
        "medianInferenceSeconds": statistics.median(latencies),
        "maxInferenceSeconds": max(latencies),
        "peakWorkingSetBytes": windows_peak_working_set_bytes(),
        "fixtures": fixture_reports,
        "allCanonicalFixturesExact": len(failures) == 0,
    }
    report_path = Path(args.report).resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))

    if failures:
        raise RuntimeError(
            "Pinned local vision model failed canonical upstream fixtures: "
            + " | ".join(failures)
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())