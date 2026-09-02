import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [mode = "echo", ...args] = process.argv.slice(2);

function collectStdin(callback) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => callback(Buffer.concat(chunks)));
  process.stdin.resume();
}

function ignoreTermination() {
  process.on("SIGTERM", () => undefined);
  process.on("SIGINT", () => undefined);
}

switch (mode) {
  case "echo":
    collectStdin((input) => {
      process.stdout.write(input, () => process.exit(0));
    });
    break;
  case "crash":
    collectStdin(() => {
      process.stdout.write("private-stdout-value");
      process.stderr.write("private-stderr-value");
      process.exit(7);
    });
    break;
  case "invalid-utf8":
    collectStdin(() => {
      process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd]), () => process.exit(0));
    });
    break;
  case "huge-stdout":
    collectStdin(() => {
      process.stdout.write("x".repeat(Number(args[0] ?? 100_000)));
      process.exit(0);
    });
    break;
  case "huge-stderr":
    collectStdin(() => {
      process.stderr.write("e".repeat(Number(args[0] ?? 100_000)));
      process.exit(0);
    });
    break;
  case "hang":
    ignoreTermination();
    process.stdin.resume();
    setInterval(() => undefined, 1_000);
    break;
  case "tree-hang": {
    ignoreTermination();
    const pidFile = args[0];
    if (!pidFile) throw new Error("pid file required");
    const child = spawn(process.execPath, [import.meta.filename, "hang"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (child.pid === undefined) throw new Error("child pid unavailable");
    writeFileSync(pidFile, String(child.pid), "utf8");
    process.stdin.resume();
    setInterval(() => undefined, 1_000);
    break;
  }
  case "exit-with-tree": {
    const pidFile = args[0];
    if (!pidFile) throw new Error("pid file required");
    const child = spawn(process.execPath, [import.meta.filename, "hang"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (child.pid === undefined) throw new Error("child pid unavailable");
    writeFileSync(pidFile, String(child.pid), "utf8");
    process.exit(0);
    break;
  }
  default:
    throw new Error("unknown supervised-process fixture mode");
}
