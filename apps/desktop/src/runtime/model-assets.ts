import {
  parseAssetManifest,
  type AssetManifest
} from "../../../../packages/model-assets/src/index.js";

export type DesktopVoiceAssetGroup = "speech" | "tts";
export type DesktopRuntimeAssetGroup = DesktopVoiceAssetGroup | "vision";

export interface DesktopRuntimeAsset {
  readonly group: DesktopRuntimeAssetGroup;
  readonly manifest: AssetManifest;
  readonly runtimeRelativePath: string;
}

export const MOONSHINE_ASSET_REVISION = "35d84fc0eb2d7451da9973c990e8a77066abb105";
export const SILERO_SOURCE_REVISION = "7e30209a3e901f9842f81b225f3e93d8199902b1";
export const RAPID_LATEX_OCR_RELEASE_REVISION = "68680550355330b4ac68acdb947e776bc11f46d7";
export const RAPID_LATEX_OCR_MODEL_SET_SHA256 =
  "ea51bb3eebca460eeded83ccc81f4d0a50aae0e4aadcf64aa8eead1e50410a4d";

export const SPEECH_WORKER_MODEL_IDENTITY =
  `moonshine-tiny-en@${MOONSHINE_ASSET_REVISION}+silero-v6.2.1@${SILERO_SOURCE_REVISION}`;
export const TTS_WORKER_MODEL_IDENTITY =
  `kokoro-af-heart+${MOONSHINE_ASSET_REVISION}`;
export const VISION_WORKER_MODEL_IDENTITY =
  `rapid-latex-ocr@v0.0.0+set-${RAPID_LATEX_OCR_MODEL_SET_SHA256}`;

const MOONSHINE_ASSET_REPOSITORY =
  "https://huggingface.co/moonshine-ai/moonshine-voice-assets";
const MOONSHINE_LICENSE = Object.freeze({
  name: "MIT",
  url: "https://github.com/moonshine-ai/moonshine/blob/main/LICENSE"
});
const EN_US_G2P_LICENSE = Object.freeze({
  name: "Mixed CMUdict-derived/Moonshine; see provenance",
  url: "https://github.com/moonshine-ai/moonshine/blob/main/core/moonshine-tts/data/en_us/README.md"
});
const KOKORO_LICENSE = Object.freeze({
  name: "Apache-2.0 (upstream Kokoro assets)",
  url: "https://huggingface.co/hexgrad/Kokoro-82M"
});

function moonshineAsset(input: {
  readonly group: DesktopVoiceAssetGroup;
  readonly artifactId: string;
  readonly familyId: string;
  readonly type: AssetManifest["type"];
  readonly sourcePath: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly runtimeRelativePath: string;
  readonly modelVersion: string;
}): DesktopRuntimeAsset {
  return Object.freeze({
    group: input.group,
    manifest: parseAssetManifest({
      schemaVersion: 1,
      familyId: input.familyId,
      artifactId: input.artifactId,
      version: MOONSHINE_ASSET_REVISION,
      type: input.type,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      sourceUrl: `https://download.moonshine.ai/${input.sourcePath}`,
      modelVersion: input.modelVersion,
      license: input.familyId === "kokoro-en"
        ? KOKORO_LICENSE
        : input.familyId === "moonshine-en-us-g2p"
          ? EN_US_G2P_LICENSE
          : MOONSHINE_LICENSE,
      sourceMetadata: {
        publisher: "Moonshine AI",
        repository: MOONSHINE_ASSET_REPOSITORY,
        revision: MOONSHINE_ASSET_REVISION
      }
    }),
    runtimeRelativePath: input.runtimeRelativePath
  });
}

const SILERO_VAD: DesktopRuntimeAsset = Object.freeze({
  group: "speech",
  manifest: parseAssetManifest({
    schemaVersion: 1,
    familyId: "silero-vad",
    artifactId: "silero-vad-onnx-6.2.1",
    version: "6.2.1",
    type: "MODEL",
    filename: "silero_vad.onnx",
    sizeBytes: 2_327_524,
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    sourceUrl:
      `https://raw.githubusercontent.com/snakers4/silero-vad/${SILERO_SOURCE_REVISION}/src/silero_vad/data/silero_vad.onnx`,
    modelVersion: "silero-vad-6.2.1",
    license: {
      name: "MIT",
      url: "https://github.com/snakers4/silero-vad/blob/v6.2.1/LICENSE"
    },
    sourceMetadata: {
      publisher: "Silero",
      repository: "https://github.com/snakers4/silero-vad",
      revision: SILERO_SOURCE_REVISION
    }
  }),
  runtimeRelativePath: "speech/silero/silero_vad.onnx"
});


const RAPID_LATEX_OCR_LICENSE = Object.freeze({
  // Upstream is internally inconsistent: the repository LICENSE is MIT while
  // setup.py declares Apache-2.0. Record both declarations instead of silently
  // choosing one. The installer does not redistribute these weights.
  name: "MIT repository LICENSE; setup.py declares Apache-2.0",
  url: "https://github.com/RapidAI/RapidLaTeXOCR/blob/68680550355330b4ac68acdb947e776bc11f46d7/LICENSE"
});
const RAPID_LATEX_OCR_RELEASE_URL =
  "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0";

