import { boundedArrayLength } from "./array-validation.js";
import {
  ImageSnapshot,
  VisionImageArtifact,
  assertVisionRasterSource,
  visionRasterIdentity,
  type VisionRasterSource
} from "./types.js";

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
  const imageCount = boundedArrayLength(images, MAX_DEDUPLICATION_CANDIDATES, "Image collection");
  const buckets = new Map<string, T[]>();
  const unique: T[] = [];

  for (let index = 0; index < imageCount; index += 1) {
    const image = images[index];
    if (image === undefined) throw new TypeError("Image collection must not contain missing entries");
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
