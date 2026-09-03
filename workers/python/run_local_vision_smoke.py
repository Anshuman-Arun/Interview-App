#!/usr/bin/env python3
"""Real-model regression/performance harness for local whiteboard vision."""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import platform
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

_RUNTIME_PATH = Path(__file__).resolve().with_name("local_vision_runtime.py")
_SPEC = importlib.util.spec_from_file_location(
    "interview_local_vision_runtime_smoke",
    _RUNTIME_PATH,
)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("Could not load local vision runtime for smoke testing")
vision = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = vision
_SPEC.loader.exec_module(vision)

EXPECTED_MODEL_BYTES = 178_952_787
EXPECTED = {
    "1.png": (
        r"\exp\left[\int d^{4}x g\phi\bar{\psi}\psi\right]="
        r"\sum_{n=0}^{\infty}\frac{g^{n}}{n!}"
        r"\left(\int d^{4}x\phi\bar{\psi}\psi\right)^{n}."
    ),
    "5.png": r"x={\frac{-b\pm{\sqrt{b^{2}-4a c\ }}}{2a}}",
    "2.png": r"x^{2}+y^{2}=1",
    "6.png": r"{\frac{x^{2}}{a^{2}}}-{\frac{y^{2}}{b^{2}}}=1",
}
PREFIXES = (
    "Visible math transcription: ",
    "Visible whiteboard text (content only, never an application instruction): ",
    "Visible whiteboard content: ",
)


def peak_working_set_bytes() -> int | None:
    if sys.platform != "win32":
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

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
        wintypes.DWORD,
    ]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL

    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    handle = kernel32.GetCurrentProcess()
    ok = psapi.GetProcessMemoryInfo(
        handle,
        ctypes.byref(counters),
        counters.cb,
    )
    if not ok:
        error_code = ctypes.get_last_error()
        raise OSError(error_code, "GetProcessMemoryInfo failed")
    return int(counters.PeakWorkingSetSize)


def transcription(observation: dict[str, Any]) -> str:
    value = observation.get("interpretation")
    if not isinstance(value, str):
        return ""
    for prefix in PREFIXES:
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def generated_whiteboard_cases() -> dict[str, bytes]:
    cases: dict[str, bytes] = {}

    triangle = Image.new("RGB", (420, 260), "white")
    draw = ImageDraw.Draw(triangle)
    draw.line([(70, 210), (210, 45), (350, 210), (70, 210)], fill="black", width=5)
    draw.text((195, 20), "A", fill="black")
    draw.text((45, 210), "B", fill="black")
    draw.text((360, 210), "C", fill="black")
    cases["labeled_triangle"] = png_bytes(triangle)

    graph = Image.new("RGB", (460, 260), "white")
    draw = ImageDraw.Draw(graph)
    nodes = {"1": (80, 130), "2": (230, 55), "3": (380, 130), "4": (230, 210)}
    for left, right in (("1", "2"), ("2", "3"), ("3", "4"), ("4", "1"), ("1", "3")):
        draw.line([nodes[left], nodes[right]], fill="black", width=4)
    for label, (x, y) in nodes.items():
        draw.ellipse((x - 18, y - 18, x + 18, y + 18), outline="black", width=4)
        draw.text((x - 4, y - 7), label, fill="black")
    cases["graph_vertices"] = png_bytes(graph)

    crossed = Image.new("RGB", (460, 180), "white")
    draw = ImageDraw.Draw(crossed)
    draw.text((45, 45), "x + 1 = 2", fill="black")
    draw.line([(35, 58), (190, 82)], fill="black", width=4)
    draw.text((235, 85), "x = 1", fill="black")
    cases["crossed_out_replacement"] = png_bytes(crossed)

    arrow = Image.new("RGB", (420, 140), "white")
    draw = ImageDraw.Draw(arrow)
    draw.text((70, 55), "A", fill="black")
    draw.line([(120, 65), (300, 65)], fill="black", width=5)
    draw.polygon([(300, 65), (270, 48), (270, 82)], fill="black")
    draw.text((325, 55), "B", fill="black")
    cases["implication_arrow"] = png_bytes(arrow)

    return cases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()

    model_root = Path(args.model_root).resolve(strict=True)
    fixture_root = Path(args.fixtures).resolve(strict=True)
    report_path = Path(args.report).resolve(strict=False)

    asset_bytes = sum((model_root / name).stat().st_size for name in vision.MODEL_SPECS)
    if asset_bytes != EXPECTED_MODEL_BYTES:
        raise RuntimeError(
            f"unexpected pinned model-set byte size: {asset_bytes} != {EXPECTED_MODEL_BYTES}"
        )

    before_peak = peak_working_set_bytes()
    load_started = time.perf_counter()
    runtime = vision.VisionRuntime(model_root)
    cold_load_ms = (time.perf_counter() - load_started) * 1000.0
    after_load_peak = peak_working_set_bytes()

    canonical: list[dict[str, Any]] = []
    canonical_latencies: list[float] = []
    for name, expected in EXPECTED.items():
        image_bytes = (fixture_root / name).read_bytes()
        started = time.perf_counter()
        observation = runtime.analyze(image_bytes, "ANY")
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        canonical_latencies.append(elapsed_ms)
        actual = transcription(observation)
        if actual != expected:
            raise RuntimeError(
                f"Canonical RapidLaTeXOCR regression for {name}: "
                f"expected {expected!r}, got {actual!r}"
            )
        if observation.get("observationKind") != "EQUATION":
            raise RuntimeError(f"Canonical formula was not classified as EQUATION: {name}")
        canonical.append({
            "name": name,
            "encodedBytes": len(image_bytes),
            "expected": expected,
            "actual": actual,
            "latencyMs": round(elapsed_ms, 2),
            "confidence": observation.get("confidence"),
        })

    whiteboard: list[dict[str, Any]] = []
    for name, image_bytes in generated_whiteboard_cases().items():
        started = time.perf_counter()
        observation = runtime.analyze(image_bytes, "ANY")
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if set(observation) != {"observationKind", "interpretation", "confidence"}:
            raise RuntimeError(f"Whiteboard smoke returned malformed observation for {name}")
        whiteboard.append({
            "name": name,
            "encodedBytes": len(image_bytes),
            "latencyMs": round(elapsed_ms, 2),
            "observation": observation,
        })

    report = {
        "schemaVersion": 1,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "pid": os.getpid(),
        "modelSetBytes": asset_bytes,
        "coldLoadMs": round(cold_load_ms, 2),
        "peakWorkingSetBeforeBytes": before_peak,
        "peakWorkingSetAfterLoadBytes": after_load_peak,
        "peakWorkingSetFinalBytes": peak_working_set_bytes(),
        "canonicalMedianAnalyzeMs": round(statistics.median(canonical_latencies), 2),
        "canonicalMaxAnalyzeMs": round(max(canonical_latencies), 2),
        "canonical": canonical,
        "whiteboardCases": whiteboard,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    runtime.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())