declare module "pngjs" {
  interface PngImage {
    readonly width: number;
    readonly height: number;
    readonly data: Buffer;
  }

  interface PngReadOptions {
    readonly checkCRC?: boolean;
  }

  interface PngWriteOptions {
    readonly colorType?: number;
    readonly inputColorType?: number;
    readonly bitDepth?: number;
  }

  export const PNG: {
    readonly sync: {
      read(data: Buffer, options?: PngReadOptions): PngImage;
      write(image: PngImage, options?: PngWriteOptions): Buffer;
    };
  };
}
