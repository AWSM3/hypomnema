import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(here, "workspace.mjs");

function runRaw(root, args, input = undefined) {
  return spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", engine, ...args, "--root", root, ...(args[0] === "verifier-hook" ? [] : ["--json"])],
    { encoding: "utf8", input },
  );
}

function run(root, ...args) {
  const result = runRaw(root, args);
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function requestFile(root) {
  const relative = "verifier-request.json";
  fs.writeFileSync(path.join(root, relative), `${JSON.stringify({
    schema_version: 1,
    claims: [{
      id: "claim-proof",
      claim: "proof exists",
      evidence: [{ path: "proof.txt", start_line: 1, end_line: 1 }],
    }],
  }, null, 2)}\n`, "utf8");
  return relative;
}

function verifierResult(capsulePath, capsuleSha256, capsule) {
  const source = capsule.claims[0].evidence[0];
  return {
    protocol_version: 2,
    agent: "workspace_verifier",
    capsule: { path: capsulePath, sha256: capsuleSha256 },
    status: "ok",
    snapshot: {
      workspace_root: ".",
      canonical_hash_start: capsule.workspace.canonical_hash,
      canonical_hash_end: capsule.workspace.canonical_hash,
      product_state_sha256: capsule.workspace.product_state_sha256,
      stable: true,
    },
    verdict: "supported",
    claims: [{
      claim_id: "claim-proof",
      claim: "proof exists",
      result: "supported",
      evidence: [{ path: source.path, locator: source.locator, sha256: source.sha256 }],
      gaps: [],
    }],
    findings: [],
    checks: [],
    skipped_checks: [],
    unknowns: [],
    risks: [],
    refused_actions: [],
    recommended_next_action: "accept result",
    mutation_attempted: false,
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-verifier-cli-"));
  fs.writeFileSync(path.join(root, "proof.txt"), "proof\n", "utf8");
  run(root, "init", "--mode", "greenfield", "--id", "fixture");
  run(root, "rebuild");
  const canonicalHash = run(root, "validate").canonical_hash;
  const request = requestFile(root);
  const dry = run(root, "verifier-capsule", "--id", "fixture-capsule", "--request", request);
  assert.equal(dry.dry_run, true);
  assert.equal(fs.existsSync(path.join(root, ...dry.capsule.split("/"))), false);
  const written = run(root, "verifier-capsule", "--id", "fixture-capsule", "--request", request, "--write");
  const capsule = JSON.parse(fs.readFileSync(path.join(root, ...written.capsule.split("/")), "utf8"));
  return { root, canonicalHash, written, capsule };
}

test("verifier-capsule dry-runs, writes once, and verifier-check binds the exact capsule", () => {
  const fx = setup();
  try {
    assert.equal(fx.written.dry_run, false);
    assert.equal(fx.written.claims, 1);
    assert.equal(fx.written.evidence_count, 1);

    const resultFile = path.join(fx.root, "verifier-result.json");
    fs.writeFileSync(
      resultFile,
      `${JSON.stringify(verifierResult(fx.written.capsule, fx.written.capsule_sha256, fx.capsule), null, 2)}\n`,
      "utf8",
    );
    const accepted = run(
      fx.root,
      "verifier-check",
      "--file", "verifier-result.json",
      "--capsule", fx.written.capsule,
      "--expected-hash", fx.canonicalHash,
    );
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.valid, true);
    assert.equal(accepted.capsule, fx.written.capsule);
    assert.equal(accepted.capsule_sha256, fx.written.capsule_sha256);

    const overwrite = runRaw(fx.root, [
      "verifier-capsule", "--id", "fixture-capsule", "--request", "verifier-request.json", "--write",
    ]);
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /already exists/);

    const missingBinding = runRaw(fx.root, [
      "verifier-check", "--file", "verifier-result.json", "--expected-hash", fx.canonicalHash,
    ]);
    assert.notEqual(missingBinding.status, 0);
    assert.match(missingBinding.stderr, /requires --capsule/);

    const staleExpected = runRaw(fx.root, [
      "verifier-check", "--file", "verifier-result.json", "--capsule", fx.written.capsule,
      "--expected-hash", "f".repeat(64),
    ]);
    assert.notEqual(staleExpected.status, 0);
    assert.equal(JSON.parse(staleExpected.stdout).accepted, false);

    fs.appendFileSync(path.join(fx.root, "proof.txt"), "changed\n", "utf8");
    const drift = runRaw(fx.root, [
      "verifier-check", "--file", "verifier-result.json", "--capsule", fx.written.capsule,
      "--expected-hash", fx.canonicalHash,
    ]);
    assert.notEqual(drift.status, 0);
    assert.match(drift.stdout, /source file changed after capsule creation/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("verifier-hook accepts current protocol v2 and fails invalid output without retry", () => {
  const fx = setup();
  try {
    const result = verifierResult(fx.written.capsule, fx.written.capsule_sha256, fx.capsule);
    const base = {
      hook_event_name: "SubagentStop",
      agent_id: "fixture-agent",
      agent_type: "workspace_verifier",
      agent_transcript_path: "transcript.jsonl",
      stop_hook_active: false,
      last_assistant_message: JSON.stringify(result),
    };

    const valid = runRaw(fx.root, ["verifier-hook"], JSON.stringify(base));
    assert.equal(valid.status, 0);
    assert.deepEqual(JSON.parse(valid.stdout), { continue: true });

    const invalid = runRaw(
      fx.root,
      ["verifier-hook"],
      JSON.stringify({ ...base, last_assistant_message: "not-json" }),
    );
    assert.equal(invalid.status, 0);
    const payload = JSON.parse(invalid.stdout);
    assert.equal(payload.continue, false);
    assert.equal("decision" in payload, false);
    assert.match(payload.systemMessage, /fallback without retrying/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
