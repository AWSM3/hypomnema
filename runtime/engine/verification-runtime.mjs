import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  commandFingerprint,
  normalizeExecutionLimits,
  runCommandEvidence,
  validateVerifierResult,
  verifierHookResponse,
} from "./trust-runtime.mjs";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/i;

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableSort(value[key])]),
    );
  }
  return value;
}

function serialize(value) {
  return `${JSON.stringify(stableSort(value), null, 2)}\n`;
}

function assertInside(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} leaves the workspace: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function normalizeRel(root, target) {
  return path.relative(root, target).replaceAll("\\", "/") || ".";
}

function defaultVerificationId(subject, validator) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "z");
  const clean = (value) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const suffix = `-${stamp}-${process.pid}-${nonce}`;
  const prefix = `verify-${clean(subject)}-${clean(validator)}`;
  return `${prefix.slice(0, 128 - suffix.length)}${suffix}`;
}

function sameSnapshot(before, after) {
  return Boolean(
    before
    && after
    && before.kind === after.kind
    && before.path === after.path
    && before.sha256 === after.sha256,
  );
}

export function buildVerificationRequest(root, options) {
  for (const required of ["subject", "validator", "command"]) {
    if (!options[required]) throw new Error(`verify-run requires --${required}`);
  }
  const id = options.id ?? defaultVerificationId(options.subject, options.validator);
  if (!SAFE_ID.test(id)) {
    throw new Error("verify-run --id must contain only letters, digits, dot, underscore, or hyphen");
  }
  const executable = options.command;
  if (process.platform === "win32" && [".bat", ".cmd"].includes(path.extname(executable).toLowerCase())) {
    throw new Error("verify-run rejects .bat/.cmd because validators must run with shell=false");
  }
  const args = Array.isArray(options.arg) ? options.arg : options.arg ? [options.arg] : [];
  const cwd = assertInside(root, path.isAbsolute(options.cwd ?? "")
    ? options.cwd
    : path.join(root, options.cwd ?? "."), "verify-run --cwd");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`verify-run --cwd is not a directory: ${cwd}`);
  }
  const limits = normalizeExecutionLimits({
    timeoutMs: options["timeout-ms"],
    tailBytes: options["tail-bytes"],
  });
  const reportFile = assertInside(
    root,
    path.join(root, ".ai-workspace", "reports", "verifications", `${id}.json`),
    "verify-run report",
  );
  return {
    id,
    subject: options.subject,
    validator: options.validator,
    executable,
    args,
    cwd,
    cwd_relative: normalizeRel(root, cwd),
    timeout_ms: limits.timeoutMs,
    tail_bytes: limits.tailBytes,
    record_argv: options["record-argv"] === true,
    tool_version: options["tool-version"] ?? null,
    command_sha256: commandFingerprint(executable, args),
    report_file: reportFile,
    report_relative: normalizeRel(root, reportFile),
  };
}

export function publicVerificationPlan(request) {
  return {
    id: request.id,
    subject: request.subject,
    validator: request.validator,
    executable: request.executable,
    argv: request.record_argv ? request.args : null,
    argv_recorded: request.record_argv,
    arg_count: request.args.length,
    command_sha256: request.command_sha256,
    cwd: request.cwd_relative,
    timeout_ms: request.timeout_ms,
    tail_bytes: request.tail_bytes,
    report: request.report_relative,
  };
}

