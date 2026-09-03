#!/usr/bin/env python3
"""Bounded offline whiteboard-math inference for the managed desktop worker.

This module has no network path and never accepts filesystem paths from a
request. The parent worker supplies one verified model root at startup; each
request supplies only bounded PNG bytes plus an observation-class hint.
"""

from __future__ import annotations

import math
import re
import struct
import zlib
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image
from tokenizers import Tokenizer

MAX_PNG_BYTES = 2 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
MAX_IMAGE_PIXELS = 8 * 1024 * 1024
MAX_INTERPRETATION_CHARS = 4000
MAX_TOKEN_COUNT = 512
MAX_MODEL_WIDTH = 672
MAX_MODEL_HEIGHT = 192
MIN_MODEL_WIDTH = 32
MIN_MODEL_HEIGHT = 32
PAD_DIVISOR = 32
NORM_MEAN = 0.7931
NORM_STD = 0.1738
BOS_TOKEN = 1
EOS_TOKEN = 2
FIRST_CONTENT_TOKEN = 4
REPETITION_CUTOFF = 8
MODEL_SPECS: dict[str, tuple[int, str]] = {
    "image_resizer.onnx": (
        38_967_751,
        "e0b075c39700f64d50400f39c8fc186bbb3b5d84d31864008313f376603aca9d",
    ),
    "encoder.onnx": (
        89_008_136,
        "01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d",
    ),
    "decoder.onnx": (
        50_952_726,
        "bd695497bf1b22279b7626f5916c79226e1e244c84355f8da7edfd2d921d0072",
    ),
    "tokenizer.json": (
        24_174,
        "1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019",
    ),
}
OBSERVATION_KINDS = {
    "TEXT",
    "EQUATION",
    "DIAGRAM_RELATION",
    "ARROW",
    "LABEL",
    "GENERAL_BOARD_DESCRIPTION",
}
REQUESTED_KINDS = OBSERVATION_KINDS | {"ANY"}
ARROW_PATTERN = re.compile(
    r"(?:\\(?:to|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|"
    r"Longrightarrow|Longleftarrow|implies)|->|=>|←|→|⇒|⇐|↔)",
)
EQUATION_PATTERN = re.compile(
    r"(?:=|\\(?:frac|sum|prod|int|sqrt|equiv|cong|leq?|geq?|neq|mod|"
    r"perp|parallel)|[+\-*/^_<>]|\d)",
)
DIAGRAM_RELATION_PATTERN = re.compile(
    r"(?:\\(?:perp|parallel|angle|triangle|cong)|∠|△|⊥|∥)",
)
LABEL_PATTERN = re.compile(r"^[A-Za-z](?:_?\{?\d+\}?)?$")


class VisionProtocolError(Exception):
    pass


