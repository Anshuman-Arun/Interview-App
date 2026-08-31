# Vision preprocessing

`packages/vision` prepares bounded, revision-scoped image evidence for future vision providers. It does not perform inference, mutate whiteboard state, update interview state, or make provider calls.

## Supported format

The initial package supports **PNG (`image/png`) only**. Browser and whiteboard integrations can emit PNG snapshots without requiring a native image codec. PNG bytes are signature/header checked, decoded with CRC validation, and actual encoded dimensions are used rather than trusted caller metadata.

## Default validation limits

- maximum encoded snapshot bytes: 16 MiB
- maximum width: 8192 px
- maximum height: 8192 px
- maximum pixels: 32 MiPixels

Callers may lower or explicitly override those limits, but package hard caps are 64 MiB encoded bytes, 16384 px per dimension, and 64 MiPixels. Invalid, malformed, MIME-mismatched, oversized, or caller-dimension-mismatched snapshots fail closed.

Other hard resource ceilings prevent configuration from becoming effectively unbounded: dirty-region planning accepts at most 2048 input regions and 128 MiPixels of configured analysis area; processed outputs are capped at 64 MiB per image and 128 MiB combined tile output; prepared batches are capped at 128 MiB / 128 MiPixels, 256 images, 256 crops-or-tiles, and 1024 candidate inputs.

## Processing model

Validated snapshots retain a caller-supplied `BoardRevision`. Crops, resized images, tiles, and prepared requests preserve that revision and a transform back to original snapshot coordinates.

The package provides:

- SHA-256 byte digests and exact-payload/revision deduplication;
- integer raster geometry, clipping, expansion, intersection, union, and area;
- deterministic dirty-region padding/coalescing with bounded fallback to full-frame analysis;
- strict in-bounds cropping;
- aspect-ratio-preserving deterministic bilinear downscaling with no upscaling;
- deterministic overlapping tiling with a hard caller-supplied tile count;
- provider-neutral request objects with non-serializing in-memory payload references;
- deterministic request budgets for image count, total bytes, total pixels, and crop/tile count;
- cooperative `AbortSignal` cancellation around longer pixel loops;
- diagnostics containing dimensions, byte counts, crop/tile counts, and durations, never raw image bytes.

Dirty-region fallback is explicit. If fragmentation requires full-frame analysis but the full frame itself exceeds the configured area budget, planning fails rather than violating the budget.

Request budgeting supports either fail-closed behavior or an explicit bounded-prefix plan that reports every deferred image identity. It never silently emits an unbounded batch.

## Deferred

This package intentionally does not:

- capture browser screenshots;
- integrate tldraw or modify `packages/whiteboard`;
- call Gemini, OpenAI, local models, or any other provider;
- perform OCR or mathematical interpretation;
- persist images;
- decide whether a revision is current/authoritative;
- update evidence, disclosure, scoring, reasoning, or session state.
