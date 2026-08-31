import { createHash } from "node:crypto";

export interface VisionArtifactIdentityInput {
  readonly kind: string;
  readonly sourceSnapshotId: string;
  readonly sourceRevision: number;
  readonly sourceImageIdentity: string;
  readonly parentArtifactId: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly sourceBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly coordinateTransform: {
    readonly offsetX: number;
    readonly offsetY: number;
    readonly scaleX: number;
    readonly scaleY: number;
  };
  readonly contentDigest: string;
}

export function computeVisionArtifactId(input: VisionArtifactIdentityInput): string {
  const canonical = JSON.stringify([
    "vision-artifact-v1",
    input.kind,
    input.sourceSnapshotId,
    input.sourceRevision,
    input.sourceImageIdentity,
    input.parentArtifactId ?? null,
    input.width,
    input.height,
    input.sourceBounds.x,
    input.sourceBounds.y,
    input.sourceBounds.width,
    input.sourceBounds.height,
    input.coordinateTransform.offsetX,
    input.coordinateTransform.offsetY,
    input.coordinateTransform.scaleX,
    input.coordinateTransform.scaleY,
    input.contentDigest
  ]);
  return `img_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
