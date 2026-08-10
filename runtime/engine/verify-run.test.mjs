import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(here, "workspace.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-verify-run-"));
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta"), { recursive: true });
  fs.writeFileSync(path.join(root, "alpha", "README.md"), "# Alpha\n", "utf8");
  return root;
}

function runRaw(root, ...args) {
  return spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", engine, ...args, "--root", root, "--json"],
    { encoding: "utf8" },
  );
}

function run(root, ...args) {
  const result = runRaw(root, ...args);
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function setupArtifact(root) {
  run(root, "init", "--mode", "greenfield", "--id", "fixture");
  run(
    root,
    "register-artifact",
    "--id", "artifact-alpha",
    "--title", "Alpha",
    "--kind", "markdown-document",
    "--path", "alpha/README.md",
    "--role", "output",
    "--authority", "accepted",
    "--write",
  );
}

function reportFile(root, id) {
  return path.join(root, ".ai-workspace", "reports", "verifications", `${id}.json`);
}

function manifestFile(root, id) {
  return path.join(root, ".ai-workspace", "manifests", "verifications", `${id}.yaml`);
}

test("verify-run dry-run plans without executing or writing", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    const marker = path.join(root, "executed.txt");
    const code = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`;
    const plan = run(
      root,
      "verify-run",
      "--id", "verify-dry-run",
      "--subject", "workspace",
      "--validator", "node-fixture",
      "--command", process.execPath,
      "--arg", "-e",
      "--arg", code,
    );
    assert.equal(plan.dry_run, true);
    assert.equal(plan.executed, false);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(reportFile(root, "verify-dry-run")), false);
    assert.equal(fs.existsSync(manifestFile(root, "verify-dry-run")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verify-run records successful process evidence and executed assurance", () => {
  const root = fixture();
  try {
    setupArtifact(root);
    const code = 'process.stdout.write("abcdefgh");process.stderr.write("warning")';
    const result = run(
      root,
      "verify-run",
      "--id", "verify-success",
      "--subject", "artifact-alpha",
      "--validator", "node-fixture",
      "--command", process.execPath,
      "--arg", "-e",
      "--arg", code,
      "--tail-bytes", "4",
      "--record-argv",
      "--write",
    );
    assert.equal(result.result, "passed");
    assert.equal(result.exit_code, 0);
    assert.equal(result.subject_stable, true);
    assert.equal(result.workspace_stable, true);

    const report = JSON.parse(fs.readFileSync(reportFile(root, "verify-success"), "utf8"));
    assert.equal(report.result, "passed");
    assert.equal(report.stdout.sha256, sha256("abcdefgh"));
    assert.equal(report.stdout.tail_utf8, "efgh");
    assert.equal(report.stdout.truncated, true);
    assert.equal(report.stderr.sha256, sha256("warning"));
    assert.deepEqual(report.command.argv, ["-e", code]);

    const verification = JSON.parse(fs.readFileSync(manifestFile(root, "verify-success"), "utf8"));
    assert.equal(verification.assurance, "executed");
    assert.equal(verification.execution.command_result, "passed");
    assert.equal(verification.execution.exit_code, 0);
    assert.equal(verification.report_sha256, sha256(fs.readFileSync(reportFile(root, "verify-success"))));

    const artifact = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "artifacts", "artifact-alpha.yaml"),
      "utf8",
    ));
    assert.equal(artifact.verification_status, "passed");
    assert.equal(artifact.verification_assurance, "executed");
    run(root, "rebuild");
    assert.equal(run(root, "validate").ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verify-run records non-zero exit and timeout as failed immutable evidence", async (t) => {
  await t.test("non-zero exit", () => {
    const root = fixture();
    try {
      setupArtifact(root);
      const raw = runRaw(
        root,
        "verify-run",
        "--id", "verify-exit-seven",
        "--subject", "artifact-alpha",
        "--validator", "node-fixture",
        "--command", process.execPath,
        "--arg", "-e",
        "--arg", "process.stderr.write('failed');process.exit(7)",
        "--write",
      );
      assert.notEqual(raw.status, 0);
      const output = JSON.parse(raw.stdout);
      assert.equal(output.result, "failed");
      assert.equal(output.exit_code, 7);
      const verification = JSON.parse(fs.readFileSync(manifestFile(root, "verify-exit-seven"), "utf8"));
      assert.equal(verification.result, "failed");
      assert.equal(verification.assurance, "executed");
      assert.equal(verification.execution.exit_code, 7);
      run(root, "rebuild");
      assert.equal(run(root, "validate").ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("timeout", () => {
    const root = fixture();
    try {
      setupArtifact(root);
      const raw = runRaw(
        root,
        "verify-run",
        "--id", "verify-timeout",
        "--subject", "artifact-alpha",
        "--validator", "node-fixture",
        "--command", process.execPath,
        "--arg", "-e",
        "--arg", "setTimeout(() => {}, 5000)",
        "--timeout-ms", "50",
        "--write",
      );
      assert.notEqual(raw.status, 0);
      const output = JSON.parse(raw.stdout);
      assert.equal(output.result, "failed");
      assert.equal(output.timed_out, true);
      const report = JSON.parse(fs.readFileSync(reportFile(root, "verify-timeout"), "utf8"));
      assert.equal(report.execution.timed_out, true);
      assert.equal(report.execution.outcome, "timed-out");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("verify-run cannot pass when the subject changes during validation", () => {
  const root = fixture();
  try {
    setupArtifact(root);
    const target = path.join(root, "alpha", "README.md");
    const code = `require("node:fs").appendFileSync(${JSON.stringify(target)}, "changed\\n")`;
    const raw = runRaw(
      root,
      "verify-run",
      "--id", "verify-subject-change",
      "--subject", "artifact-alpha",
      "--validator", "mutating-fixture",
      "--command", process.execPath,
      "--arg", "-e",
      "--arg", code,
      "--write",
    );
    assert.notEqual(raw.status, 0);
    const output = JSON.parse(raw.stdout);
    assert.equal(output.result, "failed");
    assert.equal(output.exit_code, 0);
    assert.equal(output.subject_stable, false);
    const report = JSON.parse(fs.readFileSync(reportFile(root, "verify-subject-change"), "utf8"));
    assert.deepEqual(report.failure_reasons, ["subject-changed"]);
    const verification = JSON.parse(fs.readFileSync(manifestFile(root, "verify-subject-change"), "utf8"));
    assert.equal(verification.result, "failed");
    assert.equal(verification.execution.command_result, "passed");
    assert.equal(verification.execution.subject_stable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verify-run preserves argv boundaries, cwd, privacy, and report immutability", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    const helper = path.join(root, "beta", "validator.mjs");
    fs.writeFileSync(
      helper,
      `import path from "node:path";\nif (process.cwd() !== ${JSON.stringify(path.join(root, "beta"))}) process.exit(3);\nif (!process.argv.includes("--literal")) process.exit(4);\nprocess.stdout.write("ok");\n`,
      "utf8",
    );
    const result = run(
      root,
      "verify-run",
      "--id", "verify-boundaries",
      "--subject", "workspace",
      "--validator", "node-fixture",
      "--command", process.execPath,
      "--arg", helper,
      "--arg", "--literal",
      "--cwd", "beta",
      "--write",
    );
    assert.equal(result.result, "passed");
    const reportPath = reportFile(root, "verify-boundaries");
    const before = fs.readFileSync(reportPath);
    const report = JSON.parse(before.toString("utf8"));
    assert.equal(report.command.argv, null);
    assert.equal(report.command.argv_recorded, false);
    assert.equal(report.command.arg_count, 2);
    assert.equal(report.execution.cwd, path.join(root, "beta"));

    const marker = path.join(root, "should-not-run.txt");
    const collision = runRaw(
      root,
      "verify-run",
      "--id", "verify-boundaries",
      "--subject", "workspace",
      "--validator", "node-fixture",
      "--command", process.execPath,
      "--arg", "-e",
      "--arg", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`,
      "--write",
    );
    assert.notEqual(collision.status, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readFileSync(reportPath), before);

    const outside = runRaw(
      root,
      "verify-run",
      "--id", "verify-outside",
      "--subject", "workspace",
      "--validator", "node-fixture",
      "--command", process.execPath,
      "--cwd", path.dirname(root),
    );
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /leaves the workspace/);

    if (process.platform === "win32") {
      const cmd = runRaw(
        root,
        "verify-run",
        "--id", "verify-cmd",
        "--subject", "workspace",
        "--validator", "node-fixture",
        "--command", "validator.cmd",
      );
      assert.notEqual(cmd.status, 0);
      assert.match(cmd.stderr, /rejects \.bat\/\.cmd/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
