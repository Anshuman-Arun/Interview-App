from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import local_model_worker as worker


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "segoepr.ttf",
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "cambria.ttc",
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def _text_image(text: str, *, width: int = 560, height: int = 120) -> Image.Image:
    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    draw.text((18, 20), text, fill=0, font=_font(46))
    return image


def _fraction_image() -> Image.Image:
    image = Image.new("L", (420, 180), 255)
    draw = ImageDraw.Draw(image)
    font = _font(42)
    draw.text((155, 18), "a + b", fill=0, font=font)
    draw.line((125, 88, 300, 88), fill=0, width=4)
    draw.text((185, 98), "2", fill=0, font=font)
    return image


def _triangle_image() -> Image.Image:
    image = Image.new("L", (360, 260), 255)
    draw = ImageDraw.Draw(image)
    draw.line((60, 215, 180, 35, 300, 215, 60, 215), fill=0, width=5)
    font = _font(30)
    draw.text((168, 2), "A", fill=0, font=font)
    draw.text((25, 205), "B", fill=0, font=font)
    draw.text((305, 205), "C", fill=0, font=font)
    return image


def _crossed_replacement_image() -> Image.Image:
    image = Image.new("L", (480, 170), 255)
    draw = ImageDraw.Draw(image)
    font = _font(42)
    draw.text((20, 20), "x = 2", fill=0, font=font)
    draw.line((15, 50, 155, 82), fill=0, width=5)
    draw.line((15, 82, 155, 50), fill=0, width=5)
    draw.text((220, 78), "x = 3", fill=0, font=font)
    return image


def _arrow_image() -> Image.Image:
    image = Image.new("L", (420, 110), 255)
    draw = ImageDraw.Draw(image)
    draw.line((30, 55, 350, 55), fill=0, width=5)
    draw.polygon([(350, 35), (395, 55), (350, 75)], fill=0)
    return image


def _png_payload(image: Image.Image) -> tuple[bytes, str]:
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    raw = stream.getvalue()
    return raw, base64.b64encode(raw).decode("ascii")


def _analyze(runtime: worker.VisionRuntime, name: str, image: Image.Image, kind: str) -> dict[str, object]:
    raw, encoded = _png_payload(image)
    started = time.perf_counter()
    result = runtime.analyze({
        "requestId": f"smoke-{name}",
        "requestedObservationKind": kind,
        "width": image.width,
        "height": image.height,
        "snapshotHash": hashlib.sha256(raw).hexdigest(),
        "pngBase64": encoded,
    })
    latency_ms = (time.perf_counter() - started) * 1000.0
    if set(result) != {"observationKind", "interpretation", "confidenceClass"}:
        raise RuntimeError(f"{name}: unbounded worker response shape")
    if not isinstance(result["interpretation"], str) or not result["interpretation"]:
        raise RuntimeError(f"{name}: empty interpretation")
    return {
        "name": name,
        "requestedKind": kind,
        "latencyMs": round(latency_ms, 1),
        **result,
    }


def _peak_working_set_mb() -> float | None:
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
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
            ("PrivateUsage", ctypes.c_size_t),
        ]

    counters = PROCESS_MEMORY_COUNTERS_EX()
    counters.cb = ctypes.sizeof(counters)
    handle = ctypes.windll.kernel32.GetCurrentProcess()
    ok = ctypes.windll.psapi.GetProcessMemoryInfo(
        handle, ctypes.byref(counters), counters.cb
    )
    if not ok:
        return None
    return round(counters.PeakWorkingSetSize / (1024 * 1024), 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-root", required=True)
    args = parser.parse_args()

    asset_root = Path(args.asset_root).resolve(strict=True)
    started = time.perf_counter()
    runtime = worker.VisionRuntime(asset_root=asset_root)
    cold_start_ms = (time.perf_counter() - started) * 1000.0
    try:
        samples = [
            ("circle-equation", _text_image("x^2 + y^2 = 1"), "EQUATION"),
            ("fraction", _fraction_image(), "EQUATION"),
            ("inequality", _text_image("x <= y + 3"), "EQUATION"),
            ("summation", _text_image("sum k=1..n  k^2"), "EQUATION"),
            ("congruence", _text_image("a = b (mod n)"), "EQUATION"),
            ("triangle", _triangle_image(), "DIAGRAM_RELATION"),
            ("crossed-replacement", _crossed_replacement_image(), "EQUATION"),
            ("arrow", _arrow_image(), "ARROW"),
        ]
        results = [
            _analyze(runtime, name, image, kind)
            for name, image, kind in samples
        ]
        report = {
            "platform": sys.platform,
            "python": sys.version.split()[0],
            "modelIdentity": worker.VISION_MODEL_IDENTITY,
            "coldStartMs": round(cold_start_ms, 1),
            "peakWorkingSetMb": _peak_working_set_mb(),
            "results": results,
        }
        print("VISION_REAL_WEIGHT_SMOKE=" + json.dumps(report, separators=(",", ":")))
    finally:
        runtime.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