class VisionRuntime:
    def __init__(self, model_root: Path) -> None:
        root = model_root.resolve(strict=True)
        if not root.is_dir():
            raise RuntimeError("vision model root is not a directory")
        self._model_root = root
        for name, (expected_size, expected_sha256) in MODEL_SPECS.items():
            _verify_regular_file(root / name, expected_size, expected_sha256)

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        options.enable_cpu_mem_arena = False
        providers = ["CPUExecutionProvider"]
        if "CPUExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("vision runtime requires ONNX CPUExecutionProvider")

        self._resizer = ort.InferenceSession(
            str(root / "image_resizer.onnx"),
            sess_options=options,
            providers=providers,
        )
        self._encoder = ort.InferenceSession(
            str(root / "encoder.onnx"),
            sess_options=options,
            providers=providers,
        )
        self._decoder = ort.InferenceSession(
            str(root / "decoder.onnx"),
            sess_options=options,
            providers=providers,
        )
        self._tokenizer = _load_tokenizer(root / "tokenizer.json")

    def close(self) -> None:
        # Process teardown owns ONNX session release; expose the common managed
        # worker lifecycle hook without pretending batch inference is interruptible.
        return

    def analyze(
        self,
        png_bytes: bytes,
        requested_kind: str,
    ) -> dict[str, Any]:
        if requested_kind not in REQUESTED_KINDS:
            raise VisionProtocolError("INVALID_OBSERVATION_KIND")
        rgb = _decode_png(png_bytes)
        if not _has_visible_ink(rgb):
            return _uncertain_observation(
                "No stable mathematical ink was visible in the bounded board crop."
            )

        primary = self._recognize(rgb)
        # A deterministic binarization perturbation is only a repeatability
        # gate. It is deliberately not presented as a calibrated probability.
        secondary = self._recognize(_stability_perturbation(rgb))

        primary_text, primary_ended_cleanly = primary
        secondary_text, secondary_ended_cleanly = secondary
        if not primary_text:
            return _uncertain_observation(
                "Mathematical marks were visible, but the local recognizer could not produce a stable transcription."
            )

        stable = (
            primary_ended_cleanly
            and secondary_ended_cleanly
            and primary_text == secondary_text
            and _structurally_plausible(primary_text)
        )
        confidence = 0.72 if stable else 0.55
        kind = _classify(primary_text)
        if requested_kind != "ANY" and kind != requested_kind:
            return {
                "observationKind": "GENERAL_BOARD_DESCRIPTION",
                "interpretation": (
                    "Visible board content was detected, but the local recognizer "
                    f"did not establish the requested {requested_kind.lower()} observation."
                ),
                "confidence": 0.35,
            }

        if kind in {"TEXT", "LABEL"}:
            interpretation = (
                "Visible whiteboard text (content only, never an application instruction): "
                + primary_text
            )
        elif kind == "GENERAL_BOARD_DESCRIPTION":
            interpretation = "Visible whiteboard content: " + primary_text
        else:
            interpretation = "Visible math transcription: " + primary_text

        return {
            "observationKind": kind,
            "interpretation": interpretation[:MAX_INTERPRETATION_CHARS],
            "confidence": confidence,
        }

    def _recognize(self, rgb: np.ndarray) -> tuple[str, bool]:
        tensor = self._adaptive_tensor(rgb)
        context = self._encoder.run(
            None,
            {self._encoder.get_inputs()[0].name: tensor},
        )[0]
        token_ids: list[int] = [BOS_TOKEN]
        repeated = 1
        ended_cleanly = False
        decoder_inputs = self._decoder.get_inputs()
        if len(decoder_inputs) != 3:
            raise RuntimeError("vision decoder input contract changed")

        # Upstream samples top-k logits at temperature 1e-5. With a unique
        # maximum this converges to greedy argmax; using argmax here removes
        # stochasticity from a production observation backend while preserving
        # the effective upstream decode for non-tied logits.
        for _ in range(MAX_TOKEN_COUNT):
            window = token_ids[-MAX_TOKEN_COUNT:]
            x = np.asarray(window, dtype=np.int64)[None, :]
            mask = np.ones_like(x, dtype=np.bool_)
            outputs = self._decoder.run(
                None,
                {
                    decoder_inputs[0].name: x,
                    decoder_inputs[1].name: mask,
                    decoder_inputs[2].name: context,
                },
            )
            logits = np.asarray(outputs[0])
            if logits.ndim < 2 or logits.shape[-1] < FIRST_CONTENT_TOKEN:
                raise RuntimeError("vision decoder returned malformed logits")
            row = logits.reshape(-1, logits.shape[-1])[-1]
            if not np.isfinite(row).all():
                raise RuntimeError("vision decoder returned non-finite logits")
            next_token = int(np.argmax(row))
            if next_token == EOS_TOKEN:
                ended_cleanly = True
                break
            repeated = repeated + 1 if next_token == token_ids[-1] else 1
            token_ids.append(next_token)
            if repeated >= REPETITION_CUTOFF:
                del token_ids[-repeated:]
                break

        content_ids = [value for value in token_ids[1:] if value >= FIRST_CONTENT_TOKEN]
        raw = _decode_tokens(content_ids, self._tokenizer)
        return _post_process(raw), ended_cleanly

    def _adaptive_tensor(self, rgb: np.ndarray) -> np.ndarray:
        input_image = _initial_expression_image(rgb)
        if input_image is None:
            raise RuntimeError("vision preprocessing found no expression bounds")

        ratio = 1.0
        width, height = input_image.size
        tensor: np.ndarray | None = None
        input_name = self._resizer.get_inputs()[0].name

        # Match RapidLaTeXOCR's release preprocessing loop: predict a padded
        # width, rescale the original bounded expression, then ask again.
        for _ in range(10):
            height = max(1, int(height * ratio))
            tensor, padded_width = _preprocess_iteration(
                input_image,
                ratio,
                width,
                height,
            )
            output = np.asarray(self._resizer.run(None, {input_name: tensor})[0])
            if output.size == 0 or not np.isfinite(output).all():
                raise RuntimeError("vision resizer returned invalid output")
            predicted_width = (
                int(np.argmax(output.reshape(-1, output.shape[-1])[-1])) + 1
            ) * PAD_DIVISOR
            if predicted_width == padded_width:
                break
            width = predicted_width
            ratio = predicted_width / max(1, padded_width)

        if tensor is None:
            raise RuntimeError("vision preprocessing did not produce a tensor")
        return tensor


