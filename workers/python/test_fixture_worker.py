"""Fault-injection worker used only by the Node boundary tests."""

from __future__ import annotations

import json
import sys
import time
from typing import Any


def response_for(request: dict[str, Any], *, wrong_revision: bool = False) -> dict[str, Any]:
    if request["type"] == "HEALTH_CHECK":
        return {
            "protocolVersion": 1,
            "requestId": request["requestId"],
            "type": "HEALTH_RESULT",
            "workerVersion": "test-fixture@1",
            "capabilities": ["HEALTH_CHECK"],
        }
    return {
        "protocolVersion": 1,
        "requestId": request["requestId"],
        "type": "TRANSCRIPT_ANALYSIS_RESULT",
        "sourceRevision": request["sourceRevision"] + (1 if wrong_revision else 0),
        "normalizedText": request["text"],
        "tokenCount": len(request["text"].split()),
    }


def main() -> int:
    mode = sys.argv[1]
    for line in sys.stdin:
        request = json.loads(line)
        if mode == "malformed":
            print("this-is-not-json", flush=True)
            continue
        if mode == "oversized":
            print(json.dumps({"padding": "x" * 4096}), flush=True)
            continue
        if mode == "invalid_utf8":
            sys.stdout.buffer.write(b'"\xff"\n')
            sys.stdout.buffer.flush()
            continue
        if mode == "delayed":
            time.sleep(0.25)
        response = response_for(request, wrong_revision=mode == "wrong_revision")
        encoded = json.dumps(response, separators=(",", ":"))
        if mode == "fragmented":
            midpoint = len(encoded) // 2
            sys.stdout.write(encoded[:midpoint])
            sys.stdout.flush()
            time.sleep(0.01)
            sys.stdout.write(encoded[midpoint:] + "\n")
            sys.stdout.flush()
        else:
            print(encoded, flush=True)
        if mode == "duplicate":
            print(encoded, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