export async function runVerificationRequest({
  root,
  request,
  subjectBefore,
  workspaceBefore,
  captureAfter,
}) {
  const commandEvidence = await runCommandEvidence({
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    timeoutMs: request.timeout_ms,
    tailBytes: request.tail_bytes,
    recordArgv: request.record_argv,
    toolVersion: request.tool_version,
  });

  let after = null;
  let captureError = null;
  try {
    after = captureAfter();
  } catch (error) {
    captureError = { name: error.name ?? "Error", message: error.message };
  }
  const subjectStable = sameSnapshot(subjectBefore, after?.subject);
  const workspaceStable = workspaceBefore === after?.workspace;
  const failureReasons = [];
  if (commandEvidence.result !== "passed") failureReasons.push(`command-${commandEvidence.execution.outcome}`);
  if (!subjectStable) failureReasons.push("subject-changed");
  if (!workspaceStable) failureReasons.push("canonical-manifests-changed");
  if (captureError) failureReasons.push("post-run-snapshot-failed");
  const result = failureReasons.length ? "failed" : "passed";
  const reportValue = {
    schema_version: 1,
    kind: "hypomnema-verify-run",
    verification_id: request.id,
    subject: request.subject,
    validator: request.validator,
    result,
    failure_reasons: failureReasons,
    subject_snapshot: {
      before: subjectBefore,
      after: after?.subject ?? null,
      stable: subjectStable,
    },
    workspace_snapshot: {
      canonical_hash_before: workspaceBefore,
      canonical_hash_after: after?.workspace ?? null,
      stable: workspaceStable,
      capture_error: captureError,
    },
    command: commandEvidence.command,
    execution: commandEvidence.execution,
    runtime: commandEvidence.runtime,
    stdout: commandEvidence.stdout,
    stderr: commandEvidence.stderr,
  };

  fs.mkdirSync(path.dirname(request.report_file), { recursive: true });
  fs.writeFileSync(request.report_file, serialize(reportValue), { encoding: "utf8", flag: "wx" });
  return {
    result,
    report: reportValue,
    execution: {
      command_sha256: request.command_sha256,
      command_result: commandEvidence.result,
      outcome: commandEvidence.execution.outcome,
      exit_code: commandEvidence.execution.exit_code,
      signal: commandEvidence.execution.signal,
      timed_out: commandEvidence.execution.timed_out,
      started_at: commandEvidence.execution.started_at,
      finished_at: commandEvidence.execution.finished_at,
      duration_ms: commandEvidence.execution.duration_ms,
      subject_sha256_before: subjectBefore.sha256,
      subject_sha256_after: after?.subject?.sha256 ?? null,
      subject_stable: subjectStable,
      workspace_sha256_before: workspaceBefore,
      workspace_sha256_after: after?.workspace ?? null,
      workspace_stable: workspaceStable,
    },
  };
}

export function parseSingleJson(text, label = "JSON") {
  const normalized = String(text).replace(/^\uFEFF/, "").trim();
  if (!normalized) throw new Error(`${label} is empty`);
  const value = JSON.parse(normalized);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain exactly one JSON object`);
  }
  return value;
}

export function validateVerifierPayload({
  root,
  value,
  expectedCanonicalHash,
  currentCanonicalHash,
  expectedCapsulePath = null,
  expectedCapsuleSha256 = null,
}) {
  const validation = validateVerifierResult({
    root,
    value,
    expectedCanonicalHash,
    expectedCapsulePath,
    expectedCapsuleSha256,
  });
  if (currentCanonicalHash !== expectedCanonicalHash) {
    validation.warnings.push("workspace canonical hash changed before verifier result validation");
    validation.accepted = false;
  }
  return validation;
}

export function verifierHookPayload({ root, input, currentCanonicalHash }) {
  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || input.hook_event_name !== "SubagentStop"
    || input.agent_type !== "workspace_verifier"
  ) {
    return {
      continue: false,
      stopReason: "Hypomnema received malformed SubagentStop input.",
      systemMessage: "Run deterministic main-agent verification fallback.",
    };
  }
  let value;
  let validation;
  try {
    value = parseSingleJson(input.last_assistant_message, "workspace_verifier result");
    validation = validateVerifierPayload({
      root,
      value,
      expectedCanonicalHash: currentCanonicalHash,
      currentCanonicalHash,
    });
  } catch (error) {
    validation = {
      valid: false,
      accepted: false,
      errors: [error.message],
      warnings: [],
      evidence_count: 0,
    };
  }
  return verifierHookResponse(input, validation);
}
