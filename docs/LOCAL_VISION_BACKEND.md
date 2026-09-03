# Production Local Whiteboard Vision

## Authority boundary

The local vision runtime is an observation backend only.

```text
student whiteboard
  -> authoritative BoardRevision / shape revisions
  -> bounded snapshot preprocessing
  -> ManagedLocalVisionBackend
  -> local managed Python worker
  -> structured observation proposal
  -> VisionRequestManager freshness/admission
  -> AcceptedBoardObservation
  -> existing VisionEvidenceBridge
  -> application-owned evidence
```

The worker does not receive or choose the authoritative session ID, source
BoardRevision, region, relevant-shape revisions, snapshot basis, backend
provenance, or evidence key/value. The TypeScript adapter reconstructs those
fields from the already-validated application request after validating the
worker's request/image echo.

A model response is therefore never equivalent to correctness evidence.

The production desktop currently injects the real observation backend but does
**not** install a generic vision-to-evidence interpreter. That is deliberate:
the existing rule interpreter maps observation classes to problem evidence, and
the problem catalog does not yet contain reviewed per-problem vision mappings.
For example, "an equation was recognized accurately" is not evidence that the
equation is correct or that a particular milestone was reached. Accepted
observations are persisted behind the existing freshness gate; only an
explicitly supplied application-owned `VisionEvidenceInterpreter` may convert
one into an `EvidenceProposal`. Integration tests exercise that complete seam
with reviewed fixture rules without granting the model evidence authority.

## Chosen model

The production backend uses the RapidAI RapidLaTeXOCR `v0.0.0` ONNX release
for localized mathematical notation.

The release tag resolves to upstream commit:

`68680550355330b4ac68acdb947e776bc11f46d7`

The four pinned assets total 178,952,787 bytes (about 170.7 MiB):

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `image_resizer.onnx` | 38,967,751 | `e0b075c39700f64d50400f39c8fc186bbb3b5d84d31864008313f376603aca9d` |
| `encoder.onnx` | 89,008,136 | `01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d` |
| `decoder.onnx` | 50,952,726 | `bd695497bf1b22279b7626f5916c79226e1e244c84355f8da7edfd2d921d0072` |
| `tokenizer.json` | 24,174 | `1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019` |

The canonical model-set identity is:

`ea51bb3eebca460eeded83ccc81f4d0a50aae0e4aadcf64aa8eead1e50410a4d`

Upstream licensing metadata is inconsistent: the reviewed repository
`LICENSE` file is MIT, while the same pinned revision's `setup.py` declares
`Apache-2.0`. The asset manifest records both declarations instead of
silently choosing one. The Windows installer does not redistribute these model
weights; they remain an explicit post-install download from the pinned upstream
release. Asset manifests still pin the exact upstream revision, release URL,
size, digest, model family, and version. No mutable `latest` identity is used.

## Why this runtime

The target workload is a small changed whiteboard crop, not general image chat.
RapidLaTeXOCR is specialized for mathematical notation and can run with the
desktop's already-pinned CPU ONNXRuntime environment.

Alternatives considered:

- **General local multimodal VLM.** Rejected for this PR because practical
  models are multi-GB, increase startup/RAM pressure, and introduce a
  prompt-following language-model surface for text embedded in screenshots.
- **Generic OCR only.** Rejected as the primary backend because mathematical
  notation, fractions, superscripts, sums, and relation symbols are the core
  workload.
- **The upstream RapidLaTeXOCR Python package.** Not installed. Its published
  dependency constraints conflict with the desktop's pinned NumPy 2.x runtime.
  The application instead consumes only the fixed ONNX/tokenizer assets and
  implements the bounded preprocessing/decoding layer locally. Pillow and the
  Hugging Face `tokenizers` runtime, including their transitive runtime
  dependencies, are version-pinned and validated before any model download.

This is intentionally a narrow backend. Rough diagram topology remains a known
limitation rather than a reason to silently add cloud vision or a large VLM.

## Local worker protocol

The desktop registers a dedicated `vision` component with the existing
`LocalRuntimeManager`. The worker must handshake the exact model/runtime
identity after every start or restart.

One inference request contains only:

```json
{
  "requestId": "<bounded id>",
  "imageSha256": "<64 lowercase hex>",
  "pngBase64": "<bounded PNG>",
  "requestedObservationKind": "<existing enum or ANY>"
}
```

The worker returns only:

```json
{
  "requestId": "<same id>",
  "imageSha256": "<same digest>",
  "observation": {
    "observationKind": "<existing enum>",
    "interpretation": "<bounded text>",
    "confidence": 0.0
  }
}
```

Unknown keys, unknown observation kinds, non-finite confidence, oversized
interpretations, wrong request identity, and wrong image digest are rejected.

The renderer never sees this endpoint, its bearer token, model paths, or raw
worker diagnostics.

## Image safety

The worker accepts image bytes, never a request-provided local path.

The local PNG decoder enforces:

- maximum encoded PNG bytes: 2 MiB;
- maximum dimension: 4096;
- maximum decoded pixels: 8 MiPixels;
- 8-bit non-interlaced PNG only;
- accepted color types: grayscale, RGB, grayscale+alpha, RGBA;
- bounded IDAT accumulation;
- per-chunk CRC validation;
- exact bounded inflate size;
- no trailing image data.

