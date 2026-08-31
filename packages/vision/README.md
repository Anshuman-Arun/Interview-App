# Vision preprocessing

`packages/vision` prepares bounded, revision-scoped image evidence for future vision providers. It does not perform inference, mutate whiteboard state, update interview state, or make provider calls.

## Supported format

The initial package supports a deliberately bounded subset of **PNG (`image/png`)** suitable for browser and whiteboard snapshots:

- static PNG only; APNG control/frame chunks are rejected;
- non-interlaced images only;
- standard PNG compression/filter methods only;
- grayscale, RGB, indexed, grayscale+alpha, and RGBA color types at supported bit depths up to 8 bits per channel;
- no trailing bytes after the terminal `IEND` chunk.

16-bit and interlaced PNGs are intentionally rejected. They are not needed for the expected browser/whiteboard capture path and would expand the decoder working set or enter less-bounded decode paths.

PNG bytes are signature/header checked before decode, chunk structure is bounded, CRC-validating decode is required, and actual encoded dimensions are used instead of caller-declared dimensions. The package uses the pure-JavaScript, zero-dependency `pngjs` codec; no native image library is introduced.

## Validation and resource limits

Default snapshot admission limits:

- maximum encoded snapshot bytes: 16 MiB
- maximum width: 8192 px
- maximum height: 8192 px
- maximum pixels: 32 MiPixels

Callers may lower or explicitly override those limits, but package hard caps are 64 MiB encoded bytes, 16384 px per dimension, and 64 MiPixels. Unknown/misspelled limit keys, malformed inputs, MIME mismatch, unsupported PNG variants, oversized inputs, and caller-dimension mismatches fail closed.

Other hard ceilings prevent downstream configuration from becoming effectively unbounded:

- at most 2048 geometry/dirty-region inputs in one bounded collection;
- at most 128 MiPixels of configured dirty-region analyzed area;
- at most 512 planned tiles;
- at most 128 MiPixels of total tile pixel work, including overlap duplication;
- at most 64 MiB encoded bytes per processed output;
- at most 128 MiB combined encoded tile output;
- at most 2048 candidates in one exact-dedup operation;
- prepared batches capped at 128 MiB, 128 MiPixels, 256 images, 256 crop/tile payloads, and 1024 candidate inputs.

Request budgets may be zero. This lets a caller explicitly prohibit work: fail-closed mode returns a budget error for non-empty work, while bounded-prefix mode returns no requests and reports all work as deferred.

## Snapshot, artifact, and provenance model

A validated snapshot retains:

- caller-supplied snapshot ID and source type;
- caller-supplied branded `BoardRevision`;
- capture time/sequence metadata;
- encoded dimensions/size;
- SHA-256 digest of the actual encoded bytes.

Processed artifacts retain the original source snapshot ID and revision. They also record:

- deterministic artifact identity;
- immediate parent artifact identity when applicable;
- immediate-source `sourceBounds`;
- output dimensions/size/digest;
- a coordinate transform back to original snapshot coordinates.

For a crop or tile, `sourceBounds` are the exact integer bounds within the immediate source image and must equal the crop/tile output dimensions. For a resize, `sourceBounds` are the complete immediate source frame and resize artifacts are forbidden from upscaling.

Byte-level deduplication and processing deduplication are intentionally distinct. Exact-payload utilities identify byte-identical images/crops. Revision-processing keys include full snapshot/artifact identity, so two identical-looking crops at different coordinates are not incorrectly treated as the same processing work.

## Geometry and dirty-region planning

Raster crop/tile rectangles are strict positive-integer rectangles with safe derived edges.

Future whiteboard dirty hints may be fractional or zero-sized. The dirty planner accepts those as finite nonnegative continuous bounds and deterministically rasterizes them outward before clipping/padding. This keeps compatibility with existing whiteboard dirty-region semantics without weakening actual crop geometry.

Dirty-region planning:

1. validates every supplied hint;
2. rasterizes and clips to the image frame;
3. applies configurable integer padding;
4. transitively coalesces overlapping raster regions;
5. enforces region-count and total-area limits;
6. falls back explicitly to full-frame analysis when configured fragmentation/coverage thresholds are exceeded.

Out-of-frame hints do not count toward configured fragmentation fallback. If fallback requires the full frame but the full frame itself violates the configured analyzed-area budget, planning fails instead of silently exceeding the budget.

## Crop, resize, and tile behavior

Cropping is strict: an out-of-bounds crop is rejected rather than silently clipped.

Downscaling:

- never upscales;
- stays inside width, height, and pixel envelopes;
- uses deterministic bilinear resampling;
- uses premultiplied-alpha interpolation to avoid dark halos at transparent edges;
- exposes original and result dimensions;
- retains a transform back to original snapshot coordinates.

Tiling is deterministic with configurable tile width/height, overlap, and maximum tile count. Tile starts advance by exactly `tileSize - overlap`; a final edge tile may therefore be smaller instead of being shifted backward and increasing overlap. Every tile maps back to original snapshot coordinates.

## Provider-neutral request preparation

Prepared image requests contain:

- source revision and source snapshot identity;
- snapshot/crop/resize/tile identity and kind;
- caller-supplied bounded purpose/category;
- dimensions, byte size, and digest;
- coordinate transform;
- an immutable in-memory payload reference.

Payload references derive their identity from the validated raster and do not duplicate the encoded image on construction. JSON serialization exposes metadata only, never raw image bytes. Reading payload bytes returns a defensive copy.

Batch budgeting is deterministic over image count, encoded bytes, pixels, and crop/tile count. It either fails explicitly or returns a bounded prefix plus every deferred image identity; it never silently emits an arbitrarily large batch.

## Cancellation and diagnostics

Longer crop, resize, and tile pixel loops cooperatively observe `AbortSignal`. Cancellation is checked before and after synchronous decoder/encoder boundaries and again before completed results are returned. A synchronous codec call cannot itself be interrupted mid-call, but cancelled work is not published as completed afterward.

Diagnostics contain only safe mechanical metadata such as source/output dimensions, input/output bytes, crop/tile counts, outcome, and duration. Raw image bytes are never included.

## Deferred

This package intentionally does not:

- capture browser screenshots;
- integrate tldraw or modify `packages/whiteboard`;
- call Gemini, OpenAI, local models, or any other provider;
- perform OCR or mathematical interpretation;
- persist images;
- decide whether a revision is current/authoritative;
- update evidence, disclosure, scoring, reasoning, or session state;
- add provider routing or UI.
