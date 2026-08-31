import {
  ImageSnapshot,
  VisionImageArtifact,
  assertVisionRasterSource,
  visionRasterIdentity,
  type VisionRasterSource
} from "./types.js";

function assertArrayInput(value: unknown): void {
  if (!Array.isArray(value)) throw new TypeError("Image collection must be an array");
}

function imageDigest(source: VisionRasterSource): string {
  return source.metadata.contentDigest;
}

function imageByteSize(source: VisionRasterSource): number {
  return source.metadata.byteSize;
}

function imageRevision(source: VisionRasterSource): number {
  return source.metadata.sourceRevision;
}

export function exactImagePayloadDuplicate(left: VisionRasterSource, right: VisionRasterSource): boolean {
  assertVisionRasterSource(left);
  assertVisionRasterSource(right);
  if (imageByteSize(left) !== imageByteSize(right) || imageDigest(left) !== imageDigest(right)) return false;
  return left.matchesEncodedBytes(right.readBytes());
}

export function revisionImageProcessingKey(source: VisionRasterSource): string {
  assertVisionRasterSource(source);
  return JSON.stringify([
    imageRevision(source),
    imageIdentity(source)
  ]);
}

export function cropPayloadKey(crop: VisionImageArtifact): string {
  assertVisionRasterSource(crop);
  if (crop.metadata.kind !== "CROP") {
    throw new TypeError("cropPayloadKey requires a crop artifact");
  }
  return crop.metadata.contentDigest;
}

export function sameRevisionAndImage(left: VisionRasterSource, right: VisionRasterSource): boolean {
  return revisionImageProcessingKey(left) === revisionImageProcessingKey(right) && exactImagePayloadDuplicate(left, right);
}

export const MAX_DEDUPLICATION_CANDIDATES = 2048;

export function deduplicateExactImagePayloads<T extends VisionRasterSource>(images: readonly T[]): readonly T[] {
  assertArrayInput(images);
  if (images.length > MAX_DEDUPLICATION_CANDIDATES) {
    throw new RangeError(`At most ${String(MAX_DEDUPLICATION_CANDIDATES)} images may be deduplicated at once`);
  }
  const buckets = new Map<string, T[]>();
  const unique: T[] = [];

  for (const image of images) {
    assertVisionRasterSource(image);
    const key = `${String(image.metadata.byteSize)}:${image.metadata.contentDigest}`;
    const bucket = buckets.get(key) ?? [];
    if (bucket.some((candidate) => exactImagePayloadDuplicate(candidate, image))) continue;
    bucket.push(image);
    buckets.set(key, bucket);
    unique.push(image);
  }

  return Object.freeze(unique);
}

export function sourceSnapshotId(source: VisionRasterSource): string {
  assertVisionRasterSource(source);
  return ImageSnapshot.isValidatedInstance(source) ? source.metadata.snapshotId : source.metadata.sourceSnapshotId;
}

export function imageIdentity(source: VisionRasterSource): string {
  return visionRasterIdentity(source);
}
