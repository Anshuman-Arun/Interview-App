import { createWriteStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ModelAssetError } from "./types.js";

export interface ArtifactDownloadOptions {
  readonly maxBytes: number;
  readonly expectedBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly allowCrossOriginRedirects: boolean;
  readonly signal: AbortSignal;
}

function parseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ModelAssetError("INVALID_MANIFEST", "Artifact source URL is invalid.", { cause: error });
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username.length > 0
      || parsed.password.length > 0) {
    throw new ModelAssetError("UNSAFE_REDIRECT", "Artifact source must use HTTP(S) without embedded credentials.");
  }
  return parsed;
}

function redirectStatus(statusCode: number | undefined): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function requestClient(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new ModelAssetError("NETWORK_ERROR", "Artifact response has an invalid Content-Length header.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ModelAssetError("NETWORK_ERROR", "Artifact response Content-Length is outside safe bounds.");
  }
  return parsed;
}

async function downloadResponseToFile(
  source: URL,
  destinationPath: string,
  options: ArtifactDownloadOptions,
  redirectCount: number,
  originalOrigin: string
): Promise<number> {
  if (options.signal.aborted) throw new ModelAssetError("CANCELLED", "Artifact download was cancelled.");

  return await new Promise<number>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (error instanceof ModelAssetError) {
        rejectPromise(error);
      } else if (options.signal.aborted) {
        rejectPromise(new ModelAssetError("CANCELLED", "Artifact download was cancelled.", { cause: error }));
      } else {
        rejectPromise(new ModelAssetError("NETWORK_ERROR", "Artifact HTTP request failed.", { cause: error }));
      }
    };

    const request = requestClient(source).get(source, {
      headers: {
        "accept-encoding": "identity",
        "user-agent": "interview-app-model-assets/1"
      },
      signal: options.signal
    }, (response) => {
      void (async () => {
        try {
          if (redirectStatus(response.statusCode)) {
            response.resume();
            const location = response.headers.location;
            if (location === undefined) {
              throw new ModelAssetError("NETWORK_ERROR", "Artifact redirect response is missing a Location header.");
            }
            if (redirectCount >= options.maxRedirects) {
              throw new ModelAssetError("REDIRECT_LIMIT", "Artifact download exceeded the configured redirect limit.");
            }
            const next = parseUrl(new URL(location, source).toString());
            if (source.protocol === "https:" && next.protocol !== "https:") {
              throw new ModelAssetError("UNSAFE_REDIRECT", "HTTPS artifact downloads may not redirect to HTTP.");
            }
            if (!options.allowCrossOriginRedirects && next.origin !== originalOrigin) {
              throw new ModelAssetError("UNSAFE_REDIRECT", "Cross-origin artifact redirect rejected by policy.");
            }
            const result = await downloadResponseToFile(
              next,
              destinationPath,
              options,
              redirectCount + 1,
              originalOrigin
            );
            if (!settled) {
              settled = true;
              resolvePromise(result);
            }
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            throw new ModelAssetError("HTTP_STATUS", "Artifact server returned a non-success status.");
          }

          const contentLengthHeader = Array.isArray(response.headers["content-length"])
            ? response.headers["content-length"][0]
            : response.headers["content-length"];
          const contentLength = parseContentLength(contentLengthHeader);
          if (contentLength !== undefined && contentLength > options.maxBytes) {
            response.destroy();
            throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Artifact response exceeds the configured size limit.");
          }
          if (contentLength !== undefined && contentLength !== options.expectedBytes) {
            response.destroy();
            throw new ModelAssetError("SIZE_MISMATCH", "Artifact response size does not match the manifest.");
          }

          let bytes = 0;
          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.byteLength;
              if (bytes > options.maxBytes) {
                callback(new ModelAssetError("ARTIFACT_TOO_LARGE", "Artifact response exceeds the configured size limit."));
                return;
              }
              if (bytes > options.expectedBytes) {
                callback(new ModelAssetError("SIZE_MISMATCH", "Artifact response exceeded the manifest size."));
                return;
              }
              callback(null, chunk);
            }
          });
          await pipeline(
            response,
            limiter,
            createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
            { signal: options.signal }
          );
          if (bytes !== options.expectedBytes) {
            throw new ModelAssetError("SIZE_MISMATCH", "Downloaded artifact size does not match the manifest.");
          }
          if (!settled) {
            settled = true;
            resolvePromise(bytes);
          }
        } catch (error) {
          settleReject(error);
        }
      })();
    });
    request.once("error", settleReject);
  });
}

export async function downloadHttpArtifact(
  sourceUrl: string,
  destinationPath: string,
  options: ArtifactDownloadOptions
): Promise<number> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0
      || !Number.isSafeInteger(options.expectedBytes) || options.expectedBytes <= 0
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
      || !Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
    throw new ModelAssetError("INVALID_CONFIGURATION", "Artifact download limits are invalid.");
  }
  if (options.expectedBytes > options.maxBytes) {
    throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Manifest artifact size exceeds the configured download limit.");
  }
  if (options.signal.aborted) throw new ModelAssetError("CANCELLED", "Artifact download was cancelled.");

  const source = parseUrl(sourceUrl);
  const controller = new AbortController();
  let timedOut = false;
  const externalAbort = (): void => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("artifact download timeout"));
  }, options.timeoutMs);
  timer.unref?.();

  try {
    return await downloadResponseToFile(source, destinationPath, {
      ...options,
      signal: controller.signal
    }, 0, source.origin);
  } catch (error) {
    if (timedOut) {
      throw new ModelAssetError("DOWNLOAD_TIMEOUT", "Artifact download exceeded the configured timeout.", { cause: error });
    }
    if (options.signal.aborted) {
      throw new ModelAssetError("CANCELLED", "Artifact download was cancelled.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", externalAbort);
  }
}
