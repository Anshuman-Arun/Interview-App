import { describe, expect, it } from "vitest";
import {
  SPEECH_ASSETS,
  TTS_ASSETS,
  VISION_ASSETS,
  VISION_WORKER_MODEL_IDENTITY
} from "../apps/desktop/src/runtime/model-assets.js";

describe("desktop production vision asset identity", () => {
  it("pins every vision artifact to immutable Windows x64 identity", () => {
    expect(VISION_ASSETS).toHaveLength(4);
    expect(VISION_ASSETS.map((asset) => asset.manifest.filename).sort()).toEqual([
      "decoder.onnx",
      "encoder.onnx",
      "image_resizer.onnx",
      "tokenizer.json"
    ]);
    expect(VISION_ASSETS.every((asset) =>
      asset.group === "vision"
      && asset.manifest.platform === "win32"
      && asset.manifest.architecture === "x64"
      && asset.manifest.version === "0.0.0"
      && asset.manifest.modelVersion === VISION_WORKER_MODEL_IDENTITY
      && asset.manifest.license?.name === "MIT"
      && asset.manifest.sourceMetadata?.revision
        === "68680550355330b4ac68acdb947e776bc11f46d7"
      && /^[0-9a-f]{64}$/u.test(asset.manifest.sha256)
      && !/^0+$/u.test(asset.manifest.sha256)
      && !asset.manifest.sourceUrl.includes("latest")
    )).toBe(true);
  });

  it("pins exact published byte sizes and digests", () => {
    expect(VISION_ASSETS.map((asset) => ({
      filename: asset.manifest.filename,
      sizeBytes: asset.manifest.sizeBytes,
      sha256: asset.manifest.sha256
    }))).toEqual([
      {
        filename: "image_resizer.onnx",
        sizeBytes: 38_967_751,
        sha256: "e0b075c39700f64d50400f39c8fc186bbb3b5d84d31864008313f376603aca9d"
      },
      {
        filename: "encoder.onnx",
        sizeBytes: 89_008_136,
        sha256: "01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d"
      },
      {
        filename: "decoder.onnx",
        sizeBytes: 50_952_726,
        sha256: "bd695497bf1b22279b7626f5916c79226e1e244c84355f8da7edfd2d921d0072"
      },
      {
        filename: "tokenizer.json",
        sizeBytes: 24_174,
        sha256: "1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019"
      }
    ]);
  });

  it("keeps voice setup groups disjoint from optional vision weights", () => {
    expect(SPEECH_ASSETS.every((asset) => asset.group === "speech")).toBe(true);
    expect(TTS_ASSETS.every((asset) => asset.group === "tts")).toBe(true);
    const voiceIds = new Set([
      ...SPEECH_ASSETS.map((asset) => asset.manifest.artifactId),
      ...TTS_ASSETS.map((asset) => asset.manifest.artifactId)
    ]);
    expect(VISION_ASSETS.some((asset) => voiceIds.has(asset.manifest.artifactId))).toBe(false);
  });
});
