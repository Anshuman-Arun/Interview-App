import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [mode = "ready", ...args] = process.argv.slice(2);
const ignoresShutdown = mode === "ignore-shutdown" || mode === "tree-parent-ignore";
let keepAlive = setInterval(() => {}, 1_000);
process.stdin.resume();
process.stdin.on("end", () => {
  if (!ignoresShutdown) process.exit(0);
});
process.on("SIGTERM", () => {
  if (!ignoresShutdown) process.exit(0);
});
process.on("SIGINT", () => {
  if (!ignoresShutdown) process.exit(0);
});

function ready(extra = {}) {
  console.log(JSON.stringify({
    type: "READY",
    componentVersion: "fixture-1",
    protocolVersion: 1,
    capabilities: ["FIXTURE"],
    ...extra
  }));
}

function bumpCounter(path) {
  let value = 0;
  try {
    value = Number.parseInt(readFileSync(path, "utf8"), 10) || 0;
  } catch {
    // Missing counter files start at zero.
  }
  value += 1;
  writeFileSync(path, String(value), "utf8");
  return value;
}

switch (mode) {
  case "ready":
    ready();
    break;
  case "arg-ready":
    ready({ argument: args[0] ?? null });
    break;
  case "delayed-ready":
    setTimeout(() => ready(), Number(args[0] ?? 250));
    break;
  case "delayed-stdin-shutdown":
    setTimeout(() => ready(), Number(args[0] ?? 500));
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (chunk.includes("shutdown-now")) process.exit(0);
    });
    break;
  case "line-ready":
    console.log("READY-LINE");
    break;
  case "unterminated-ready-crash":
    process.stdout.write("READY-LINE", () => {
      clearInterval(keepAlive);
      process.exit(20);
    });
    break;
  case "early-line-ready":
    console.log("READY-LINE");
    for (let index = 0; index < 256; index += 1) console.log(`startup-chatter-${index}`);
    break;
  case "oversized-then-ready":
    console.log("x".repeat(Number(args[0] ?? 10_000)));
    ready();
    break;
  case "invalid-utf8-then-ready":
    process.stdout.write(Buffer.from([0xff, 0x0a]));
    ready();
    break;
  case "crlf-line-ready":
    process.stdout.write("READY-LINE\r\n");
    break;
  case "never-ready":
    console.log("not-ready");
    break;
  case "malformed-ready":
    console.log("{not-json");
    console.log("still-not-json");
    break;
  case "crash":
    console.error("fixture crash");
    clearInterval(keepAlive);
    process.exit(7);
    break;
  case "literal-truncated-crash":
    console.error("[TRUNCATED]");
    clearInterval(keepAlive);
    process.exit(21);
    break;
  case "crash-counter": {
    const path = args[0];
    const failures = Number(args[1] ?? 1);
    if (!path) throw new Error("counter path required");
    const attempt = bumpCounter(path);
    if (attempt <= failures) {
      console.error(`attempt ${attempt} failed`);
      clearInterval(keepAlive);
      process.exit(9);
    }
    ready({ attempt });
    break;
  }
  case "ready-counter": {
    const path = args[0];
    if (!path) throw new Error("counter path required");
    const attempt = bumpCounter(path);
    ready({ attempt });
    break;
  }
  case "always-crash-counter": {
    const path = args[0];
    if (!path) throw new Error("counter path required");
    const attempt = bumpCounter(path);
    console.error(`attempt ${attempt} failed`);
    clearInterval(keepAlive);
    process.exit(11);
    break;
  }
  case "ready-then-crash":
    ready();
    setTimeout(() => {
      console.error("late crash");
      clearInterval(keepAlive);
      process.exit(13);
    }, Number(args[0] ?? 80));
    break;
  case "ready-crash-counter": {
    const path = args[0];
    if (!path) throw new Error("counter path required");
    const attempt = bumpCounter(path);
    ready({ attempt });
    setTimeout(() => {
      console.error(`crash-attempt-${attempt}`);
      clearInterval(keepAlive);
      process.exit(14);
    }, Number(args[1] ?? 50));
    break;
  }
  case "output-env": {
    const secret = process.env.RUNTIME_ONLY_SECRET ?? null;
    for (let index = 0; index < 12; index += 1) console.log(`output-${index}`);
    console.error(`secret-echo=${String(secret)}`);
    console.error("Authorization: Bearer inline-private-token");
    ready({
      publicValue: process.env.EXPLICIT_PUBLIC ?? null,
      secretValue: secret,
      forbiddenValue: process.env.FORBIDDEN_PARENT ?? null,
      inheritedValue: process.env.SAFE_PARENT ?? null
    });
    break;
  }
  case "ignore-shutdown":
    ready();
    break;
  case "tree-parent-ignore": {
    const child = spawn(process.execPath, [import.meta.filename, "ignore-shutdown"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (child.pid === undefined) throw new Error("fixture child did not receive a pid");
    ready({ childPid: child.pid });
    break;
  }
  case "tree-parent-crash": {
    const child = spawn(process.execPath, [import.meta.filename, "ignore-shutdown"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (child.pid === undefined) throw new Error("fixture child did not receive a pid");
    ready({ childPid: child.pid });
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(16);
    }, Number(args[0] ?? 40));
    break;
  }
  case "tree-crash-once-counter": {
    const path = args[0];
    if (!path) throw new Error("counter path required");
    const attempt = bumpCounter(path);
    if (attempt > 1) {
      ready({ attempt });
      break;
    }
    const child = spawn(process.execPath, [import.meta.filename, "ignore-shutdown"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (child.pid === undefined) throw new Error("fixture child did not receive a pid");
    ready({ attempt, childPid: child.pid });
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(17);
    }, Number(args[1] ?? 40));
    break;
  }
  case "delayed-pipe-child":
    setTimeout(() => {
      console.error("delayed-pipe-child-exit");
      clearInterval(keepAlive);
      process.exit(0);
    }, Number(args[0] ?? 250));
    break;
  case "exit-with-pipe-child": {
    const child = spawn(process.execPath, [import.meta.filename, "delayed-pipe-child", args[0] ?? "250"], {
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true
    });
    if (child.pid === undefined) throw new Error("fixture child did not receive a pid");
    ready({ childPid: child.pid });
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(15);
    }, 20);
    break;
  }
  case "exit-with-stubborn-pipe-child": {
    const child = spawn(process.execPath, [import.meta.filename, "ignore-shutdown"], {
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true
    });
    if (child.pid === undefined) throw new Error("fixture child did not receive a pid");
    ready({ childPid: child.pid });
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(18);
    }, Number(args[0] ?? 20));
    break;
  }
  case "stdin-shutdown":
    ready();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (chunk.includes("shutdown-now")) process.exit(0);
    });
    break;
  default:
    throw new Error(`unknown fixture mode ${mode}`);
}
