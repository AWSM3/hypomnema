#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.join(bundleRoot, "runtime");
const skillsRoot = path.join(bundleRoot, "skills");
const customAgentsRoot = path.join(bundleRoot, "agents");
const versionFile = path.join(bundleRoot, "VERSION");
const rootAgentsTemplate = path.join(bundleRoot, "templates", "AGENTS.md");
const agentContractTemplate = path.join(bundleRoot, "templates", "AI_WORKSPACE_CONTRACT.md");

function parseArgs(argv) {
  const result = { write: false, update: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--write") result.write = true;
    else if (token === "--update") result.update = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      result[key] = value;
      index += 1;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  return result;
}

function normalize(value) {
  return value.split(path.sep).join("/");
}

function walkFiles(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function isInstallableRuntimeFile(source) {
  const rel = normalize(path.relative(runtimeRoot, source));
  return rel === "engine/workspace.mjs"
    || rel === "engine/workspace.ps1"
    || rel.startsWith("schemas/")
    || rel.startsWith("policies/")
    || (rel.startsWith("migrations/") && !rel.toLowerCase().endsWith(".md"));
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const REQUIRED_CUSTOM_AGENT_NAMES = new Set([
  "workspace_explorer",
  "workspace_verifier",
]);

function tomlString(content, key, source) {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]+)"\\s*$`, "m"));
  if (!match) throw new Error(`Custom agent ${source} is missing string field ${key}`);
  return match[1];
}

function validateCustomAgentDefinitions(sources) {
  const names = new Set();
  for (const source of sources) {
    if (path.extname(source).toLowerCase() !== ".toml") {
      throw new Error(`Unsupported file in bundle agents directory: ${source}`);
    }
    const content = fs.readFileSync(source, "utf8");
    const name = tomlString(content, "name", source);
    for (const key of ["description", "model", "model_reasoning_effort"]) {
      tomlString(content, key, source);
    }
    if (tomlString(content, "sandbox_mode", source) !== "read-only") {
      throw new Error(`Custom agent ${name} must default to sandbox_mode = "read-only"`);
    }
    if (tomlString(content, "approval_policy", source) !== "never") {
      throw new Error(`Custom agent ${name} must default to approval_policy = "never"`);
    }
    const marker = 'developer_instructions = """';
    const markerIndex = content.indexOf(marker);
    const trimmed = content.trimEnd();
    if (markerIndex < 0 || !trimmed.endsWith('"""')
      || !trimmed.slice(markerIndex + marker.length, -3).trim()) {
      throw new Error(`Custom agent ${name} has invalid developer_instructions`);
    }
    if (path.basename(source) !== `${name}.toml`) {
      throw new Error(`Custom agent filename must match its name: ${source}`);
    }
    if (names.has(name)) throw new Error(`Duplicate custom agent name: ${name}`);
    names.add(name);
  }
  const actual = [...names].sort();
  const expected = [...REQUIRED_CUSTOM_AGENT_NAMES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Bundle custom agents must be exactly: ${expected.join(", ")}`);
  }
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, target);
}

const options = parseArgs(process.argv.slice(2));
if (!options.target) throw new Error("Required: --target PATH");
if (!fs.existsSync(runtimeRoot)) throw new Error(`Bundle runtime missing: ${runtimeRoot}`);
if (!fs.existsSync(skillsRoot)) throw new Error(`Bundle skills missing: ${skillsRoot}`);
if (!fs.existsSync(customAgentsRoot)) throw new Error(`Bundle agents missing: ${customAgentsRoot}`);
const customAgentSources = walkFiles(customAgentsRoot);
validateCustomAgentDefinitions(customAgentSources);
if (!fs.existsSync(versionFile)) throw new Error(`Bundle VERSION missing: ${versionFile}`);
if (!fs.existsSync(rootAgentsTemplate)) throw new Error(`Root AGENTS template missing: ${rootAgentsTemplate}`);
if (!fs.existsSync(agentContractTemplate)) throw new Error(`Agent contract template missing: ${agentContractTemplate}`);

const productVersion = fs.readFileSync(versionFile, "utf8").trim();
const targetRoot = path.resolve(options.target);
const controlRoot = path.join(targetRoot, ".ai-workspace");
const workspaceFile = path.join(controlRoot, "workspace.yaml");
const productStateFile = path.join(controlRoot, "product.json");
const agentsFile = path.join(targetRoot, "AGENTS.md");
const exists = fs.existsSync(workspaceFile);

if (exists && !options.update) {
  throw new Error("Workspace contract already exists; use --update to update only product-managed files.");
}
if (!exists && options.update) {
  throw new Error("Cannot update: workspace contract does not exist.");
}

const changes = [];
const managedFiles = [];

function planManagedFile(source, target, component, createAction, updateAction) {
  const content = fs.readFileSync(source);
  managedFiles.push({ component, target, content });
  const old = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (!old || !old.equals(content)) {
    changes.push({ action: old ? updateAction : createAction, source, target, content });
  }
}

for (const source of walkFiles(runtimeRoot).filter(isInstallableRuntimeFile)) {
  const rel = path.relative(runtimeRoot, source);
  planManagedFile(
    source,
    path.join(controlRoot, rel),
    "runtime",
    "create-runtime",
    "update-runtime",
  );
}

for (const source of walkFiles(skillsRoot)) {
  const rel = path.relative(skillsRoot, source);
  planManagedFile(
    source,
    path.join(targetRoot, ".agents", "skills", rel),
    "skill",
    "create-skill",
    "update-skill",
  );
}

for (const source of customAgentSources) {
  const rel = path.relative(customAgentsRoot, source);
  planManagedFile(
    source,
    path.join(targetRoot, ".codex", "agents", rel),
    "subagent",
    "create-subagent",
    "update-subagent",
  );
}

planManagedFile(
  agentContractTemplate,
  path.join(controlRoot, "AGENT_CONTRACT.md"),
  "agent-contract",
  "create-agent-contract",
  "update-agent-contract",
);

const previousProductState = fs.existsSync(productStateFile)
  ? fs.readFileSync(productStateFile)
  : null;
let previousProduct = null;
if (previousProductState) {
  try {
    previousProduct = JSON.parse(previousProductState.toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot parse previous product state: ${error.message}`);
  }
}

