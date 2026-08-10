import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationScript = path.join(here, "workspace-migrate.mjs");
const engineCandidates = [
  path.resolve(here, "../../..", "runtime", "engine", "workspace.mjs"),
  path.resolve(here, "../../../..", ".ai-workspace", "engine", "workspace.mjs"),
];
const engineSource = engineCandidates.find((candidate) => fs.existsSync(candidate));
if (!engineSource) throw new Error(`Workspace engine not found in: ${engineCandidates.join(", ")}`);

function runRaw(file, args, cwd) {
  return spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", file, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function run(file, args, cwd) {
  const result = runRaw(file, args, cwd);
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-migrate-"));
  fs.mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "alpha", "README.md"), "# Alpha\n", "utf8");
  fs.writeFileSync(path.join(root, "alpha", ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(path.join(root, "INDEX.md"), "[Alpha](alpha/README.md)\n", "utf8");
  run(engineSource, ["init", "--root", root, "--mode", "greenfield", "--id", "fixture", "--json"], root);
  for (const engineFile of [
    "workspace.mjs",
    "trust-runtime.mjs",
    "verification-runtime.mjs",
    "verifier-capsule-runtime.mjs",
    "verifier-result-runtime.mjs",
  ]) {
    fs.copyFileSync(
      path.join(path.dirname(engineSource), engineFile),
      path.join(root, ".ai-workspace", "engine", engineFile),
    );
  }
  run(engineSource, [
    "register-work-item",
    "--root", root,
    "--id", "wi-alpha",
    "--path", "alpha",
    "--title", "Alpha",
    "--kind", "migration",
    "--context", "fixture",
    "--write",
    "--json",
  ], root);
  run(engineSource, ["rebuild", "--root", root, "--json"], root);
  return root;
}

test("migration is plan-hash guarded, detects drift, preserves IDs and records rollback", () => {
  const root = createWorkspace();
  try {
    const mapping = {
      schema_version: 1,
      id: "move-alpha",
      workspace_id: "fixture",
      target_root: "work",
      preserve_nested_git: true,
      moves: [{ from: "alpha", to: "work/alpha" }],
    };
    fs.writeFileSync(path.join(root, "migration.json"), `${JSON.stringify(mapping, null, 2)}\n`, "utf8");

    const dryPlan = run(migrationScript, [
      "plan",
      "--root", root,
      "--mapping", "migration.json",
      "--output", ".ai-workspace/generated/move-alpha.plan.json",
    ], root);
    assert.equal(dryPlan.dry_run, true);
    assert.equal(dryPlan.apply_ready, true);
    assert.deepEqual(dryPlan.moves[0].nested_git, ["alpha/.git"]);
    assert.deepEqual(dryPlan.rollback_sequence, [{ from: "work/alpha", to: "alpha" }]);
    assert.equal(fs.existsSync(path.join(root, ".ai-workspace", "generated", "move-alpha.plan.json")), false);

    run(migrationScript, [
      "plan",
      "--root", root,
      "--mapping", "migration.json",
      "--output", ".ai-workspace/generated/move-alpha.plan.json",
      "--write",
    ], root);
    const planPath = path.join(root, ".ai-workspace", "generated", "move-alpha.plan.json");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));

    const wrongApproval = runRaw(migrationScript, [
      "apply",
      "--root", root,
      "--plan", ".ai-workspace/generated/move-alpha.plan.json",
      "--approval", "wrong-hash",
    ], root);
    assert.notEqual(wrongApproval.status, 0);
    assert.match(wrongApproval.stderr, /Approval does not match plan hash/);

    fs.appendFileSync(path.join(root, "alpha", "README.md"), "drift\n", "utf8");
    const changedSource = runRaw(migrationScript, [
      "apply",
      "--root", root,
      "--plan", ".ai-workspace/generated/move-alpha.plan.json",
      "--approval", plan.plan_hash,
    ], root);
    assert.notEqual(changedSource.status, 0);
    assert.match(changedSource.stderr, /Source tree precondition changed/);
    assert.equal(fs.existsSync(path.join(root, "alpha")), true);
    assert.equal(fs.existsSync(path.join(root, "work", "alpha")), false);
    fs.writeFileSync(path.join(root, "alpha", "README.md"), "# Alpha\n", "utf8");

    const dryApply = run(migrationScript, [
      "apply",
      "--root", root,
      "--plan", ".ai-workspace/generated/move-alpha.plan.json",
      "--approval", plan.plan_hash,
    ], root);
    assert.equal(dryApply.dry_run, true);
    assert.equal(fs.existsSync(path.join(root, "alpha")), true);

    const applied = run(migrationScript, [
      "apply",
      "--root", root,
      "--plan", ".ai-workspace/generated/move-alpha.plan.json",
      "--approval", plan.plan_hash,
      "--write",
    ], root);
    assert.equal(applied.dry_run, false);
    assert.deepEqual(applied.rollback_sequence, [{ from: "work/alpha", to: "alpha" }]);
    assert.equal(fs.existsSync(path.join(root, "work", "alpha", ".git", "HEAD")), true);
    assert.equal(fs.existsSync(path.join(root, "alpha")), false);

    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "work-items", "wi-alpha.yaml"),
      "utf8",
    ));
    assert.equal(manifest.id, "wi-alpha");
    assert.equal(manifest.path, "work/alpha");
    assert.equal(fs.readFileSync(path.join(root, "INDEX.md"), "utf8"), "[Alpha](./work/alpha/README.md)\n");
    assert.equal(run(engineSource, ["validate", "--root", root, "--json"], root).ok, true);
    assert.equal(run(engineSource, ["audit", "--root", root, "--json"], root).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration planning reports target collisions before apply", () => {
  const root = createWorkspace();
  try {
    fs.mkdirSync(path.join(root, "work", "alpha"), { recursive: true });
    const mapping = {
      schema_version: 1,
      id: "collision",
      workspace_id: "fixture",
      target_root: "work",
      moves: [{ from: "alpha", to: "work/alpha" }],
    };
    fs.writeFileSync(path.join(root, "migration.json"), `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    const result = runRaw(migrationScript, [
      "plan",
      "--root", root,
      "--mapping", "migration.json",
    ], root);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.apply_ready, false);
    assert.match(report.blockers.join("\n"), /Target already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