function rapidLatexAsset(input: {
  readonly artifactId: string;
  readonly type: AssetManifest["type"];
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}): DesktopRuntimeAsset {
  return Object.freeze({
    group: "vision",
    manifest: parseAssetManifest({
      schemaVersion: 1,
      familyId: "rapid-latex-ocr",
      artifactId: input.artifactId,
      version: "v0.0.0",
      type: input.type,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      sourceUrl: `${RAPID_LATEX_OCR_RELEASE_URL}/${input.filename}`,
      modelVersion: `rapid-latex-ocr-v0.0.0+${RAPID_LATEX_OCR_MODEL_SET_SHA256}`,
      license: RAPID_LATEX_OCR_LICENSE,
      sourceMetadata: {
        publisher: "RapidAI",
        repository: "https://github.com/RapidAI/RapidLaTeXOCR",
        revision: RAPID_LATEX_OCR_RELEASE_REVISION
      }
    }),
    runtimeRelativePath: `vision/rapid-latex-ocr/${input.filename}`
  });
}

const VISION_MODEL_ASSETS: readonly DesktopRuntimeAsset[] = Object.freeze([
  rapidLatexAsset({
    artifactId: "rapid-latex-ocr-image-resizer-v0.0.0",
    type: "MODEL",
    filename: "image_resizer.onnx",
    sizeBytes: 38_967_751,
    sha256: "e0b075c39700f64d50400f39c8fc186bbb3b5d84d31864008313f376603aca9d"
  }),
  rapidLatexAsset({
    artifactId: "rapid-latex-ocr-encoder-v0.0.0",
    type: "MODEL",
    filename: "encoder.onnx",
    sizeBytes: 89_008_136,
    sha256: "01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d"
  }),
  rapidLatexAsset({
    artifactId: "rapid-latex-ocr-decoder-v0.0.0",
    type: "MODEL",
    filename: "decoder.onnx",
    sizeBytes: 50_952_726,
    sha256: "bd695497bf1b22279b7626f5916c79226e1e244c84355f8da7edfd2d921d0072"
  }),
  rapidLatexAsset({
    artifactId: "rapid-latex-ocr-tokenizer-v0.0.0",
    type: "TOKENIZER",
    filename: "tokenizer.json",
    sizeBytes: 24_174,
    sha256: "1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019"
  })
]);

export const DESKTOP_LOCAL_MODEL_ASSETS: readonly DesktopRuntimeAsset[] = Object.freeze([
  SILERO_VAD,
  moonshineAsset({
    group: "speech",
    familyId: "moonshine-tiny-en",
    artifactId: "moonshine-tiny-en-decoder",
    type: "MODEL",
    sourcePath: "model/tiny-en/quantized/tiny-en/decoder_model_merged.ort",
    filename: "decoder_model_merged.ort",
    sizeBytes: 30_412_256,
    sha256: "cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0",
    runtimeRelativePath: "speech/moonshine/decoder_model_merged.ort",
    modelVersion: "moonshine-tiny-en"
  }),
  moonshineAsset({
    group: "speech",
    familyId: "moonshine-tiny-en",
    artifactId: "moonshine-tiny-en-encoder",
    type: "MODEL",
    sourcePath: "model/tiny-en/quantized/tiny-en/encoder_model.ort",
    filename: "encoder_model.ort",
    sizeBytes: 13_281_600,
    sha256: "94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221",
    runtimeRelativePath: "speech/moonshine/encoder_model.ort",
    modelVersion: "moonshine-tiny-en"
  }),
  moonshineAsset({
    group: "speech",
    familyId: "moonshine-tiny-en",
    artifactId: "moonshine-tiny-en-tokenizer",
    type: "TOKENIZER",
    sourcePath: "model/tiny-en/quantized/tiny-en/tokenizer.bin",
    filename: "tokenizer.bin",
    sizeBytes: 249_974,
    sha256: "6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d",
    runtimeRelativePath: "speech/moonshine/tokenizer.bin",
    modelVersion: "moonshine-tiny-en"
  }),
  moonshineAsset({
    group: "tts",
    familyId: "moonshine-en-us-g2p",
    artifactId: "moonshine-en-us-dict",
    type: "DATA",
    sourcePath: "tts/en_us/dict_filtered_heteronyms.tsv",
    filename: "dict_filtered_heteronyms.tsv",
    sizeBytes: 2_900_453,
    sha256: "8fb0fa0e3ce1a74b864f03c06ace015257660fa2116c6157d11061f4e35bb6b7",
    runtimeRelativePath: "tts/en_us/dict_filtered_heteronyms.tsv",
    modelVersion: "moonshine-en-us-g2p"
  }),
  moonshineAsset({
    group: "tts",
    familyId: "moonshine-en-us-g2p",
    artifactId: "moonshine-en-us-g2p-config",
    type: "CONFIG",
    sourcePath: "tts/en_us/g2p-config.json",
    filename: "g2p-config.json",
    sizeBytes: 60,
    sha256: "f10e652b28c49edd90a94ceb139b94d2368de5814650d81289fcb985fe1ca0f5",
    runtimeRelativePath: "tts/en_us/g2p-config.json",
    modelVersion: "moonshine-en-us-g2p"
  }),
  moonshineAsset({
    group: "tts",
    familyId: "moonshine-en-us-g2p",
    artifactId: "moonshine-en-us-oov-model",
    type: "MODEL",
    sourcePath: "tts/en_us/oov/model.ort",
    filename: "model.ort",
    sizeBytes: 22_143_488,
    sha256: "ef8d07a0577a07617fabf5282d80d680e4e17ad07a763e7e3748417f94554d94",
    runtimeRelativePath: "tts/en_us/oov/model.ort",
    modelVersion: "moonshine-en-us-g2p"
  }),
  moonshineAsset({
    group: "tts",
    familyId: "moonshine-en-us-g2p",
    artifactId: "moonshine-en-us-oov-config",
    type: "CONFIG",
    sourcePath: "tts/en_us/oov/onnx-config.json",
    filename: "onnx-config.json",