def _verify_regular_file(path: Path, expected_size: int, expected_sha256: str) -> None:
    import hashlib
    import os
    import stat

    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_size != expected_size:
        raise RuntimeError(f"vision asset {path.name} has unexpected size or type")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    digest = hashlib.sha256()
    total = 0
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != expected_size:
            raise RuntimeError(f"vision asset {path.name} changed before verification")
        while total < expected_size:
            chunk = os.read(fd, min(1024 * 1024, expected_size - total))
            if not chunk:
                break
            total += len(chunk)
            digest.update(chunk)
    finally:
        os.close(fd)
    after = os.lstat(path)
    if (
        total != expected_size
        or digest.hexdigest() != expected_sha256
        or before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
    ):
        raise RuntimeError(f"vision asset {path.name} failed digest verification")


def _load_tokenizer(path: Path) -> dict[int, str]:
    raw = path.read_text(encoding="utf-8")
    if len(raw) > 128 * 1024:
        raise RuntimeError("vision tokenizer is unexpectedly large")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("vision tokenizer root is invalid")
    model = parsed.get("model")
    if not isinstance(model, dict):
        raise RuntimeError("vision tokenizer model is invalid")
    vocab = model.get("vocab")
    if not isinstance(vocab, dict) or not (4 <= len(vocab) <= 8192):
        raise RuntimeError("vision tokenizer vocabulary is invalid")
    inverse: dict[int, str] = {}
    for token, token_id in vocab.items():
        if (
            not isinstance(token, str)
            or not isinstance(token_id, int)
            or isinstance(token_id, bool)
            or token_id < 0
            or token_id > 65535
            or token_id in inverse
        ):
            raise RuntimeError("vision tokenizer vocabulary contains invalid entries")
        inverse[token_id] = token
    return inverse


def _byte_decoder() -> dict[str, int]:
    values = list(range(ord("!"), ord("~") + 1))
    values += list(range(ord("¡"), ord("¬") + 1))
    values += list(range(ord("®"), ord("ÿ") + 1))
    chars = values[:]
    extra = 0
    for value in range(256):
        if value not in values:
            values.append(value)
            chars.append(256 + extra)
            extra += 1
    return {chr(char): value for value, char in zip(values, chars)}


BYTE_DECODER = _byte_decoder()


def _decode_tokens(token_ids: list[int], vocab: dict[int, str]) -> str:
    pieces: list[str] = []
    for token_id in token_ids:
        token = vocab.get(token_id)
        if token is None:
            return ""
        if token in {"[PAD]", "[BOS]", "[EOS]", "<pad>", "<s>", "</s>", "<unk>"}:
            continue
        pieces.append(token)
    joined = "".join(pieces)
    byte_values = bytearray()
    try:
        for char in joined:
            byte_values.append(BYTE_DECODER[char])
        decoded = byte_values.decode("utf-8", errors="strict")
    except (KeyError, UnicodeDecodeError):
        decoded = joined.replace("Ġ", " ")
    return decoded


def _post_process(value: str) -> str:
    value = value.replace("[EOS]", "").replace("[BOS]", "").replace("[PAD]", "")
    protected = "\uE000"
    value = value.replace("\\ ", protected)
    value = re.sub(
        r"(\\(?:operatorname|mathrm|text|mathbf)\s?\*?\s?\{.*?\})",
        lambda match: match.group(0).replace(" ", ""),
        value,
    )
    noletter = r"[\W_^\d]"
    letter = r"[A-Za-z]"
    while True:
        prior = value
        value = re.sub(f"({noletter})\\s+({noletter})", r"\1\2", value)
        value = re.sub(f"({noletter})\\s+({letter})", r"\1\2", value)
        value = re.sub(f"({letter})\\s+({noletter})", r"\1\2", value)
        if value == prior:
            break
    value = value.replace(protected, "\\ ").strip()
    if any(ord(char) < 0x20 and char not in "\t" for char in value):
        return ""
    return value[:MAX_INTERPRETATION_CHARS]


def _structurally_plausible(value: str) -> bool:
    if not value or len(value) > MAX_INTERPRETATION_CHARS:
        return False
    if value.count("{") != value.count("}") or value.count("[") != value.count("]"):
        return False
    if "\ufffd" in value or "\x00" in value:
        return False
    printable = sum(char.isprintable() for char in value)
    return printable / max(1, len(value)) >= 0.98


