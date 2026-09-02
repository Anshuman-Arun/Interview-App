import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";

const [component = "speech", modelIdentity = "fixture-model-1", behavior = "ready", markerPath] =
  process.argv.slice(2);
if (component !== "speech" && component !== "tts") throw new Error("invalid fixture component");
const token = process.env.INTERVIEW_LOCAL_WORKER_TOKEN;
if (!token || !/^[0-9a-f]{64}$/u.test(token)) throw new Error("fixture token required");

let shuttingDown = false;
let activeTtsRequestId = null;
let activeTtsResponse = null;
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    send(response, 401, { error: "UNAUTHORIZED" });
    return;
  }
  if (behavior === "crash-on-first-request" && markerPath && !existsSync(markerPath)) {
    writeFileSync(markerPath, "crashed", "utf8");
    request.socket.destroy();
    server.close();
    setImmediate(() => process.exit(23));
    return;
  }
  let bytes = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      send(response, 400, { error: "INVALID_JSON" });
      return;
    }
    if (component === "speech" && request.url === "/v1/vad") {
      send(response, 200, { speechProbability: 0.875 });
      return;
    }
    if (component === "speech" && request.url === "/v1/stt") {
      send(response, 200, { text: "fixture transcript", confidence: 0.9 });
      return;
    }
    if (component === "tts" && request.url === "/v1/tts/cancel") {
      const accepted =
        typeof body.requestId === "string"
        && body.requestId === activeTtsRequestId
        && activeTtsResponse !== null;
      const synthesisResponse = activeTtsResponse;
      activeTtsRequestId = null;
      activeTtsResponse = null;
      send(response, 200, { accepted });
      if (accepted && synthesisResponse !== null) {
        setImmediate(() => send(synthesisResponse, 409, { error: "CANCELLED" }));
      }
      return;
    }
    if (component === "tts" && request.url === "/v1/tts") {
      if (behavior === "blocking-tts") {
        activeTtsRequestId = body.requestId ?? null;
        activeTtsResponse = response;
        console.log(`TTS_STARTED:${String(activeTtsRequestId)}`);
        return;
      }
      const samples = new Float32Array([0, 0.05, -0.05, 0]);
      const pcm = Buffer.alloc(samples.length * 4);
      for (let index = 0; index < samples.length; index += 1) {
        pcm.writeFloatLE(samples[index], index * 4);
      }
      send(response, 200, {
        pcmF32Base64: pcm.toString("base64"),
        sampleRate: 24000,
        channels: 1,
        durationMs: samples.length / 24000 * 1000
      });
      return;
    }
    send(response, 404, { error: "NOT_FOUND" });
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  console.log(JSON.stringify({
    ready: true,
    handshake: {
      componentVersion: "1",
      protocolVersion: 1,
      workerType: component,
      runtimeVersion: "fixture-runtime-1",
      modelVersionOrHash: modelIdentity,
      capabilities: component === "speech" ? ["vad", "stt"] : ["tts"],
      metadata: {
        port: address.port
      }
    }
  }));
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!chunk.includes("shutdown") || shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
});
process.stdin.resume();
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

function send(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  response.end(body);
}
