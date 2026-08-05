import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(here, "workspace.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-integrity-"));
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta"), { recursive: true });
  fs.writeFileSync(path.join(root, "alpha", "README.md"), "# Alpha\n", "utf8");
  fs.writeFileSync(path.join(root, "beta", "note.md"), "# Note\n", "utf8");
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

test("passed verification requires evidence and is bound to the current checksum", () => {
  const root = fixture();
  try {
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

    const noEvidence = runRaw(
      root,
      "record-verification",
      "--id", "verify-no-evidence",
      "--subject", "artifact-alpha",
      "--validator", "fixture-validator",
      "--result", "passed",
      "--write",
    );
    assert.notEqual(noEvidence.status, 0);
    assert.match(noEvidence.stderr, /requires --report or --evidence/);

    run(
      root,
      "record-verification",
      "--id", "verify-alpha",
      "--subject", "artifact-alpha",
      "--validator", "fixture-validator",
      "--result", "passed",
      "--evidence", "fixture-observation",
      "--write",
    );
    const artifactFile = path.join(
      root,
      ".ai-workspace",
      "manifests",
      "artifacts",
      "artifact-alpha.yaml",
    );
    const verificationFile = path.join(
      root,
      ".ai-workspace",
      "manifests",
      "verifications",
      "verify-alpha.yaml",
    );
    let artifact = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
    const verification = JSON.parse(fs.readFileSync(verificationFile, "utf8"));
    assert.equal(verification.subject_sha256, artifact.sha256);

    fs.appendFileSync(path.join(root, "alpha", "README.md"), "changed\n", "utf8");
    const invalid = runRaw(root, "validate");
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout, /checksum drift/);

    const staleVerification = runRaw(
      root,
      "record-verification",
      "--id", "verify-stale",
      "--subject", "artifact-alpha",
      "--validator", "fixture-validator",
      "--result", "passed",
      "--evidence", "fixture-observation",
      "--write",
    );
    assert.notEqual(staleVerification.status, 0);
    assert.match(staleVerification.stderr, /changed after registration/);

    run(root, "refresh", "--id", "artifact-alpha", "--write");
    artifact = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
    assert.equal(artifact.verification_status, "not-verified");
    run(root, "rebuild");
    assert.equal(run(root, "validate").ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("multi-source lineage and produces relations survive orientation and handoff", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    const config = JSON.parse(fs.readFileSync(path.join(root, ".ai-workspace", "workspace.yaml"), "utf8"));
    assert.equal(config.engine.name, "hypomnema-engine");
    run(
      root,
      "register-work-item",
      "--id", "wi-alpha",
      "--path", "alpha",
      "--title", "Alpha",
      "--kind", "research",
      "--context", "fixture",
      "--write",
    );
    run(
      root,
      "register-source",
      "--id", "src-local",
      "--kind", "local-document",
      "--uri", "alpha/README.md",
      "--write",
    );
    run(
      root,
      "register-source",
      "--id", "src-external",
      "--kind", "external-link",
      "--uri", "https://example.test/source",
      "--write",
    );

    const missingOwner = runRaw(
      root,
      "register-artifact",
      "--id", "artifact-rejected",
      "--title", "Rejected",
      "--kind", "markdown-document",
      "--path", "alpha/README.md",
      "--role", "primary-output",
      "--authority", "accepted",
      "--write",
    );
    assert.notEqual(missingOwner.status, 0);
    assert.match(missingOwner.stderr, /requires --work-item/);

    run(
      root,
      "register-artifact",
      "--id", "artifact-primary",
      "--title", "Primary",
      "--kind", "markdown-document",
      "--path", "alpha/README.md",
      "--role", "primary-output",
      "--authority", "accepted",
      "--work-item", "wi-alpha",
      "--source", "src-local",
      "--source", "src-external",
      "--write",
    );
    run(
      root,
      "register-artifact",
      "--id", "artifact-related",
      "--title", "Related",
      "--kind", "markdown-document",
      "--path", "beta/note.md",
      "--role", "supporting-output",
      "--authority", "accepted",
      "--write",
    );
    run(
      root,
      "register-relation",
      "--from", "wi-alpha",
      "--to", "artifact-related",
      "--type", "produces",
      "--write",
    );
    run(
      root,
      "register-decision",
      "--id", "decision-alpha",
      "--title", "Alpha decision",
      "--status", "accepted",
      "--decision", "Keep checksum-bound evidence",
      "--evidence", "src-local",
      "--write",
    );
    run(
      root,
      "register-relation",
      "--from", "wi-alpha",
      "--to", "decision-alpha",
      "--type", "implements",
      "--write",
    );
    run(
      root,
      "record-verification",
      "--id", "verify-primary",
      "--subject", "artifact-primary",
      "--validator", "fixture-validator",
      "--result", "passed",
      "--evidence", "fixture-observation",
      "--write",
    );
    run(
      root,
      "iteration-start",
      "--id", "iter-alpha",
      "--work-item", "wi-alpha",
      "--name", "alpha",
      "--goal", "Preserve context across handoff",
      "--write",
    );

    const primary = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "artifacts", "artifact-primary.yaml"),
      "utf8",
    ));
    assert.deepEqual(primary.sources, ["src-local", "src-external"]);
    const item = run(root, "orient", "--id", "wi-alpha").work_items[0];
    assert.deepEqual(item.artifacts.map((artifact) => artifact.id).sort(), [
      "artifact-primary",
      "artifact-related",
    ]);
    assert.equal(item.verification_records[0].id, "verify-primary");
    assert.equal(item.accepted_decisions[0].id, "decision-alpha");
    assert.equal(item.current_goal, "Preserve context across handoff");

    run(root, "handoff", "--id", "wi-alpha", "--write");
    const handoff = fs.readFileSync(
      path.join(root, ".ai-workspace", "generated", "handoffs", "wi-alpha.md"),
      "utf8",
    );
    for (const heading of [
      "## Goal",
      "## Latest iteration",
      "## Accepted decisions",
      "## Outputs",
      "## Verification evidence",
      "## Unresolved",
      "## Freshness warnings",
      "## Next action",
    ]) assert.match(handoff, new RegExp(heading));
    assert.match(handoff, /artifact-related/);
    assert.match(handoff, /verify-primary/);
    assert.match(handoff, /Preserve context across handoff/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Markdown audit ignores links inside fenced code blocks", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    fs.writeFileSync(
      path.join(root, "beta", "note.md"),
      "# Example\n\n```md\n[illustrative](missing.md)\n```\n\n[real](../alpha/README.md)\n",
      "utf8",
    );
    const audit = run(root, "audit");
    assert.equal(audit.broken_links, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