def _classify(value: str) -> str:
    if ARROW_PATTERN.search(value):
        return "ARROW"
    if DIAGRAM_RELATION_PATTERN.search(value):
        return "DIAGRAM_RELATION"
    if LABEL_PATTERN.fullmatch(value):
        return "LABEL"
    if EQUATION_PATTERN.search(value):
        return "EQUATION"
    if any(char.isalpha() for char in value):
        return "TEXT"
    return "GENERAL_BOARD_DESCRIPTION"


def _uncertain_observation(message: str) -> dict[str, Any]:
    return {
        "observationKind": "GENERAL_BOARD_DESCRIPTION",
        "interpretation": message,
        "confidence": 0.25,
    }


def _prepare_gray(rgb: np.ndarray) -> np.ndarray | None:
    gray = (
        rgb[..., 0].astype(np.float32) * 0.299
        + rgb[..., 1].astype(np.float32) * 0.587
        + rgb[..., 2].astype(np.float32) * 0.114
    )
    minimum = float(np.min(gray))
    maximum = float(np.max(gray))
    if not math.isfinite(minimum) or not math.isfinite(maximum) or maximum <= minimum:
        return None
    normalized = (gray - minimum) * (255.0 / (maximum - minimum))
    if float(np.mean(normalized)) <= 128.0:
        normalized = 255.0 - normalized

    ink = normalized < 250.0
    ys, xs = np.nonzero(ink)
    if xs.size == 0:
        return None
    x0 = max(0, int(xs.min()) - INK_BORDER)
    y0 = max(0, int(ys.min()) - INK_BORDER)
    x1 = min(normalized.shape[1], int(xs.max()) + 1 + INK_BORDER)
    y1 = min(normalized.shape[0], int(ys.max()) + 1 + INK_BORDER)
    cropped = normalized[y0:y1, x0:x1].astype(np.float32, copy=True)
    if cropped.size == 0:
        return None
    return cropped


def _pad_up(value: int, divisor: int) -> int:
    return ((value + divisor - 1) // divisor) * divisor


def _render_tensor(gray: np.ndarray, width: int, height: int) -> np.ndarray:
    width = min(MAX_MODEL_WIDTH, max(1, width))
    height = min(MAX_MODEL_HEIGHT, max(1, height))
    resized = _resize_bilinear(gray, height, width)
    padded_width = _pad_up(max(width, MIN_MODEL_WIDTH), PAD_DIVISOR)
    padded_height = _pad_up(max(height, MIN_MODEL_HEIGHT), PAD_DIVISOR)
    if padded_width > MAX_MODEL_WIDTH or padded_height > MAX_MODEL_HEIGHT:
        raise RuntimeError("vision preprocessing exceeded model bounds")
    white = (1.0 - NORM_MEAN) / NORM_STD
    tensor = np.full((1, 1, padded_height, padded_width), white, dtype=np.float32)
    tensor[0, 0, :height, :width] = (resized / 255.0 - NORM_MEAN) / NORM_STD
    return tensor


def _resize_bilinear(image: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
    source_h, source_w = image.shape
    if source_h == target_h and source_w == target_w:
        return image.astype(np.float32, copy=True)
    ys = np.linspace(0.0, max(0, source_h - 1), target_h, dtype=np.float32)
    xs = np.linspace(0.0, max(0, source_w - 1), target_w, dtype=np.float32)
    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    y1 = np.minimum(y0 + 1, source_h - 1)
    x1 = np.minimum(x0 + 1, source_w - 1)
    wy = (ys - y0).reshape(-1, 1)
    wx = (xs - x0).reshape(1, -1)
    top = image[y0][:, x0] * (1.0 - wx) + image[y0][:, x1] * wx
    bottom = image[y1][:, x0] * (1.0 - wx) + image[y1][:, x1] * wx
    return (top * (1.0 - wy) + bottom * wy).astype(np.float32)


def _decode_png(data: bytes) -> np.ndarray:
    if not isinstance(data, bytes) or not data or len(data) > MAX_PNG_BYTES:
        raise VisionProtocolError("INVALID_IMAGE")
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise VisionProtocolError("INVALID_IMAGE")

    cursor = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    saw_iend = False
    while cursor + 12 <= len(data):
        length = struct.unpack(">I", data[cursor : cursor + 4])[0]
        chunk_type = data[cursor + 4 : cursor + 8]
        cursor += 8
        if length > MAX_PNG_BYTES or cursor + length + 4 > len(data):
            raise VisionProtocolError("INVALID_IMAGE")
        chunk = data[cursor : cursor + length]
        crc_expected = struct.unpack(">I", data[cursor + length : cursor + length + 4])[0]
        if zlib.crc32(chunk_type + chunk) & 0xFFFFFFFF != crc_expected:
            raise VisionProtocolError("INVALID_IMAGE")
        cursor += length + 4

        if chunk_type == b"IHDR":
            if width is not None or length != 13:
                raise VisionProtocolError("INVALID_IMAGE")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if (
                width < 1
                or height < 1
                or width > MAX_IMAGE_DIMENSION
                or height > MAX_IMAGE_DIMENSION
                or width * height > MAX_IMAGE_PIXELS
                or bit_depth != 8
                or color_type not in {0, 2, 4, 6}
                or compression != 0
                or filtering != 0
                or interlace != 0
            ):
                raise VisionProtocolError("INVALID_IMAGE")
        elif chunk_type == b"IDAT":
            if width is None or len(idat) + len(chunk) > MAX_PNG_BYTES:
                raise VisionProtocolError("INVALID_IMAGE")
            idat.extend(chunk)
        elif chunk_type == b"IEND":
            if length != 0:
                raise VisionProtocolError("INVALID_IMAGE")
            saw_iend = True
            break

    if (
        not saw_iend
        or cursor != len(data)
        or width is None
        or height is None
        or bit_depth != 8
        or color_type is None
        or not idat
    ):
        raise VisionProtocolError("INVALID_IMAGE")

    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color_type]
    stride = width * channels
    expected = height * (stride + 1)
    raw = _bounded_inflate(bytes(idat), expected)
    rows = np.empty((height, stride), dtype=np.uint8)
    prior = np.zeros(stride, dtype=np.uint8)
    offset = 0
    for row_index in range(height):
        filter_type = raw[offset]
        offset += 1
        current = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=offset).copy()
        offset += stride
        _unfilter_row(current, prior, filter_type, channels)
        rows[row_index] = current
        prior = current

    pixels = rows.reshape(height, width, channels)
    if color_type == 0:
        rgb = np.repeat(pixels, 3, axis=2)
    elif color_type == 2:
        rgb = pixels
    elif color_type == 4:
        gray = pixels[..., 0:1].astype(np.float32)
        alpha = pixels[..., 1:2].astype(np.float32) / 255.0
        composite = gray * alpha + 255.0 * (1.0 - alpha)
        rgb = np.repeat(composite.astype(np.uint8), 3, axis=2)
    else:
        alpha = pixels[..., 3:4].astype(np.float32) / 255.0
        rgb = (
            pixels[..., :3].astype(np.float32) * alpha
            + 255.0 * (1.0 - alpha)
        ).astype(np.uint8)
    return rgb