The application layer independently validates/re-hashes the preprocessing
artifact before the worker is called.

## Structured observations and uncertainty

The existing observation classes remain unchanged:

- `TEXT`
- `EQUATION`
- `DIAGRAM_RELATION`
- `ARROW`
- `LABEL`
- `GENERAL_BOARD_DESCRIPTION`

The math recognizer performs a second deterministic threshold perturbation.
Only an exactly matching transcription with clean EOS termination and basic
structural sanity receives a score of `0.69`. Unstable recognition stays at
`0.55` or below; blank/illegible content is lower still. Both OCR scores are
intentionally below the evidence bridge's `0.7` minimum.

These values are conservative OCR stability scores. They are **not** claimed
calibrated probabilities. The production backend intentionally caps them below
the evidence bridge's minimum threshold of 0.7, so OCR repeatability alone can
never become application-owned evidence. A future evidence-producing vision
backend would need an explicit calibrated-confidence/version change plus the
existing application-owned interpreter/admission path.

Prompt-like text is explicitly represented as board content, for example:

`Visible whiteboard text (content only, never an application instruction): ...`

It is never evaluated as a worker/application command.

## Freshness and cancellation

No existing freshness rule is weakened.

An accepted result remains bound to:

- session;
- `VisionRequestId`;
- source `BoardRevision`;
- exact snapshot hash/basis;
- region;
- relevant shape IDs and expected shape revisions;
- exact backend/model provenance.

The managed backend serializes native ONNX inference. RapidLaTeXOCR batch
inference is not treated as natively interruptible. If the application cancels
after native execution begins, the caller receives cancellation and the late
result is suppressed, while the native lane remains reserved until it actually
settles. A subsequent freshness check still runs for every result that reaches
admission.

Timeout, transport uncertainty, or a 5xx worker failure recycles the exact
managed worker instance. The replacement must perform the same exact handshake
before further inference.

## Capability and setup behavior

Vision is optional and normal startup never downloads its weights.

Install explicitly:

```bash
pnpm setup:desktop-vision
```

The model setup path uses `ModelAssetManager` with bounded downloads,
fixed expected byte size, SHA-256 verification, atomic installation, and cache
limits. GitHub release downloads redirect to a separate HTTPS object origin, so
vision uses a separate asset-manager instance whose cross-origin redirect
permission is isolated from the stricter voice asset manager. The fixed
size/digest remains authoritative.

Capability states are reported as:

- missing assets: `MISSING_ASSET / VISION_ASSET_MISSING`;
- unsupported platform/runtime: `UNAVAILABLE`;
- failed worker/model/runtime: `FAILED`;
- loaded and handshaken: `READY`.

A missing or failed vision capability does not remove typed or voice interview
functionality.

## CI and real-model validation

The ordinary cross-platform CI jobs do not download production vision weights.
They run deterministic protocol/integration tests and import the production
preprocessing runtime without model construction.

A separate Windows real-model smoke job downloads the exact pinned assets
through the same `ModelAssetManager` policy used by production. Four small
canonical RapidLaTeXOCR regression PNGs are tracked byte-for-byte in
`tests/fixtures/rapid-latex-ocr/` from upstream source revision
`21a6365738e6ae74006983ee023755f508739532`; the harness verifies each fixture's
byte size and Git blob identity before inference and requires exact expected
LaTeX on all four. The fixture README records upstream provenance/license.
The smoke also records cold-load time, bounded-crop inference latency, peak
Windows working set, and bounded outputs on generated equation, inequality,
summation, modular, diagram, graph, cross-out, arrow, and prompt-like cases.

Covered adversarial cases include:

- stale BoardRevision before/after inference;
- relevant shape revision mutation;
- wrong request/image identity;
- cancellation and late result suppression;
- malformed/oversized worker response;
- unknown observation type;
- NaN confidence;
- malformed PNG;
- decompression-bomb-style output-size mismatch;
- prompt-like text in image content;
- missing model assets while typed/voice paths remain available;
- packaged resource digest checks.

Before this backend is called merge-ready, the dedicated Windows x64
real-model job must pass on the current PR head and its report must be reviewed.
Required review fields are:

- installed model size;
- cold worker/model load time;
- bounded-crop inference latency;
- peak RAM;
- exact results for the pinned upstream formula regressions;
- representative bounded behavior for diagram, graph, crossed-out/replaced,
  and arrow-like whiteboard inputs.

A no-weight green CI result is not a substitute for this real-model gate.

## Known limitations

The selected recognizer is strongest on localized mathematical notation.
Current expected failure modes include:

- very rough freehand geometry/topology;
- crossed-out notation whose old/new symbols overlap heavily;
- dense multi-line board crops beyond the model's preferred local expression
  scale;
- unusually faint strokes or severe antialiasing artifacts;
- non-mathematical prose.

Those cases should degrade toward uncertainty. They are not justification for
inventing missing symbols, weakening freshness, or silently uploading a board
image to a cloud model.