const currentManagedPaths = new Set(
  managedFiles.map((entry) => normalize(path.relative(targetRoot, entry.target))),
);
for (const entry of previousProduct?.managed_files ?? []) {
  if (entry.component !== "subagent" || currentManagedPaths.has(entry.path)) continue;
  if (typeof entry.path !== "string") {
    throw new Error("Previous subagent product state has an invalid path");
  }
  const installedAgentsRoot = path.resolve(targetRoot, ".codex", "agents");
  const staleTarget = path.resolve(targetRoot, entry.path.split("/").join(path.sep));
  const relativeToAgents = path.relative(installedAgentsRoot, staleTarget);
  if (!relativeToAgents || relativeToAgents.startsWith("..") || path.isAbsolute(relativeToAgents)) {
    throw new Error(`Refusing to delete stale subagent outside .codex/agents: ${entry.path}`);
  }
  if (fs.existsSync(staleTarget)) {
    if (!fs.lstatSync(staleTarget).isFile()) {
      throw new Error(`Refusing to delete non-file stale subagent: ${entry.path}`);
    }
    const staleContent = fs.readFileSync(staleTarget);
    if (typeof entry.sha256 !== "string" || sha256(staleContent) !== entry.sha256) {
      throw new Error(`Refusing to delete modified stale subagent: ${entry.path}`);
    }
    changes.push({ action: "delete-subagent", target: staleTarget, delete: true });
  }
}

