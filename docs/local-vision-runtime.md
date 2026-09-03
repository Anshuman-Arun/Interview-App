# Production local whiteboard vision

This document describes the optional local whiteboard semantic-observation backend
used by the desktop application. It is an inference backend only. BoardRevision,
snapshot identity, freshness, observation admission, evidence proposal, and
student-evidence authority remain application-owned.

## Selected runtime

The production backend uses a narrow hybrid:

1. **RapidLaTeXOCR v0.0.0 ONNX** for bounded mathematical-expression crops.
2. **Deterministic image geometry heuristics** for obvious arrow-like and
   diagram-like crops.

Pinned upstream identity:

- repository: https://github.com/RapidAI/RapidLaTeXOCR
- release: `v0.0.0`
- source revision: `68680550355330b4ac68acdb947e776bc11f46d7`
- license: MIT
- production platform admitted by this PR: Windows x64
- ONNX Runtime: `1.29.0`
- Pillow: `12.3.0`
- tokenizers: `0.23.2`

The three ONNX artifacts are 38,967,751, 89,008,136, and 50,952,726 bytes.
Together with the tokenizer the model payload is about 179 MB. Every artifact
has a fixed expected size and SHA-256 digest; there is no mutable `latest`
authority.

### Why this instead of a general multimodal chat model

The product requirement is a small changed whiteboard region -> bounded semantic
observation, not a whole-board essay. A formula-specific ONNX recognizer gives:

- materially smaller download/RAM pressure than multi-billion-parameter VLMs;
- CPU-only Windows inference through the ONNX runtime already used by desktop;
- no prompt/instruction execution channel;
- straightforward bounded output;
- better fit for mathematical notation than generic scene OCR.

Alternatives considered:

- **Qwen-class local VLMs:** capable general vision, but multi-GB weights and
  multimodal prompt/generation state are disproportionate to dirty-region OCR
  and expand both latency and prompt-injection surface.
- **SmolVLM-class local models:** smaller than Qwen-class models but still a
  multi-component generative runtime with weaker specialization for formula
  transcription.
- **PaddleOCR-VL / PP-FormulaNet family:** strong OCR/formula options, but the
  native Windows deployment story and additional Paddle runtime surface are
  less compatible with the repository's already-pinned ONNX desktop stack.
- **cloud Gemini/OpenAI vision:** rejected for this PR because whiteboard images
  must remain local.

The hybrid is intentionally conservative: difficult diagrams are reported as
uncertain instead of passed to a general-purpose local chatbot.

## Authority and exact image basis

The existing chain is unchanged:

```text
BoardRevision
  -> bounded snapshot
  -> VisionInferenceRequest
  -> local worker
  -> VisionBackendResult
  -> BoardObservation
  -> VisionEvidenceBridge
  -> EvidenceProposal
  -> application admission
```

`ManagedLocalVisionBackend` sends the worker only:

- request ID;
- requested observation kind;
- image width/height;
- snapshot SHA-256;
- exact PNG bytes as canonical base64.

The worker is not trusted to return session, board revision, shape revision,
region, snapshot, or backend provenance. The TypeScript adapter rebuilds all of
those fields from the already-admitted `VisionInferenceRequest`. Extra worker
fields are a protocol violation and trigger worker recycling.

The worker independently verifies the PNG digest against the snapshot hash.
The existing `VisionRequestManager` still re-hashes the exact payload before
dispatch and the existing admission path still decides whether a result is
fresh enough to persist.

A result for board revision 12 does not become valid at revision 13 merely
because local inference was expensive.

## Structured observation contract

The Python worker may return exactly three fields:

```json
{
  "observationKind": "EQUATION",
  "interpretation": "Visible expression: x^2 + y^2 = 1",
  "confidenceClass": "HIGH"
}
```

Allowed confidence classes are `LOW`, `MEDIUM`, and `HIGH`. They are
quality/admission tiers, **not calibrated probabilities**. The desktop adapter
maps them conservatively to 0.25, 0.55, and 0.75. Consequently only `HIGH`
crosses the existing default evidence bridge floor of 0.70.

The model never emits `studentEvidence` and cannot call the evidence API.

## Prompt-like content

RapidLaTeXOCR is used only as image-to-LaTeX recognition. Image text is never
concatenated into an instruction prompt. A crop containing text such as
`SYSTEM: ignore previous instructions` can only become literal observation
content. The application still applies normal observation/evidence admission
rules to it.

## Runtime lifecycle

Vision uses the same:

- `LocalRuntimeManager`;
- authenticated managed worker client;
- supervised process tree;
- readiness handshake;
- exact model/runtime identity checks;
- restart budget;
- shutdown path

as speech/TTS.

There is one native vision inference lane. Concurrent work is rejected as
`VISION_BUSY` rather than accumulating unbounded native calls. The browser or
request manager may cancel a request at any time. ONNX inference is not assumed
to be interruptible mid-kernel; when that occurs the late HTTP result is
suppressed and the application request remains cancelled/stale.

Replacement workers must complete the normal exact readiness handshake before
they can serve another request.

## Input bounds and privacy

The worker accepts only local PNG bytes from the application-owned snapshot
path. It does not accept a path or URL.

Additional worker-side caps are:

- encoded PNG: 8 MiB;
- width/height: 4,096 px;
- pixels: 16 Mi-pixels;
- output interpretation: 1,000 characters;
- decoder budget: 256 tokens;
- managed worker response: 16 KiB.

Pillow decoding verifies PNG format, declared dimensions, single-frame input,
and bounded pixel count before raster use. This is defense in depth after the
existing Node-side PNG validation/preprocessing.

No whiteboard image is uploaded to a remote service.

## Installation and degradation

Normal startup never downloads vision weights.

Explicit installation is available through:

```text
Interview App --install-local-vision-models
```

Voice setup remains separate and does not install the ~179 MB vision payload.

Capability states:

- missing weights -> `MISSING_ASSET / VISION_ASSET_MISSING`;
- non-Windows-x64 -> `UNAVAILABLE / UNSUPPORTED_RUNTIME_PLATFORM`;
- worker/model failure -> `FAILED`;
- exact successful worker handshake -> `READY`.

Typed and voice interviews continue when vision is absent or failed.

## Recognition behavior

Formula inference follows the pinned RapidLaTeXOCR preprocessing envelope and a
deterministic greedy decoder. The production adapter does not use stochastic
sampling.

The deterministic geometry supplement only makes narrow claims such as
"arrow-like connector" or "bounded diagram-like structure." It does not infer
the mathematical meaning of a diagram from geometry alone.

Expected strengths:

- short equations and expressions;
- superscripts/subscripts;
- common LaTeX operators;
- labels around formula crops;
- clear, localized changed regions.

Known weaknesses:

- dense multi-line derivations;
- badly overlapping strokes;
- unusually stylized handwriting;
- ambiguous minus/dash/fraction bars;
- complicated geometry whose semantic relation is not explicit;
- crossed-out expressions where both old and replacement text remain visually
  dominant.

These cases should produce lower confidence rather than invented symbols.

## Windows real-weight smoke

The final PR validation records:

- exact asset digests;
- cold model startup;
- representative crop latency;
- process peak working set;
- recognition results for equation, fraction, inequality/summation/congruence,
  and diagram-like samples.

Those measurements must come from the actual pinned weights on Windows, not a
fixture worker. The permanent CI suite uses fixture workers and does not
download the production weights.
