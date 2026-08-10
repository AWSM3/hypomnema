import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(scriptDir, "install-ai-workspace.mjs");
const bundleRoot = path.resolve(scriptDir, "..");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function runInstaller(target, ...args) {
  const result = spawnSync(process.execPath, [installer, "--target", target, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Installer failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function runEngine(target, ...args) {
  const engine = path.join(target, ".ai-workspace", "engine", "workspace.mjs");
  const result = spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", engine, ...args, "--root", target, "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Engine failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

test("install and update preserve instance-owned work while refreshing product files", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-installer-"));
  try {
    const installed = runInstaller(
      target,
      "--mode", "greenfield",
      "--id", "installer-fixture",
      "--title", "Installer Fixture",
      "--write",
    );
    assert.equal(installed.ok, true);
    assert.equal(installed.product_version, "0.6.0");
    const installedWorkspace = JSON.parse(fs.readFileSync(
      path.join(target, ".ai-workspace", "workspace.yaml"),
      "utf8",
    ));
    assert.equal(installedWorkspace.engine.name, "hypomnema-engine");
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "AGENT_CONTRACT.md")), true);
    assert.equal(fs.existsSync(path.join(target, ".agents", "skills", "workspace-task", "SKILL.md")), true);
    const explorerSource = path.join(bundleRoot, "agents", "workspace_explorer.toml");
    const verifierSource = path.join(bundleRoot, "agents", "workspace_verifier.toml");
    const explorerInstalled = path.join(target, ".codex", "agents", "workspace_explorer.toml");
    const verifierInstalled = path.join(target, ".codex", "agents", "workspace_verifier.toml");
    assert.equal(fs.readFileSync(explorerInstalled, "utf8"), fs.readFileSync(explorerSource, "utf8"));
    assert.equal(fs.readFileSync(verifierInstalled, "utf8"), fs.readFileSync(verifierSource, "utf8"));

    const explorerDefinition = fs.readFileSync(explorerInstalled, "utf8");
    assert.match(explorerDefinition, /^model = "gpt-5\.6-terra"$/m);
    assert.match(explorerDefinition, /^model_reasoning_effort = "medium"$/m);
    assert.match(explorerDefinition, /^sandbox_mode = "read-only"$/m);
    assert.match(explorerDefinition, /^approval_policy = "never"$/m);

    const verifierDefinition = fs.readFileSync(verifierInstalled, "utf8");
    assert.match(verifierDefinition, /^model = "gpt-5\.6-sol"$/m);
    assert.match(verifierDefinition, /^model_reasoning_effort = "medium"$/m);
    assert.match(verifierDefinition, /^sandbox_mode = "read-only"$/m);
    assert.match(verifierDefinition, /^approval_policy = "never"$/m);
    assert.match(verifierDefinition, /Do not call tools/);
    assert.match(verifierDefinition, /"protocol_version": 2/);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "engine", "workspace.test.mjs")), false);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "engine", "trust-runtime.mjs")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "engine", "verification-runtime.mjs")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "engine", "verifier-capsule-runtime.mjs")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "engine", "verifier-result-runtime.mjs")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "schemas", "verifier-result.schema.json")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "schemas", "verifier-capsule.schema.json")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "schemas", "verifier-capsule-request.schema.json")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "reports", "verifications")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "reports", "verifier-capsules")), true);
    assert.equal(fs.existsSync(path.join(target, ".ai-workspace", "migrations", "README.md")), false);

    const installedVerifyDry = runEngine(
      target,
      "verify-run",
      "--id", "verify-installed-engine",
      "--subject", "workspace",
      "--validator", "installed-node",
      "--command", process.execPath,
      "--arg", "-e",
      "--arg", "process.stdout.write('installed')",
    );
    assert.equal(installedVerifyDry.executed, false);
    const installedReport = path.join(target, ".ai-workspace", "reports", "verifications", "verify-installed-engine.json");
    assert.equal(fs.existsSync(installedReport), false);
    const installedVerify = runEngine(
      target,
      "verify-run",
      "--id", "verify-installed-engine",
      "--subject", "workspace",
      "--validator", "installed-node",
      "--command", process.execPath,
      "--arg", "-e",
      "--arg", "process.stdout.write('installed')",
      "--write",
    );
    assert.equal(installedVerify.result, "passed");
    assert.equal(fs.existsSync(installedReport), true);

    const taskRoot = path.join(target, "work", "oracle-to-postgresql");
    fs.mkdirSync(taskRoot, { recursive: true });
    const artifactFile = path.join(taskRoot, "result.md");
    fs.writeFileSync(artifactFile, "# User artifact\n", "utf8");
    runEngine(
      target,
      "register-work-item",
      "--path", "work/oracle-to-postgresql",
      "--title", "Oracle to PostgreSQL",
      "--kind", "migration",
      "--context", "storage",
      "--write",
    );
    runEngine(target, "rebuild");

    const workspaceFile = path.join(target, ".ai-workspace", "workspace.yaml");
    const manifestFile = path.join(target, ".ai-workspace", "manifests", "work-items", "wi-work-oracle-to-postgresql.yaml");
    const agentsFile = path.join(target, "AGENTS.md");
    fs.appendFileSync(agentsFile, "\n# User extension\n", "utf8");
    const expected = {
      workspace: fs.readFileSync(workspaceFile, "utf8"),
      manifest: fs.readFileSync(manifestFile, "utf8"),
      artifact: fs.readFileSync(artifactFile, "utf8"),
      agents: fs.readFileSync(agentsFile, "utf8"),
      verificationReport: fs.readFileSync(installedReport),
    };

    const installedEngine = path.join(target, ".ai-workspace", "engine", "workspace.mjs");
    fs.writeFileSync(installedEngine, "// stale product copy\n", "utf8");
    fs.writeFileSync(explorerInstalled, "// stale managed agent\n", "utf8");
    const userAgent = path.join(target, ".codex", "agents", "custom_user_agent.toml");
    const userAgentContent = 'name = "custom_user_agent"\n';
    fs.writeFileSync(userAgent, userAgentContent, "utf8");

    const staleAgent = path.join(target, ".codex", "agents", "workspace_retired_reader.toml");
    const staleAgentContent = Buffer.from('name = "workspace_retired_reader"\n', "utf8");
    fs.writeFileSync(staleAgent, staleAgentContent);
    const productStateFile = path.join(target, ".ai-workspace", "product.json");
    const previousProductState = JSON.parse(fs.readFileSync(productStateFile, "utf8"));
    previousProductState.product_name = "ai-native-workspace";
    previousProductState.product_version = "0.3.0";
    previousProductState.managed_files.push({
      component: "subagent",
      path: ".codex/agents/workspace_retired_reader.toml",
      sha256: sha256(staleAgentContent),
    });
    fs.writeFileSync(productStateFile, `${JSON.stringify(previousProductState, null, 2)}\n`, "utf8");

    const dryRun = runInstaller(target, "--update");
    assert.equal(dryRun.dry_run, true);
    assert.equal(
      dryRun.changes.some((change) => change.action === "update-subagent"
        && change.path === ".codex/agents/workspace_explorer.toml"),
      true,
    );
    assert.equal(
      dryRun.changes.some((change) => change.action === "delete-subagent"
        && change.path === ".codex/agents/workspace_retired_reader.toml"),
      true,
    );
    assert.equal(fs.readFileSync(explorerInstalled, "utf8"), "// stale managed agent\n");
    assert.equal(fs.existsSync(staleAgent), true);
    assert.equal(fs.readFileSync(userAgent, "utf8"), userAgentContent);

    const updated = runInstaller(target, "--update", "--write");

    assert.equal(updated.mode, "update");
    assert.equal(updated.preserved.includes("work/**"), true);
    assert.equal(updated.preserved.includes(".ai-workspace/reports"), true);
    assert.equal(fs.readFileSync(workspaceFile, "utf8"), expected.workspace);
    assert.equal(fs.readFileSync(manifestFile, "utf8"), expected.manifest);
    assert.equal(fs.readFileSync(artifactFile, "utf8"), expected.artifact);
    assert.equal(fs.readFileSync(agentsFile, "utf8"), expected.agents);
    assert.deepEqual(fs.readFileSync(installedReport), expected.verificationReport);
    assert.equal(fs.readFileSync(explorerInstalled, "utf8"), fs.readFileSync(explorerSource, "utf8"));
    assert.equal(fs.readFileSync(userAgent, "utf8"), userAgentContent);
    assert.equal(fs.existsSync(staleAgent), false);
    assert.equal(
      fs.readFileSync(installedEngine, "utf8"),
      fs.readFileSync(path.join(bundleRoot, "runtime", "engine", "workspace.mjs"), "utf8"),
    );

    const productState = JSON.parse(fs.readFileSync(
      path.join(target, ".ai-workspace", "product.json"),
      "utf8",
    ));
    assert.equal(productState.product_name, "hypomnema");
    assert.equal(productState.product_version, "0.6.0");
    assert.equal(
      productState.managed_files.some((entry) => entry.path === ".agents/skills/workspace-task/SKILL.md"),
      true,
    );
    const managedSubagents = productState.managed_files
      .filter((entry) => entry.component === "subagent")
      .map((entry) => entry.path)
      .sort();
    assert.deepEqual(managedSubagents, [
      ".codex/agents/workspace_explorer.toml",
      ".codex/agents/workspace_verifier.toml",
    ]);

    const idempotent = runInstaller(target, "--update");
    assert.deepEqual(idempotent.changes, []);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
