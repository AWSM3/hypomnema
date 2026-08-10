import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;
export const MAX_VERIFY_TIMEOUT_MS = 3_600_000;
export const DEFAULT_TAIL_BYTES = 8_192;
export const MAX_TAIL_BYTES = 65_536;

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function normalizeExecutionLimits(options = {}) {
  return {
    timeoutMs: boundedInteger(
      options.timeoutMs,
      DEFAULT_VERIFY_TIMEOUT_MS,
      1,
      MAX_VERIFY_TIMEOUT_MS,
      "timeout-ms",
    ),
    tailBytes: boundedInteger(
      options.tailBytes,
      DEFAULT_TAIL_BYTES,
      0,
      MAX_TAIL_BYTES,
      "tail-bytes",
    ),
  };
}

export function commandFingerprint(executable, args) {
  return sha256Buffer(Buffer.from(JSON.stringify({ executable, args }), "utf8"));
}

function streamDigest(limit) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let tail = Buffer.alloc(0);
  return {
    update(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(value);
      bytes += value.length;
      if (!limit) return;
      if (value.length >= limit) tail = value.subarray(value.length - limit);
      else tail = Buffer.concat([tail, value]).subarray(-limit);
    },
    finish() {
      return {
        sha256: hash.digest("hex"),
        bytes,
        tail_bytes: tail.length,
        tail_utf8: tail.toString("utf8"),
        truncated: bytes > tail.length,
      };
    },
  };
}

function terminateProcessTree(child) {
  if (!child.pid) return "no-pid";
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    if (result.status === 0) return "taskkill-tree-force";
    try {
      child.kill("SIGKILL");
      return "direct-sigkill-fallback";
    } catch {
      return "termination-failed";
    }
  }
  try {
    process.kill(-child.pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group already exited.
      }
    }, 1_000).unref();
    return "process-group-term-then-kill";
  } catch {
    try {
      child.kill("SIGKILL");
      return "direct-sigkill-fallback";
    } catch {
      return "termination-failed";
    }
  }
}

export async function runCommandEvidence({
  executable,
  args = [],
  cwd,
  timeoutMs,
  tailBytes,
  recordArgv = false,
  toolVersion = null,
}) {
  const limits = normalizeExecutionLimits({ timeoutMs, tailBytes });
  const stdoutDigest = streamDigest(limits.tailBytes);
  const stderrDigest = streamDigest(limits.tailBytes);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let timedOut = false;
  let termination = null;
  let spawnError = null;

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, error });
      return;
    }

    child.stdout?.on("data", (chunk) => stdoutDigest.update(chunk));
    child.stderr?.on("data", (chunk) => stderrDigest.update(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      termination = terminateProcessTree(child);
    }, limits.timeoutMs);
    timeout.unref();

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, error: spawnError });
    });
  });

  const finished = Date.now();
  const executableFile = path.isAbsolute(executable)
    && fs.existsSync(executable)
    && fs.statSync(executable).isFile()
    ? executable
    : null;
  const outcome = timedOut
    ? "timed-out"
    : result.error
      ? "spawn-error"
      : result.signal
        ? "signaled"
        : "exited";
  const passed = outcome === "exited" && result.code === 0;

  return {
    result: passed ? "passed" : "failed",
    command: {
      executable,
      executable_file_sha256: executableFile ? sha256File(executableFile) : null,
      argv: recordArgv ? args : null,
      argv_recorded: recordArgv,
      arg_count: args.length,
      command_sha256: commandFingerprint(executable, args),
    },
    execution: {
      cwd,
      started_at: startedAt,
      finished_at: new Date(finished).toISOString(),
      duration_ms: Math.max(0, finished - started),
      exit_code: Number.isInteger(result.code) ? result.code : null,
      signal: result.signal ?? null,
      timed_out: timedOut,
      termination,
      outcome,
      spawn_error: result.error
        ? { name: result.error.name ?? "Error", code: result.error.code ?? null, message: result.error.message }
        : null,
    },
    runtime: {
      engine: "hypomnema",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      tool_version: toolVersion,
    },
    stdout: stdoutDigest.finish(),
    stderr: stderrDigest.finish(),
  };
}

export { validateVerifierResult, verifierHookResponse } from "./verifier-result-runtime.mjs";
