"""Disposable local-compute worker using protocol-v1 NDJSON over stdio.

This process owns no application state and never opens the event database. Its
results are proposals that the Node application must validate before any event
can be committed.
"""

from __future__ import annotations

from collections import OrderedDict
import json
import sys
from typing import Any


PROTOCOL_VERSION = 1
WORKER_VERSION = "phase0-python-worker@1"
MAX_CACHE_ENTRIES = 1024
MAX_TEXT_LENGTH = 20_000

Response = dict[str, Any]
_cache: OrderedDict[str, tuple[str, Response]] = OrderedDict()


def _error(request_id: str, code: str, message: str) -> Response:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "type": "WORKER_ERROR",
        "code": code,
        "message": message[:200],
    }


def _valid_request_id(value: object) -> str:
    return value if isinstance(value, str) and value else "request_invalid"


def _strict_keys(value: dict[str, Any], expected: set[str]) -> bool:
    return set(value) == expected


def _handle(value: object) -> tuple[str, Response]:
    if not isinstance(value, dict):
        return "invalid", _error("request_invalid", "INVALID_REQUEST", "Request must be an object")

    request_id = _valid_request_id(value.get("requestId"))
    fingerprint = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    cached = _cache.get(request_id)
    if cached is not None:
        prior_fingerprint, prior_response = cached
        if prior_fingerprint != fingerprint:
            return fingerprint, _error(request_id, "REQUEST_ID_CONFLICT", "RequestId was reused with different content")
        _cache.move_to_end(request_id)
        return fingerprint, prior_response

    if value.get("protocolVersion") != PROTOCOL_VERSION:
        return fingerprint, _error(request_id, "INVALID_REQUEST", "Unsupported protocol version")

    operation = value.get("type")
    if operation == "HEALTH_CHECK":
        if not _strict_keys(value, {"protocolVersion", "requestId", "type"}):
            return fingerprint, _error(request_id, "INVALID_REQUEST", "Health request fields are invalid")
        return fingerprint, {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "type": "HEALTH_RESULT",
            "workerVersion": WORKER_VERSION,
            "capabilities": ["HEALTH_CHECK", "ANALYZE_TRANSCRIPT"],
        }

    if operation == "ANALYZE_TRANSCRIPT":
        if not _strict_keys(value, {"protocolVersion", "requestId", "type", "sourceRevision", "text"}):
            return fingerprint, _error(request_id, "INVALID_REQUEST", "Transcript request fields are invalid")
        source_revision = value.get("sourceRevision")
        text = value.get("text")
        if not isinstance(source_revision, int) or isinstance(source_revision, bool) or source_revision < 0:
            return fingerprint, _error(request_id, "INVALID_REQUEST", "sourceRevision must be a non-negative integer")
        if not isinstance(text, str) or not text or len(text) > MAX_TEXT_LENGTH:
            return fingerprint, _error(request_id, "INVALID_REQUEST", "Transcript text is invalid")
        normalized = " ".join(text.split())
        return fingerprint, {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "type": "TRANSCRIPT_ANALYSIS_RESULT",
            "sourceRevision": source_revision,
            "normalizedText": normalized,
            "tokenCount": len(normalized.split()) if normalized else 0,
        }

    return fingerprint, _error(request_id, "UNSUPPORTED_OPERATION", "Operation is not supported")


def _remember(request_id: str, fingerprint: str, response: Response) -> None:
    if response["type"] == "WORKER_ERROR" and response.get("code") == "REQUEST_ID_CONFLICT":
        return
    _cache[request_id] = (fingerprint, response)
    _cache.move_to_end(request_id)
    while len(_cache) > MAX_CACHE_ENTRIES:
        _cache.popitem(last=False)


def _write(response: Response) -> None:
    sys.stdout.write(json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        try:
            decoded: object = json.loads(line)
        except json.JSONDecodeError:
            _write(_error("request_invalid", "INVALID_REQUEST", "Request is not valid JSON"))
            continue
        try:
            fingerprint, response = _handle(decoded)
        except Exception:
            request_id = _valid_request_id(decoded.get("requestId")) if isinstance(decoded, dict) else "request_invalid"
            fingerprint = "internal-error"
            response = _error(request_id, "INTERNAL_ERROR", "Worker could not complete the request")
        request_id = _valid_request_id(decoded.get("requestId")) if isinstance(decoded, dict) else "request_invalid"
        _remember(request_id, fingerprint, response)
        _write(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
