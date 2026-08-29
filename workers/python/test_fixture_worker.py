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
        if mode == "delayed":
            time.sleep(0.25)
        response = response_for(request, wrong_revision=mode == "wrong_revision")
        print(json.dumps(response, separators=(",", ":")), flush=True)
        if mode == "duplicate":
            print(json.dumps(response, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
