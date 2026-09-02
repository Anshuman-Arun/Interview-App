import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  case "echo-args":
    collectStdin(() => {
      process.stdout.write(JSON.stringify(args), () => process.exit(0));
    });
    break;
  case "crash":
    collectStdin(() => {
      process.stdout.write("SENSITIVE_STDOUT_SENTINEL");
      process.stderr.write("SENSITIVE_STDERR_SENTINEL");
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
  case "write-forever":
    collectStdin(() => {
      const target = args[0] === "stderr" ? process.stderr : process.stdout;
      const chunk = Buffer.alloc(4_096, args[0] === "stderr" ? 0x65 : 0x78);
      const writeMore = () => {
        while (target.write(chunk)) {
          // Keep filling until backpressure; resume from drain.
        }
      };
      target.on("drain", writeMore);
      writeMore();
      setInterval(() => undefined, 1_000);
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
  case "inspect-isolation": {
    collectStdin(() => {
      const relativeFile = args[0];
      if (!relativeFile) throw new Error("relative file required");
      const home = process.platform === "win32"
        ? process.env.USERPROFILE
        : process.env.HOME;
      if (!home) throw new Error("isolated home unavailable");
      const target = path.join(home, ...relativeFile.split("/"));
      const marker = path.join(home, ".fixture-mutation");
      const payload = {
        home,
        cwd: process.cwd(),
        temp: process.platform === "win32"
          ? process.env.TEMP
          : process.env.TMPDIR,
        configuredContent: readFileSync(target, "utf8"),
        mutationExisted: existsSync(marker),
        supervisorVariablesExisted:
          process.env.INTERVIEW_SUPERVISED_CONFIG !== undefined
          || process.env.INTERVIEW_SUPERVISED_CONFIG_JSON !== undefined
          || process.env.INTERVIEW_SUPERVISED_BOOTSTRAP !== undefined,
        powershellModulePathExisted:
          process.env.PSModulePath !== undefined
      };
      writeFileSync(marker, "created", "utf8");
      process.stdout.write(JSON.stringify(payload), () => process.exit(0));
    });
    break;
  }
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
  case "exit-with-detached-tree": {
    const pidFile = args[0];
    if (!pidFile) throw new Error("pid file required");
    const child = spawn(process.execPath, [import.meta.filename, "hang"], {
      stdio: "ignore",
      windowsHide: true,
      detached: true
    });
    if (child.pid === undefined) throw new Error("child pid unavailable");
    child.unref();
    writeFileSync(pidFile, String(child.pid), "utf8");
    process.exit(0);
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