def _bounded_inflate(compressed: bytes, expected: int) -> bytes:
    inflater = zlib.decompressobj()
    output = bytearray()
    pending = compressed
    while pending:
        remaining = expected + 1 - len(output)
        if remaining <= 0:
            raise VisionProtocolError("INVALID_IMAGE")
        piece = inflater.decompress(pending, remaining)
        output.extend(piece)
        pending = inflater.unconsumed_tail
        if not pending:
            break
    remaining = expected + 1 - len(output)
    if remaining <= 0 and not inflater.eof:
        raise VisionProtocolError("INVALID_IMAGE")
    output.extend(inflater.flush(max(1, remaining)))
    if not inflater.eof or inflater.unused_data or len(output) != expected:
        raise VisionProtocolError("INVALID_IMAGE")
    return bytes(output)


def _unfilter_row(
    current: np.ndarray,
    prior: np.ndarray,
    filter_type: int,
    bytes_per_pixel: int,
) -> None:
    if filter_type == 0:
        return
    for index in range(current.size):
        left = int(current[index - bytes_per_pixel]) if index >= bytes_per_pixel else 0
        up = int(prior[index])
        upper_left = int(prior[index - bytes_per_pixel]) if index >= bytes_per_pixel else 0
        value = int(current[index])
        if filter_type == 1:
            predictor = left
        elif filter_type == 2:
            predictor = up
        elif filter_type == 3:
            predictor = (left + up) // 2
        elif filter_type == 4:
            predictor = _paeth(left, up, upper_left)
        else:
            raise VisionProtocolError("INVALID_IMAGE")
        current[index] = (value + predictor) & 0xFF


def _paeth(left: int, up: int, upper_left: int) -> int:
    estimate = left + up - upper_left
    left_distance = abs(estimate - left)
    up_distance = abs(estimate - up)
    upper_left_distance = abs(estimate - upper_left)
    if left_distance <= up_distance and left_distance <= upper_left_distance:
        return left
    if up_distance <= upper_left_distance:
        return up
    return upper_left