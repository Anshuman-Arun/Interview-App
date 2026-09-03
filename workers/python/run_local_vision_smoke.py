#!/usr/bin/env python3
"""Manual real-model smoke harness for the pinned local whiteboard vision backend.

This script is intentionally excluded from ordinary CI model downloads. It is
used on an explicitly provisioned machine after the exact pinned assets have
been installed.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from local_vision_runtime import VisionRuntime, _decode_png, _prepare_gray

EXPECTED_MODEL_BYTES = 178_952_787


def _peak_working_set_bytes() -> int | None:
    if sys.platform == "win32":
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
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(
            handle,
            ctypes.byref(counters),
            counters.cb,
        )
        return int(counters.PeakWorkingSetSize) if ok else None

    try:
        import resource

        value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        return value if sys.platform == "darwin" else value * 1024
    except Exception:
        return None


def _normalize_latex(value: str) -> str:
    return (
        value.replace(" ", "")
        .replace(r"\,", "")
        .replace(r"\ ", "")
        .replace("{", "")
        .replace("}", "")
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True)
    parser.add_argument(
        "--sample",
        action="append",
        default=[],
        metavar="NAME=PATH",
        help="PNG sample; repeat for multiple inputs",
    )
    parser.add_argument(
        "--require-circle-reference",
        default=None,
        metavar="NAME",
        help="Fail unless the named sample recognizes x^2+y^2=1",
    )
    args = parser.parse_args()

    model_root = Path(args.model_root).resolve(strict=True)
    asset_bytes = sum(
        (model_root / name).stat().st_size
        for name in (
            "image_resizer.onnx",
            "encoder.onnx",
            "decoder.onnx",
            "tokenizer.json",
        )
    )
    if asset_bytes != EXPECTED_MODEL_BYTES:
        raise RuntimeError(
            f"unexpected pinned model-set byte size: {asset_bytes}"
        )

    before_peak = _peak_working_set_bytes()
    load_started = time.perf_counter()
    runtime = VisionRuntime(model_root)
    cold_load_ms = (time.perf_counter() - load_started) * 1000.0
    after_load_peak = _peak_working_set_bytes()

    results: list[dict[str, Any]] = []
    latencies: list[float] = []
    sample_map: dict[str, str] = {}

    for item in args.sample:
        if "=" not in item:
            raise RuntimeError(f"invalid sample argument: {item}")
        name, raw_path = item.split("=", 1)
        if not name or name in sample_map:
            raise RuntimeError(f"invalid or duplicate sample name: {name}")
        path = Path(raw_path).resolve(strict=True)
        png_bytes = path.read_bytes()

        decoded = _decode_png(png_bytes)
        gray = _prepare_gray(decoded)
        raw_text = ""
        clean_eos = False
        if gray is not None:
            raw_text, clean_eos = runtime._recognize(gray)

        started = time.perf_counter()
        observation = runtime.analyze(png_bytes, "ANY")
        latency_ms = (time.perf_counter() - started) * 1000.0
        latencies.append(latency_ms)
        sample_map[name] = raw_text
        results.append(
            {
                "name": name,
                "path": path.name,
                "encodedBytes": len(png_bytes),
                "rawTranscription": raw_text,
                "cleanEos": clean_eos,
                "observation": observation,
                "latencyMs": round(latency_ms, 2),
                "peakWorkingSetBytes": _peak_working_set_bytes(),
            }
        )

    required = args.require_circle_reference
    circle_ok: bool | None = None
    if required is not None:
        if required not in sample_map:
            raise RuntimeError(
                f"required reference sample was not supplied: {required}"
            )
        normalized = _normalize_latex(sample_map[required])
        circle_ok = (
            "x^2+y^2=1" in normalized
            or "x²+y²=1" in normalized
        )

    report = {
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "pid": os.getpid(),
        "assetBytes": asset_bytes,
        "coldLoadMs": round(cold_load_ms, 2),
        "peakWorkingSetBeforeBytes": before_peak,
        "peakWorkingSetAfterLoadBytes": after_load_peak,
        "medianInferenceMs": (
            round(statistics.median(latencies), 2) if latencies else None
        ),
        "maxInferenceMs": round(max(latencies), 2) if latencies else None,
        "circleReferencePassed": circle_ok,
        "samples": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if circle_ok is False:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