const productState = {
  schema_version: 1,
  product_name: "hypomnema",
  product_version: productVersion,
  managed_files: managedFiles
    .map((entry) => ({
      component: entry.component,
      path: normalize(path.relative(targetRoot, entry.target)),
      sha256: sha256(entry.content),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "en")),
};
const productStateContent = Buffer.from(`${JSON.stringify(productState, null, 2)}\n`, "utf8");
if (!previousProductState || !previousProductState.equals(productStateContent)) {
  changes.push({
    action: previousProductState ? "update-product-state" : "create-product-state",
    target: productStateFile,
    content: productStateContent,
  });
}

if (!exists) {
  for (const dir of [
    "manifests/work-items",
    "manifests/sources",
    "manifests/relations",
    "manifests/decisions",
    "manifests/iterations",
    "manifests/artifacts",
    "manifests/verifications",
    "manifests/proposals",
    "state",
    "generated",
    "audit",
  ]) {
    changes.push({ action: "create-directory", target: path.join(controlRoot, dir) });
  }
  const mode = options.mode ?? "brownfield";
  if (!["brownfield", "greenfield"].includes(mode)) throw new Error(`Invalid --mode: ${mode}`);
  const id = options.id ?? path.basename(targetRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const title = options.title ?? path.basename(targetRoot);
  const workspace = {
    contract_version: "0.1",
    engine: {
      entrypoint: ".ai-workspace/engine/workspace.mjs",
      name: "hypomnema-engine",
      runtime: "node>=22",
      version: productVersion
    },
    id,
    manifest_format: "yaml-1.2-json-subset",
    mode,
    registries: {
      canonical: ".ai-workspace/manifests",
      human_index: ".ai-workspace/generated/WORKSPACE_INDEX.md",
      sqlite: ".ai-workspace/state/workspace.sqlite"
    },
    root: ".",
    schema_version: 1,
    title
  };
  changes.push({
    action: "create-contract",
    target: workspaceFile,
    content: Buffer.from(`${JSON.stringify(workspace, null, 2)}\n`, "utf8"),
  });
}

if (!fs.existsSync(agentsFile)) {
  changes.push({
    action: "create-agent-entrypoint",
    target: agentsFile,
    content: fs.readFileSync(rootAgentsTemplate),
  });
}

if (options.write) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const change of changes) {
    if (change.action === "create-directory") fs.mkdirSync(change.target, { recursive: true });
    else if (change.delete) fs.unlinkSync(change.target);
    else atomicWrite(change.target, change.content);
  }
}

let postcheck = null;
if (options.write) {
  const engine = path.join(controlRoot, "engine", "workspace.mjs");
  const rebuild = spawnSync(process.execPath, [engine, "rebuild", "--json"], {
    cwd: targetRoot,
    encoding: "utf8",
  });
  if (rebuild.status !== 0) {
    throw new Error(`Post-install rebuild failed:\n${rebuild.stdout}\n${rebuild.stderr}`);
  }
  const validate = spawnSync(process.execPath, [engine, "validate", "--json"], {
    cwd: targetRoot,
    encoding: "utf8",
  });
  if (validate.status !== 0) {
    throw new Error(`Post-install validation failed:\n${validate.stdout}\n${validate.stderr}`);
  }
  postcheck = {
    rebuild: JSON.parse(rebuild.stdout),
    validate: JSON.parse(validate.stdout),
  };
}

const report = {
  kind: "install-ai-workspace",
  ok: true,
  dry_run: !options.write,
  mode: exists ? "update" : "install",
  product_version: productVersion,
  target: normalize(targetRoot),
  changes: changes.map((change) => ({
    action: change.action,
    path: normalize(path.relative(targetRoot, change.target)),
  })),
  preserved: exists
    ? [
        ".ai-workspace/workspace.yaml",
        ".ai-workspace/manifests",
        ".ai-workspace/audit",
        "AGENTS.md",
        ".codex/agents/*.toml outside product-managed names",
        "work/**",
        "all paths outside product-managed files",
      ]
    : [],
  rebuilt: options.write
    ? [".ai-workspace/state", ".ai-workspace/generated"]
    : [],
  postcheck,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
