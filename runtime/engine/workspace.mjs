#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ENGINE_VERSION = "0.3.0";
const CONTRACT_VERSION = "0.1";
const SCHEMA_VERSION = 1;
const ENTITY_DIRS = {
  "work-item": "work-items",
  source: "sources",
  relation: "relations",
  decision: "decisions",
  artifact: "artifacts",
  iteration: "iterations",
  verification: "verifications",
  proposal: "proposals",
};
const STATUSES = ["unclassified", "active", "waiting", "blocked", "done", "cancelled", "archived"];
const PHASES = ["intake", "research", "decision", "design", "delivery", "verification", "closure"];
const AUTHORITIES = ["draft", "candidate", "in-review", "accepted", "authoritative", "superseded", "reference-only"];
const RELATION_TYPES = [
  "contains", "depends-on", "relates-to", "derived-from", "supersedes",
  "implements", "verifies", "blocks", "produces", "candidate-match",
];
const WORK_ITEM_KINDS = [
  "unclassified", "project", "task", "research", "migration", "release",
  "decision", "document-package", "capability", "experiment", "dependency",
  "reference-corpus",
];
const DEFAULT_EXCLUDES = [
  ".ai-workspace", ".agents", ".codex", ".codex-tmp", ".git", ".idea",
  ".obsidian", ".tmp",
];
const PRODUCT_CHECKOUT_EXCLUDES = [
  "runtime", "scripts", "skills", "templates", "examples", "assets", "agents",
];
const WALK_EXCLUDES = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build", "coverage", "tmp",
]);

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (
      key === "write"
      || key === "json"
      || key === "include-hidden"
      || key === "record"
      || key === "clear-unknowns"
      || key === "full"
    ) {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Для --${key} требуется значение`);
    }
    i += 1;
    if (
      key === "change"
      || key === "evidence"
      || key === "unknown"
      || key === "output"
      || key === "verification"
      || key === "unresolved"
      || key === "decision"
      || key === "option"
      || key === "consequence"
    ) {
      options[key] ??= [];
      options[key].push(value);
    } else {
      options[key] = value;
    }
  }
  return { positional, options };
}

function normalizeRel(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

function singleOption(value, name) {
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) throw new Error(`--${name} должен быть указан один раз`);
  return value[0];
}

function resolveRoot(rootArg) {
  if (rootArg) return path.resolve(rootArg);
  let cursor = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(cursor, ".ai-workspace", "workspace.yaml"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return process.cwd();
    cursor = parent;
  }
}

function control(root) {
  return path.join(root, ".ai-workspace");
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Путь выходит за границы workspace: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

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

function readYamlJson(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${normalizeRel(file)}: MVP поддерживает JSON-совместимое подмножество YAML 1.2: ${error.message}`,
    );
  }
}

function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, content, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    const backup = `${file}.replace-backup-${process.pid}`;
    try {
      if (fs.existsSync(file)) fs.renameSync(file, backup);
      fs.renameSync(temp, file);
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
    } catch (replaceError) {
      if (fs.existsSync(backup) && !fs.existsSync(file)) fs.renameSync(backup, file);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      throw replaceError;
    }
  }
}

function writeJson(file, value) {
  atomicWrite(file, serialize(value));
}

function writeIfMissing(file, value) {
  if (!fs.existsSync(file)) writeJson(file, value);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function slug(value) {
  const result = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, "-")
    .replace(/^-+|-+$/g, "");
  return result || `item-${sha256Buffer(Buffer.from(value)).slice(0, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function today() {
  return nowIso().slice(0, 10);
}

function report(kind, payload, options = {}) {
  const value = { ok: payload.errors?.length ? false : true, kind, ...payload };
  if (options.json) {
    process.stdout.write(serialize(value));
  } else {
    process.stdout.write(`${kind}: ${value.ok ? "OK" : "FAILED"}\n`);
    for (const [key, item] of Object.entries(payload)) {
      if (key === "errors" || key === "warnings") continue;
      if (["string", "number", "boolean"].includes(typeof item)) {
        process.stdout.write(`  ${key}: ${item}\n`);
      }
    }
    for (const warning of payload.warnings ?? []) process.stdout.write(`  WARN: ${warning}\n`);
    for (const error of payload.errors ?? []) process.stdout.write(`  ERROR: ${error}\n`);
  }
  return value;
}

function appendAudit(root, command, changes, status = "applied") {
  const event = {
    schema_version: SCHEMA_VERSION,
    occurred_at: nowIso(),
    command,
    status,
    changes,
    engine_version: ENGINE_VERSION,
  };
  const file = path.join(control(root), "audit", "events.jsonl");
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
}

function workspaceConfig(root) {
  const file = path.join(control(root), "workspace.yaml");
  if (!fs.existsSync(file)) throw new Error(`Workspace не инициализирован: ${file}`);
  return readYamlJson(file);
}

function policy(root, name) {
  return readYamlJson(path.join(control(root), "policies", `${name}.yaml`));
}

function schemaDefinitions() {
  const base = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["schema_version", "id", "entity_type"],
    properties: {
      schema_version: { const: SCHEMA_VERSION },
      id: { type: "string", minLength: 3 },
      entity_type: { type: "string" },
    },
    additionalProperties: true,
  };
  return {
    "workspace.schema.json": {
      $schema: base.$schema,
      type: "object",
      required: ["schema_version", "id", "contract_version", "mode", "engine"],
      properties: {
        schema_version: { const: SCHEMA_VERSION },
        id: { type: "string" },
        contract_version: { type: "string" },
        mode: { enum: ["greenfield", "brownfield"] },
        engine: { type: "object" },
      },
      additionalProperties: true,
    },
    "work-item.schema.json": {
      ...base,
      required: [...base.required, "title", "kind", "context", "path", "status", "phase", "created_at", "updated_at"],
      properties: {
        ...base.properties,
        entity_type: { const: "work-item" },
        title: { type: "string" },
        kind: { enum: WORK_ITEM_KINDS },
        context: { type: "string" },
        path: { type: "string" },
        status: { enum: STATUSES },
        phase: { enum: PHASES },
      },
    },
    "source.schema.json": {
      ...base,
      required: [...base.required, "kind", "uri", "registered_at", "freshness_policy", "authority"],
      properties: {
        ...base.properties,
        entity_type: { const: "source" },
        kind: { type: "string" },
        uri: { type: "string" },
        authority: { enum: AUTHORITIES },
        provenance: { type: "string" },
        unknowns: { type: "array", items: { type: "string" } },
      },
    },
    "relation.schema.json": {
      ...base,
      required: [...base.required, "from", "to", "relation_type"],
      properties: {
        ...base.properties,
        entity_type: { const: "relation" },
        from: { type: "string" },
        to: { type: "string" },
        relation_type: { enum: RELATION_TYPES },
      },
    },
    "decision.schema.json": {
      ...base,
      required: [...base.required, "title", "status", "decision", "evidence"],
      properties: {
        ...base.properties,
        entity_type: { const: "decision" },
        status: { enum: ["proposed", "accepted", "rejected", "superseded"] },
        considered_options: { type: "array", items: { type: "string" } },
        consequences: { type: "array", items: { type: "string" } },
        supersedes: { type: ["string", "null"] },
      },
    },
    "artifact.schema.json": {
      ...base,
      required: [...base.required, "title", "kind", "path", "role", "authority"],
      properties: {
        ...base.properties,
        entity_type: { const: "artifact" },
        authority: { enum: AUTHORITIES },
        confirmed_by: { type: ["string", "null"] },
      },
    },
    "iteration.schema.json": {
      ...base,
      required: [...base.required, "work_item", "name", "goal", "status", "started_at"],
      properties: {
        ...base.properties,
        entity_type: { const: "iteration" },
        status: { enum: ["active", "closed", "cancelled"] },
      },
    },
    "verification.schema.json": {
      ...base,
      required: [...base.required, "subject", "validator", "validator_version", "result", "checked_at"],
      properties: {
        ...base.properties,
        entity_type: { const: "verification" },
        result: { enum: ["passed", "failed", "warning"] },
      },
    },
    "proposal.schema.json": {
      ...base,
      required: [...base.required, "target_type", "target_id", "changes", "reason", "status", "created_at"],
      properties: {
        ...base.properties,
        entity_type: { const: "proposal" },
        status: { enum: ["candidate", "accepted", "rejected"] },
        confidence: { enum: ["high", "medium", "low"] },
        unknowns: { type: "array", items: { type: "string" } },
      },
    },
  };
}

function initWorkspace(root, options) {
  const c = control(root);
  for (const dir of Object.values(ENTITY_DIRS)) ensureDir(path.join(c, "manifests", dir));
  for (const dir of ["policies", "schemas", "migrations", "state", "generated", "audit", "fixtures", "engine"]) {
    ensureDir(path.join(c, dir));
  }
  writeIfMissing(path.join(c, "workspace.yaml"), {
    schema_version: SCHEMA_VERSION,
    id: options.id ?? slug(path.basename(root)),
    title: options.title ?? path.basename(root),
    contract_version: CONTRACT_VERSION,
    mode: options.mode ?? "brownfield",
    root: ".",
    manifest_format: "yaml-1.2-json-subset",
    engine: {
      name: "ai-native-workspace-engine",
      version: ENGINE_VERSION,
      entrypoint: ".ai-workspace/engine/workspace.mjs",
      runtime: "node>=22",
    },
    registries: {
      canonical: ".ai-workspace/manifests",
      sqlite: ".ai-workspace/state/workspace.sqlite",
      human_index: ".ai-workspace/generated/WORKSPACE_INDEX.md",
    },
  });
  writeIfMissing(path.join(c, "policies", "lifecycle.yaml"), {
    schema_version: SCHEMA_VERSION,
    statuses: STATUSES,
    phases: PHASES,
    transitions: {
      unclassified: ["active", "cancelled", "archived"],
      active: ["waiting", "blocked", "done", "cancelled"],
      waiting: ["active", "blocked", "cancelled"],
      blocked: ["active", "waiting", "cancelled"],
      done: ["active", "archived"],
      cancelled: ["active", "archived"],
      archived: ["active"],
    },
  });
  writeIfMissing(path.join(c, "policies", "authority.yaml"), {
    schema_version: SCHEMA_VERSION,
    states: AUTHORITIES,
    authoritative_requires: ["evidence", "human_confirmation_or_accepted_decision"],
  });
  writeIfMissing(path.join(c, "policies", "retention.yaml"), {
    schema_version: SCHEMA_VERSION,
    automatic_delete: false,
    physical_archive_requires_confirmation: true,
    protected_roles: ["input", "authoritative-output", "decision", "verification-evidence"],
  });
  writeIfMissing(path.join(c, "policies", "scan.yaml"), {
    schema_version: SCHEMA_VERSION,
    top_level_exclude: DEFAULT_EXCLUDES,
    recursive_exclude: [...WALK_EXCLUDES].sort(),
    large_directory_mb: 512,
    markdown_link_check: true,
  });
  for (const [name, schema] of Object.entries(schemaDefinitions())) {
    writeIfMissing(path.join(c, "schemas", name), schema);
  }
  writeIfMissing(path.join(c, "migrations", "registry.json"), {
    format_version: 1,
    current_schema_version: SCHEMA_VERSION,
    migrations: [],
  });
  appendAudit(root, "init", [{ action: "initialize-control-plane", path: ".ai-workspace" }]);
  return report("init", { root, mode: options.mode ?? "brownfield", engine_version: ENGINE_VERSION }, options);
}

function walkTree(root, scanPolicy, includeMarkdown = false) {
  const results = {
    files: 0,
    bytes: 0,
    latest_mtime: null,
    nested_git: [],
    caches: [],
    markdown: [],
  };
  const recursiveExcludes = new Set(scanPolicy.recursive_exclude ?? [...WALK_EXCLUDES]);
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          results.nested_git.push(full);
          continue;
        }
        if (recursiveExcludes.has(entry.name)) {
          results.caches.push(full);
          continue;
        }
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      results.files += 1;
      results.bytes += stat.size;
      const mtime = stat.mtime.toISOString();
      if (!results.latest_mtime || mtime > results.latest_mtime) results.latest_mtime = mtime;
      if (entry.name === ".git") results.nested_git.push(full);
      if (includeMarkdown && entry.name.toLowerCase().endsWith(".md")) results.markdown.push(full);
    }
  }
  results.nested_git.sort();
  results.caches.sort();
  results.markdown.sort();
  return results;
}
function isProductCheckout(root) {
  return fs.existsSync(path.join(root, ".codex-plugin", "plugin.json"))
    && fs.existsSync(path.join(root, "scripts", "install-ai-workspace.mjs"))
    && fs.existsSync(path.join(root, "runtime", "engine", "workspace.mjs"))
    && fs.existsSync(path.join(root, "skills", "workspace-task", "SKILL.md"));
}


function scanWorkspace(root, options = {}) {
  const scanPolicy = policy(root, "scan");
  const excluded = new Set(scanPolicy.top_level_exclude ?? DEFAULT_EXCLUDES);
  if (isProductCheckout(root)) {
    for (const entry of PRODUCT_CHECKOUT_EXCLUDES) excluded.add(entry);
  }
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const items = [];
  const excludedEntries = [];
  for (const entry of entries) {
    const rel = normalizeRel(entry.name);
    if (excluded.has(entry.name) || (!options["include-hidden"] && entry.name.startsWith("."))) {
      excludedEntries.push(rel);
      continue;
    }
    const full = path.join(root, entry.name);
    const stats = walkTree(full, scanPolicy);
    items.push({
      path: rel,
      files: stats.files,
      bytes: stats.bytes,
      size_mb: Number((stats.bytes / 1024 / 1024).toFixed(2)),
      latest_mtime: stats.latest_mtime,
      nested_git: stats.nested_git.map((p) => normalizeRel(path.relative(root, p))),
      detected_caches: stats.caches.map((p) => normalizeRel(path.relative(root, p))),
    });
  }
  const payload = {
    schema_version: SCHEMA_VERSION,
    generated_at: nowIso(),
    root: normalizeRel(root),
    items,
    excluded: excludedEntries,
  };
  const file = path.join(control(root), "generated", "scan-report.json");
  if (options.write) {
    writeJson(file, payload);
    appendAudit(root, "scan", [{ action: "write-report", path: normalizeRel(path.relative(root, file)) }]);
  }
  return payload;
}

function manifestPath(root, entityType, id) {
  const dir = ENTITY_DIRS[entityType];
  if (!dir) throw new Error(`Неизвестный entity type: ${entityType}`);
  return assertInside(root, path.join(control(root), "manifests", dir, `${id}.yaml`));
}

function loadManifests(root) {
  const entities = [];
  for (const [entityType, dir] of Object.entries(ENTITY_DIRS)) {
    const folder = path.join(control(root), "manifests", dir);
    if (!fs.existsSync(folder)) continue;
    const files = fs.readdirSync(folder)
      .filter((name) => name.endsWith(".yaml"))
      .sort();
    for (const name of files) {
      const file = path.join(folder, name);
      const data = readYamlJson(file);
      entities.push({ entityType, file, rel: normalizeRel(path.relative(root, file)), data });
    }
  }
  return entities;
}

function validateEntity(entry, root, allIds) {
  const errors = [];
  const warnings = [];
  const { entityType, data, rel } = entry;
  const requireFields = {
    "work-item": ["schema_version", "id", "entity_type", "title", "kind", "context", "path", "status", "phase", "created_at", "updated_at"],
    source: ["schema_version", "id", "entity_type", "kind", "uri", "registered_at", "freshness_policy", "authority"],
    relation: ["schema_version", "id", "entity_type", "from", "to", "relation_type"],
    decision: ["schema_version", "id", "entity_type", "title", "status", "decision", "evidence"],
    artifact: ["schema_version", "id", "entity_type", "title", "kind", "path", "role", "authority"],
    iteration: ["schema_version", "id", "entity_type", "work_item", "name", "goal", "status", "started_at"],
    verification: ["schema_version", "id", "entity_type", "subject", "validator", "validator_version", "result", "checked_at"],
    proposal: ["schema_version", "id", "entity_type", "target_type", "target_id", "changes", "reason", "status", "created_at"],
  }[entityType];
  for (const field of requireFields) {
    if (!(field in data) || data[field] === "") errors.push(`${rel}: отсутствует обязательное поле ${field}`);
  }
  if (data.schema_version !== SCHEMA_VERSION) errors.push(`${rel}: неподдерживаемая schema_version`);
  if (data.entity_type !== entityType) errors.push(`${rel}: entity_type не соответствует каталогу`);
  if (data.id && path.basename(rel, ".yaml") !== data.id) errors.push(`${rel}: имя файла не совпадает с id`);
  if (entityType === "work-item") {
    if (!STATUSES.includes(data.status)) errors.push(`${rel}: недопустимый status ${data.status}`);
    if (!PHASES.includes(data.phase)) errors.push(`${rel}: недопустимый phase ${data.phase}`);
    if (!WORK_ITEM_KINDS.includes(data.kind)) errors.push(`${rel}: недопустимый kind ${data.kind}`);
    if (data.path && !fs.existsSync(path.join(root, data.path))) errors.push(`${rel}: path не существует: ${data.path}`);
  }
  if (entityType === "source") {
    if (!AUTHORITIES.includes(data.authority)) errors.push(`${rel}: недопустимый authority`);
    if (data.unknowns !== undefined && (!Array.isArray(data.unknowns) || data.unknowns.some((item) => typeof item !== "string"))) {
      errors.push(`${rel}: unknowns должен быть массивом строк`);
    }
    if (data.kind?.startsWith("local-") && data.uri && !fs.existsSync(path.join(root, data.uri))) {
      errors.push(`${rel}: локальный source не существует: ${data.uri}`);
    }
  }
  if (entityType === "artifact") {
    if (!AUTHORITIES.includes(data.authority)) errors.push(`${rel}: недопустимый authority`);
    if (data.path && !fs.existsSync(path.join(root, data.path))) errors.push(`${rel}: artifact path не существует: ${data.path}`);
    if (data.authority === "authoritative" && !(data.evidence?.length)) {
      errors.push(`${rel}: authoritative artifact требует evidence`);
    }
    if (data.authority === "authoritative" && !(data.decision || data.confirmed_by)) {
      errors.push(`${rel}: authoritative artifact требует accepted decision или human confirmation`);
    }
  }
  if (entityType === "decision") {
    if (data.supersedes && !allIds.has(data.supersedes)) {
      errors.push(`${rel}: supersedes ссылается на неизвестный id ${data.supersedes}`);
    }
    if (data.supersedes === data.id) errors.push(`${rel}: decision не может supersede сам себя`);
    if (data.considered_options !== undefined && !Array.isArray(data.considered_options)) {
      errors.push(`${rel}: considered_options должен быть массивом`);
    }
    if (data.consequences !== undefined && !Array.isArray(data.consequences)) {
      errors.push(`${rel}: consequences должен быть массивом`);
    }
  }
  if (entityType === "relation") {
    if (!RELATION_TYPES.includes(data.relation_type)) errors.push(`${rel}: недопустимый relation_type`);
    if (!allIds.has(data.from)) errors.push(`${rel}: from ссылается на неизвестный id ${data.from}`);
    if (!allIds.has(data.to)) errors.push(`${rel}: to ссылается на неизвестный id ${data.to}`);
  }
  if (entityType === "iteration" && !allIds.has(data.work_item)) errors.push(`${rel}: неизвестный work_item`);
  if (entityType === "verification" && !allIds.has(data.subject) && data.subject !== "workspace") {
    errors.push(`${rel}: неизвестный subject`);
  }
  if (entityType === "proposal" && !allIds.has(data.target_id)) errors.push(`${rel}: неизвестный target_id`);
  if (
    entityType === "proposal"
    && data.confidence !== undefined
    && !["high", "medium", "low"].includes(data.confidence)
  ) {
    errors.push(`${rel}: недопустимый confidence`);
  }
  if (
    entityType === "proposal"
    && data.unknowns !== undefined
    && (!Array.isArray(data.unknowns) || data.unknowns.some((item) => typeof item !== "string"))
  ) {
    errors.push(`${rel}: unknowns должен быть массивом строк`);
  }
  return { errors, warnings };
}

function canonicalHash(entities) {
  const hash = crypto.createHash("sha256");
  for (const entry of [...entities].sort((a, b) => a.rel.localeCompare(b.rel, "en"))) {
    hash.update(entry.rel);
    hash.update("\0");
    hash.update(fs.readFileSync(entry.file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function entitySummary(entry) {
  const d = entry.data;
  return {
    id: d.id,
    entity_type: entry.entityType,
    title: d.title ?? d.name ?? d.uri ?? d.id,
    kind: d.kind ?? null,
    status: d.status ?? null,
    phase: d.phase ?? null,
    authority: d.authority ?? null,
    path: d.path ?? d.uri ?? null,
    context: d.context ?? null,
    payload: d,
  };
}

function buildIndexMarkdown(config, entities, hash) {
  const byType = Object.fromEntries(Object.keys(ENTITY_DIRS).map((type) => [type, []]));
  for (const entry of entities) byType[entry.entityType].push(entry.data);
  const rows = byType["work-item"].sort((a, b) => a.path.localeCompare(b.path, "en"));
  const lines = [
    "# Workspace Index",
    "",
    "> Этот файл генерируется детерминированно из `.ai-workspace/manifests/`.",
    "",
    `- Workspace: \`${config.id}\``,
    `- Contract: \`${config.contract_version}\``,
    `- Canonical hash: \`${hash}\``,
    `- Work items: ${rows.length}`,
    `- Sources: ${byType.source.length}`,
    `- Decisions: ${byType.decision.length}`,
    `- Artifacts: ${byType.artifact.length}`,
    `- Iterations: ${byType.iteration.length}`,
    `- Candidate proposals: ${byType.proposal.filter((item) => item.status === "candidate").length}`,
    "",
    "## Рабочие элементы",
    "",
    "| ID | Название | Kind | Classification | Status | Phase | Path | Next action |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const item of rows) {
    const classification = item.classification?.value
      ? `${item.classification.status}: ${item.classification.value}`
      : "";
    lines.push(`| \`${item.id}\` | ${escapeCell(item.title)} | ${item.kind} | ${classification} | ${item.status} | ${item.phase} | \`${item.path}\` | ${escapeCell(item.next_action ?? "")} |`);
  }
  lines.push("", "## Кандидатные предложения", "");
  const candidateProposals = byType.proposal
    .filter((item) => item.status === "candidate")
    .sort((a, b) => a.target_id.localeCompare(b.target_id, "en"));
  if (!candidateProposals.length) {
    lines.push("_Нет предложений, ожидающих решения._");
  } else {
    lines.push("| Proposal | Target | Changes | Confidence |", "|---|---|---|---|");
    for (const item of candidateProposals) {
      const changes = Object.entries(item.changes)
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
      lines.push(`| \`${item.id}\` | \`${item.target_id}\` | ${escapeCell(changes)} | ${item.confidence ?? "medium"} |`);
    }
  }
  lines.push("", "## Authoritative artifacts", "");
  const authoritative = byType.artifact.filter((item) => item.authority === "authoritative");
  if (!authoritative.length) lines.push("_Не назначены._");
  for (const item of authoritative) lines.push(`- [${item.title}](../../${normalizeRel(item.path)}) — \`${item.id}\``);
  lines.push("", "## Активные итерации", "");
  const activeIterations = byType.iteration.filter((item) => item.status === "active");
  if (!activeIterations.length) lines.push("_Нет активных итераций._");
  for (const item of activeIterations) lines.push(`- \`${item.id}\`: ${item.goal}`);
  lines.push("", "## Состояние реестров", "");
  for (const type of Object.keys(ENTITY_DIRS)) lines.push(`- ${type}: ${byType[type].length}`);
  lines.push("");
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function validateWorkspace(root, options = {}) {
  const errors = [];
  const warnings = [];
  let config;
  try {
    config = workspaceConfig(root);
  } catch (error) {
    return { errors: [error.message], warnings, entities: [] };
  }
  if (config.schema_version !== SCHEMA_VERSION) errors.push("workspace.yaml: неподдерживаемая schema_version");
  const migrationRegistryFile = path.join(control(root), "migrations", "registry.json");
  if (!fs.existsSync(migrationRegistryFile)) {
    errors.push("Отсутствует versioned schema migration registry");
  } else {
    try {
      const migrationRegistry = readYamlJson(migrationRegistryFile);
      if (migrationRegistry.current_schema_version !== SCHEMA_VERSION) {
        errors.push("Schema migration registry не соответствует engine schema version");
      }
      if (!Array.isArray(migrationRegistry.migrations)) {
        errors.push("Schema migration registry: migrations должен быть массивом");
      }
    } catch (error) {
      errors.push(`Schema migration registry не читается: ${error.message}`);
    }
  }
  const entities = loadManifests(root);
  const ids = new Map();
  for (const entry of entities) {
    const id = entry.data.id;
    if (!id) continue;
    if (ids.has(id)) errors.push(`Дублированный id ${id}: ${ids.get(id)} и ${entry.rel}`);
    ids.set(id, entry.rel);
  }
  const allIds = new Set(ids.keys());
  for (const entry of entities) {
    const result = validateEntity(entry, root, allIds);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  const hash = canonicalHash(entities);
  if (options.checkGenerated) {
    const indexFile = path.join(control(root), "generated", "WORKSPACE_INDEX.md");
    const expectedIndex = buildIndexMarkdown(config, entities, hash);
    if (!fs.existsSync(indexFile) || fs.readFileSync(indexFile, "utf8") !== expectedIndex) {
      errors.push("Generated Markdown index содержит drift; выполните rebuild");
    }
    const registryFile = path.join(control(root), "generated", "registry.json");
    const expectedRegistry = serialize({
      schema_version: SCHEMA_VERSION,
      canonical_hash: hash,
      entities: entities.map(entitySummary).sort((a, b) => a.id.localeCompare(b.id, "en")),
    });
    if (!fs.existsSync(registryFile) || fs.readFileSync(registryFile, "utf8") !== expectedRegistry) {
      errors.push("Generated registry.json содержит drift; выполните rebuild");
    }
    const sqliteFile = path.join(control(root), "state", "workspace.sqlite");
    if (!fs.existsSync(sqliteFile)) {
      errors.push("SQLite projection отсутствует; выполните rebuild");
    } else {
      try {
        const db = new DatabaseSync(sqliteFile, { readOnly: true });
        const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get("canonical_hash");
        db.close();
        if (row?.value !== hash) errors.push("SQLite projection содержит drift; выполните rebuild");
      } catch (error) {
        errors.push(`SQLite projection не читается: ${error.message}`);
      }
    }
  }
  return { errors, warnings, entities, hash };
}

function rebuild(root, options = {}) {
  const validation = validateWorkspace(root, { checkGenerated: false });
  if (validation.errors.length) return report("rebuild", validation, options);
  const config = workspaceConfig(root);
  const registry = {
    schema_version: SCHEMA_VERSION,
    canonical_hash: validation.hash,
    entities: validation.entities.map(entitySummary).sort((a, b) => a.id.localeCompare(b.id, "en")),
  };
  const generated = path.join(control(root), "generated");
  writeJson(path.join(generated, "registry.json"), registry);
  atomicWrite(
    path.join(generated, "WORKSPACE_INDEX.md"),
    buildIndexMarkdown(config, validation.entities, validation.hash),
  );
  const sqliteFile = path.join(control(root), "state", "workspace.sqlite");
  const temp = `${sqliteFile}.tmp-${process.pid}`;
  if (fs.existsSync(temp)) fs.unlinkSync(temp);
  const db = new DatabaseSync(temp);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA foreign_keys = ON;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT,
      status TEXT,
      phase TEXT,
      authority TEXT,
      path TEXT,
      context TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE relations (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX idx_entities_type_status ON entities(entity_type, status, id);
    CREATE INDEX idx_entities_path ON entities(path, id);
    CREATE INDEX idx_relations_from ON relations(from_id, relation_type, to_id);
    CREATE INDEX idx_relations_to ON relations(to_id, relation_type, from_id);
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO metadata(key, value) VALUES(?, ?)").run("canonical_hash", validation.hash);
    db.prepare("INSERT INTO metadata(key, value) VALUES(?, ?)").run("contract_version", config.contract_version);
    db.prepare("INSERT INTO metadata(key, value) VALUES(?, ?)").run("engine_version", ENGINE_VERSION);
    const insertEntity = db.prepare(`
      INSERT INTO entities(id, entity_type, title, kind, status, phase, authority, path, context, payload_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRelation = db.prepare(`
      INSERT INTO relations(id, from_id, to_id, relation_type, payload_json)
      VALUES(?, ?, ?, ?, ?)
    `);
    for (const entry of validation.entities.sort((a, b) => a.data.id.localeCompare(b.data.id, "en"))) {
      const item = entitySummary(entry);
      insertEntity.run(
        item.id, item.entity_type, item.title, item.kind, item.status, item.phase,
        item.authority, item.path, item.context, JSON.stringify(item.payload),
      );
      if (entry.entityType === "relation") {
        insertRelation.run(item.id, entry.data.from, entry.data.to, entry.data.relation_type, JSON.stringify(entry.data));
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    throw error;
  }
  db.close();
  atomicReplaceBinary(temp, sqliteFile);
  appendAudit(root, "rebuild", [
    { action: "write", path: ".ai-workspace/generated/registry.json" },
    { action: "write", path: ".ai-workspace/generated/WORKSPACE_INDEX.md" },
    { action: "replace", path: ".ai-workspace/state/workspace.sqlite" },
  ]);
  return report("rebuild", {
    entities: validation.entities.length,
    canonical_hash: validation.hash,
    warnings: validation.warnings,
    errors: [],
  }, options);
}

function atomicReplaceBinary(temp, target) {
  ensureDir(path.dirname(target));
  try {
    fs.renameSync(temp, target);
  } catch {
    const backup = `${target}.replace-backup-${process.pid}`;
    try {
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(temp, target);
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      throw error;
    }
  }
}

function adopt(root, options = {}) {
  const scan = scanWorkspace(root, {});
  const mapping = options.mapping ? readYamlJson(path.resolve(root, options.mapping)) : { items: {} };
  const changes = [];
  for (const item of scan.items) {
    const id = `wi-${slug(item.path)}`;
    const file = manifestPath(root, "work-item", id);
    if (fs.existsSync(file)) continue;
    const proposal = mapping.items?.[item.path] ?? {};
    const manifest = {
      schema_version: SCHEMA_VERSION,
      id,
      entity_type: "work-item",
      title: proposal.title ?? item.path,
      kind: "unclassified",
      context: proposal.context ?? "agent-space",
      path: item.path,
      status: item.path === "ORGANIZE_WORKSPACE" ? "active" : "unclassified",
      phase: item.path === "ORGANIZE_WORKSPACE" ? "delivery" : "intake",
      created_at: proposal.created_at ?? (item.latest_mtime?.slice(0, 10) ?? today()),
      updated_at: today(),
      current_iteration: item.path === "ORGANIZE_WORKSPACE" ? "iter-aiws-brownfield-adoption" : null,
      next_action: item.path === "ORGANIZE_WORKSPACE"
        ? "Завершить и проверить brownfield migration"
        : "Подтвердить candidate classification и актуальный статус",
      inventory: {
        files: item.files,
        bytes: item.bytes,
        observed_at: scan.generated_at,
        nested_git: item.nested_git,
      },
      classification: proposal.kind ? {
        value: proposal.kind,
        status: "candidate",
        method: "agent-inference",
        created_at: nowIso(),
        evidence: proposal.evidence ?? [],
        rationale: proposal.rationale ?? null,
      } : null,
    };
    changes.push({ action: "create", path: normalizeRel(path.relative(root, file)), id });
    if (options.write) writeJson(file, manifest);
  }
  if (options.write) {
    appendAudit(root, "adopt", changes);
    writeJson(path.join(control(root), "generated", "adoption-report.json"), {
      schema_version: SCHEMA_VERSION,
      generated_at: nowIso(),
      mode: "brownfield",
      moved_paths: [],
      changes,
      preserved_paths: scan.items.map((item) => item.path),
    });
  }
  return report("adopt", {
    dry_run: !options.write,
    planned_changes: changes.length,
    moved_paths: 0,
    errors: [],
  }, options);
}

function registerSource(root, options) {
  if (!options.uri || !options.kind) throw new Error("register-source требует --uri и --kind");
  const uri = normalizeRel(options.uri);
  const id = options.id ?? `src-${slug(uri)}`;
  const full = path.join(root, uri);
  const local = options.kind.startsWith("local-");
  if (local && !fs.existsSync(full)) throw new Error(`Локальный источник не найден: ${uri}`);
  const stat = local ? fs.statSync(full) : null;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id,
    entity_type: "source",
    kind: options.kind,
    uri,
    registered_at: nowIso(),
    retrieved_at: options["retrieved-at"] ?? null,
    provenance: options.provenance ?? (stat ? "local-observation" : "external-reference"),
    sha256: stat?.isFile() ? sha256File(full) : null,
    size_bytes: stat?.isFile() ? stat.size : null,
    freshness_policy: options.freshness ?? "manual",
    authority: options.authority ?? "reference-only",
    unknowns: options.unknown ?? [],
    title: options.title ?? path.basename(uri),
  };
  const file = manifestPath(root, "source", id);
  if (fs.existsSync(file)) throw new Error(`Source уже существует: ${id}`);
  if (options.write) {
    writeJson(file, manifest);
    appendAudit(root, "register-source", [{ action: "create", id, path: normalizeRel(path.relative(root, file)) }]);
  }
  return report("register-source", { dry_run: !options.write, id, uri, errors: [] }, options);
}

function registerWorkItem(root, options) {
  for (const required of ["path", "title", "kind", "context"]) {
    if (!options[required]) throw new Error(`register-work-item требует --${required}`);
  }
  const rel = normalizeRel(options.path);
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`Path не существует: ${rel}`);
  if (!WORK_ITEM_KINDS.includes(options.kind)) throw new Error(`Недопустимый kind: ${options.kind}`);
  const id = options.id ?? `wi-${slug(rel)}`;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id,
    entity_type: "work-item",
    title: options.title,
    kind: options.kind,
    context: options.context,
    path: rel,
    status: options.status ?? "active",
    phase: options.phase ?? "intake",
    created_at: today(),
    updated_at: today(),
    current_iteration: null,
    next_action: options["next-action"] ?? null,
  };
  const file = manifestPath(root, "work-item", id);
  if (fs.existsSync(file)) throw new Error(`Work item уже существует: ${id}`);
  if (options.write) {
    writeJson(file, manifest);
    appendAudit(root, "register-work-item", [{ action: "create", id, path: normalizeRel(path.relative(root, file)) }]);
  }
  return report("register-work-item", { dry_run: !options.write, id, path: rel, errors: [] }, options);
}

function registerDecision(root, options) {
  for (const required of ["id", "title", "status", "decision"]) {
    if (!options[required]) throw new Error(`register-decision требует --${required}`);
  }
  if (!["proposed", "accepted", "rejected", "superseded"].includes(options.status)) {
    throw new Error(`Недопустимый status решения: ${options.status}`);
  }
  const decisionText = singleOption(options.decision, "decision");
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id: options.id,
    entity_type: "decision",
    title: options.title,
    question: options.question ?? null,
    considered_options: options.option ?? [],
    decision: decisionText,
    rationale: options.rationale ?? null,
    consequences: options.consequence ?? [],
    status: options.status,
    evidence: options.evidence ?? [],
    decided_at: options["decided-at"] ?? today(),
    supersedes: options.supersedes ?? null,
  };
  const file = manifestPath(root, "decision", options.id);
  if (fs.existsSync(file)) throw new Error(`Decision уже существует: ${options.id}`);
  if (options.write) {
    writeJson(file, manifest);
    appendAudit(root, "register-decision", [{ action: "create", id: options.id }]);
  }
  return report("register-decision", { dry_run: !options.write, id: options.id, errors: [] }, options);
}

function registerArtifact(root, options) {
  for (const required of ["id", "title", "kind", "path", "role", "authority"]) {
    if (!options[required]) throw new Error(`register-artifact требует --${required}`);
  }
  if (!AUTHORITIES.includes(options.authority)) throw new Error(`Недопустимый authority: ${options.authority}`);
  const decisionRef = singleOption(options.decision, "decision");
  if (options.authority === "authoritative") {
    if (!(options.evidence?.length)) {
      throw new Error("Authoritative artifact требует --evidence");
    }
    if (!decisionRef && !options["confirmed-by"]) {
      throw new Error("Authoritative artifact требует --decision или --confirmed-by");
    }
    if (decisionRef) {
      const decision = findEntity(root, decisionRef);
      if (decision.entityType !== "decision" || decision.data.status !== "accepted") {
        throw new Error("Authoritative artifact должен ссылаться на accepted decision");
      }
    }
  }
  const rel = normalizeRel(options.path);
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) throw new Error(`Artifact path не существует: ${rel}`);
  const stat = fs.statSync(full);
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id: options.id,
    entity_type: "artifact",
    title: options.title,
    kind: options.kind,
    path: rel,
    role: options.role,
    work_item: options["work-item"] ?? null,
    sources: options.source ? [options.source] : [],
    generator: options.generator ?? null,
    sha256: stat.isFile() ? sha256File(full) : null,
    size_bytes: stat.isFile() ? stat.size : null,
    authority: options.authority,
    verification_status: options.verification ?? "not-verified",
    evidence: options.evidence ?? [],
    decision: decisionRef ?? null,
    confirmed_by: options["confirmed-by"] ?? null,
    registered_at: nowIso(),
  };
  const file = manifestPath(root, "artifact", options.id);
  if (fs.existsSync(file)) throw new Error(`Artifact уже существует: ${options.id}`);
  if (options.write) {
    writeJson(file, manifest);
    appendAudit(root, "register-artifact", [{ action: "create", id: options.id }]);
  }
  return report("register-artifact", { dry_run: !options.write, id: options.id, path: rel, errors: [] }, options);
}

function registerRelation(root, options) {
  for (const required of ["from", "to", "type"]) {
    if (!options[required]) throw new Error(`register-relation требует --${required}`);
  }
  if (!RELATION_TYPES.includes(options.type)) throw new Error(`Недопустимый relation type: ${options.type}`);
  findEntity(root, options.from);
  findEntity(root, options.to);
  const id = options.id ?? `rel-${slug(options.from)}-${options.type}-${slug(options.to)}`;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id,
    entity_type: "relation",
    from: options.from,
    to: options.to,
    relation_type: options.type,
    status: options.status ?? "accepted",
    evidence: options.evidence ?? [],
    created_at: nowIso(),
  };
  const file = manifestPath(root, "relation", id);
  if (fs.existsSync(file)) throw new Error(`Relation уже существует: ${id}`);
  if (options.write) {
    writeJson(file, manifest);
    appendAudit(root, "register-relation", [{ action: "create", id }]);
  }
  return report("register-relation", { dry_run: !options.write, id, errors: [] }, options);
}

function recordVerification(root, options) {
  for (const required of ["subject", "validator", "result"]) {
    if (!options[required]) throw new Error(`record-verification требует --${required}`);
  }
  if (!["passed", "failed", "warning"].includes(options.result)) {
    throw new Error(`Недопустимый result: ${options.result}`);
  }
  const subjectEntry = options.subject !== "workspace" ? findEntity(root, options.subject) : null;
  const reportPath = options.report ? normalizeRel(options.report) : null;
  if (reportPath && !fs.existsSync(path.join(root, reportPath))) {
    throw new Error(`Verification report не найден: ${reportPath}`);
  }
  const id = options.id ?? `verify-${slug(options.subject)}-${slug(options.validator)}-${today()}`;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id,
    entity_type: "verification",
    subject: options.subject,
    validator: options.validator,
    validator_version: options.version ?? ENGINE_VERSION,
    parameters: {},
    checked_at: nowIso(),
    result: options.result,
    report: reportPath,
    evidence: options.evidence ?? [],
  };
  const file = manifestPath(root, "verification", id);
  if (fs.existsSync(file)) throw new Error(`Verification уже существует: ${id}`);
  if (options.write) {
    writeJson(file, manifest);
    const changes = [{ action: "create", id }];
    if (subjectEntry?.entityType === "artifact") {
      writeJson(subjectEntry.file, {
        ...subjectEntry.data,
        verification_status: options.result,
        updated_at: today(),
      });
      changes.push({
        action: "update-verification-status",
        id: subjectEntry.data.id,
        result: options.result,
      });
    }
    appendAudit(root, "record-verification", changes);
  }
  return report("record-verification", { dry_run: !options.write, id, result: options.result, errors: [] }, options);
}

function refreshFacts(root, options) {
  if (!options.id) throw new Error("refresh требует --id");
  const entry = findEntity(root, options.id);
  if (!["source", "artifact"].includes(entry.entityType)) {
    throw new Error("refresh применим только к local source или artifact");
  }
  const rel = entry.entityType === "source" ? entry.data.uri : entry.data.path;
  if (!rel || (/^[a-z]+:/i.test(rel) && !/^[a-z]:[\\/]/i.test(rel))) {
    throw new Error(`Entity не указывает на локальный путь: ${entry.data.id}`);
  }
  const full = path.isAbsolute(rel) ? rel : path.join(root, rel);
  if (!fs.existsSync(full)) throw new Error(`Локальный путь не найден: ${rel}`);
  const stat = fs.statSync(full);
  const facts = {
    sha256: stat.isFile() ? sha256File(full) : null,
    size_bytes: stat.isFile() ? stat.size : null,
  };
  const previous = { sha256: entry.data.sha256 ?? null, size_bytes: entry.data.size_bytes ?? null };
  if (options.write) {
    const factsChanged = previous.sha256 !== facts.sha256 || previous.size_bytes !== facts.size_bytes;
    writeJson(entry.file, {
      ...entry.data,
      ...facts,
      ...(entry.entityType === "artifact" && factsChanged
        ? { verification_status: "not-verified" }
        : {}),
      facts_refreshed_at: nowIso(),
    });
    appendAudit(root, "refresh", [{ action: "update-facts", id: entry.data.id, previous, current: facts }]);
  }
  return report("refresh", { dry_run: !options.write, id: entry.data.id, previous, current: facts, errors: [] }, options);
}

function acceptClassification(root, options) {
  if (!options.id) throw new Error("accept-classification требует --id");
  const entry = findEntity(root, options.id);
  if (entry.entityType !== "work-item") {
    throw new Error("accept-classification применим только к work-item");
  }
  const classification = entry.data.classification;
  if (!classification?.value) throw new Error(`Candidate classification отсутствует: ${entry.data.id}`);
  if (classification.status !== "candidate") {
    throw new Error(`Classification уже обработана: ${classification.status}`);
  }
  if (!WORK_ITEM_KINDS.includes(classification.value) || classification.value === "unclassified") {
    throw new Error(`Недопустимый candidate kind: ${classification.value}`);
  }
  const updated = {
    ...entry.data,
    kind: classification.value,
    classification: {
      ...classification,
      status: "accepted",
      accepted_at: nowIso(),
      acceptance: {
        method: options.method ?? "human-confirmation",
        evidence: options.evidence ?? [],
      },
    },
    updated_at: today(),
  };
  if (entry.data.next_action === "Подтвердить candidate classification и актуальный статус") {
    updated.next_action = "Определить текущие lifecycle status и phase";
  }
  if (options.write) {
    writeJson(entry.file, updated);
    appendAudit(root, "accept-classification", [{
      action: "accept-classification",
      id: entry.data.id,
      from: entry.data.kind,
      to: classification.value,
      method: updated.classification.acceptance.method,
    }]);
  }
  return report("accept-classification", {
    dry_run: !options.write,
    id: entry.data.id,
    from: entry.data.kind,
    to: classification.value,
    errors: [],
  }, options);
}

function findEntity(root, id) {
  const matches = loadManifests(root).filter((entry) => entry.data.id === id);
  if (!matches.length) throw new Error(`Entity не найдена: ${id}`);
  if (matches.length > 1) throw new Error(`Entity id неоднозначен: ${id}`);
  return matches[0];
}

function transition(root, options) {
  if (!options.id || !options.status) throw new Error("transition требует --id и --status");
  const entry = findEntity(root, options.id);
  if (entry.entityType !== "work-item") throw new Error("transition применим только к work-item");
  const lifecycle = policy(root, "lifecycle");
  const current = entry.data.status;
  const allowed = lifecycle.transitions[current] ?? [];
  if (!allowed.includes(options.status)) throw new Error(`Переход ${current} -> ${options.status} запрещён`);
  const updated = { ...entry.data, status: options.status, updated_at: today() };
  if (options.phase) {
    if (!PHASES.includes(options.phase)) throw new Error(`Недопустимый phase: ${options.phase}`);
    updated.phase = options.phase;
  }
  if (options.write) {
    writeJson(entry.file, updated);
    appendAudit(root, "transition", [{ action: "update", id: options.id, from: current, to: options.status }]);
  }
  return report("transition", { dry_run: !options.write, id: options.id, from: current, to: options.status, errors: [] }, options);
}

function repath(root, options) {
  if (!options.id || !options.path) throw new Error("repath требует --id и --path");
  const entry = findEntity(root, options.id);
  if (!["work-item", "artifact"].includes(entry.entityType)) {
    throw new Error("repath применим только к work-item или artifact");
  }
  const previous = normalizeRel(entry.data.path);
  if (options.from && normalizeRel(options.from) !== previous) {
    throw new Error(`Precondition failed: текущий path ${previous}`);
  }
  const next = normalizeRel(options.path);
  const full = assertInside(root, path.join(root, next));
  if (!fs.existsSync(full)) throw new Error(`Новый path не существует: ${next}`);
  if (previous === next) throw new Error("Новый path совпадает с текущим");
  if (options.write) {
    writeJson(entry.file, { ...entry.data, path: next, updated_at: today() });
    appendAudit(root, "repath", [{
      action: "update-path",
      id: entry.data.id,
      from: previous,
      to: next,
      identity_preserved: true,
    }]);
  }
  return report("repath", {
    dry_run: !options.write,
    id: entry.data.id,
    from: previous,
    to: next,
    identity_preserved: true,
    errors: [],
  }, options);
}

function iterationStart(root, options) {
  if (!options["work-item"] || !options.name || !options.goal) {
    throw new Error("iteration-start требует --work-item, --name и --goal");
  }
  const wi = findEntity(root, options["work-item"]);
  if (wi.entityType !== "work-item") throw new Error("--work-item должен ссылаться на work-item");
  const id = options.id ?? `iter-${slug(options["work-item"].replace(/^wi-/, ""))}-${slug(options.name)}`;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id,
    entity_type: "iteration",
    work_item: options["work-item"],
    name: options.name,
    goal: options.goal,
    status: "active",
    started_at: nowIso(),
    inputs: [],
    hypotheses: [],
    planned_outputs: [],
    actual_outputs: [],
    decisions: [],
    rejected_alternatives: [],
    verifications: [],
    unresolved: [],
    next_action: null,
  };
  const file = manifestPath(root, "iteration", id);
  if (fs.existsSync(file)) throw new Error(`Iteration уже существует: ${id}`);
  if (wi.data.current_iteration && wi.data.current_iteration !== id) {
    throw new Error(`У work-item уже активна iteration: ${wi.data.current_iteration}`);
  }
  if (options.write) {
    writeJson(file, manifest);
    writeJson(wi.file, { ...wi.data, current_iteration: id, updated_at: today() });
    appendAudit(root, "iteration-start", [{ action: "create", id }, { action: "update", id: wi.data.id }]);
  }
  return report("iteration-start", { dry_run: !options.write, id, work_item: wi.data.id, errors: [] }, options);
}

function iterationClose(root, options) {
  if (!options.id || !options.summary || !options["next-action"]) {
    throw new Error("iteration-close требует --id, --summary и --next-action");
  }
  const iteration = findEntity(root, options.id);
  if (iteration.entityType !== "iteration") throw new Error("--id должен ссылаться на iteration");
  if (iteration.data.status !== "active") throw new Error(`Iteration не активна: ${iteration.data.status}`);
  const wi = findEntity(root, iteration.data.work_item);
  const updatedIteration = {
    ...iteration.data,
    status: "closed",
    closed_at: nowIso(),
    summary: options.summary,
    actual_outputs: options.output ?? iteration.data.actual_outputs ?? [],
    decisions: options.decision ?? iteration.data.decisions ?? [],
    verifications: options.verification ?? iteration.data.verifications ?? [],
    unresolved: options.unresolved ?? iteration.data.unresolved ?? [],
    next_action: options["next-action"],
  };
  const updatedWi = {
    ...wi.data,
    current_iteration: null,
    next_action: options["next-action"],
    updated_at: today(),
  };
  if (options.write) {
    writeJson(iteration.file, updatedIteration);
    writeJson(wi.file, updatedWi);
    appendAudit(root, "iteration-close", [{ action: "update", id: iteration.data.id }, { action: "update", id: wi.data.id }]);
  }
  return report("iteration-close", { dry_run: !options.write, id: options.id, errors: [] }, options);
}

function propose(root, options) {
  if (!options.id || !options.change?.length || !options.reason) {
    throw new Error("propose требует --id, один или несколько --change key=value и --reason");
  }
  if (options.confidence && !["high", "medium", "low"].includes(options.confidence)) {
    throw new Error(`Недопустимый --confidence: ${options.confidence}`);
  }
  const target = findEntity(root, options.id);
  const changes = {};
  for (const pair of options.change) {
    const split = pair.indexOf("=");
    if (split < 1) throw new Error(`Некорректный --change: ${pair}`);
    const key = pair.slice(0, split);
    const raw = pair.slice(split + 1);
    changes[key] = raw === "null" ? null : raw;
  }
  const proposalId = options["proposal-id"] ?? `proposal-${slug(target.data.id)}-${sha256Buffer(Buffer.from(serialize(changes))).slice(0, 10)}`;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id: proposalId,
    entity_type: "proposal",
    target_type: target.entityType,
    target_id: target.data.id,
    preconditions: Object.fromEntries(Object.keys(changes).map((key) => [key, target.data[key] ?? null])),
    changes,
    reason: options.reason,
    evidence: options.evidence ?? [],
    confidence: options.confidence ?? "medium",
    unknowns: options.unknown ?? [],
    status: "candidate",
    created_at: nowIso(),
  };
  const file = manifestPath(root, "proposal", proposalId);
  if (fs.existsSync(file)) throw new Error(`Proposal уже существует: ${proposalId}`);
  if (options.write) {
    writeJson(file, manifest);
    appendAudit(root, "propose", [{ action: "create", id: proposalId, target: target.data.id }]);
  }
  return report("propose", { dry_run: !options.write, proposal_id: proposalId, target: target.data.id, changes, errors: [] }, options);
}

function reviewProposal(root, options) {
  if (!options.id || !options.reason) {
    throw new Error("proposal-review требует --id и --reason");
  }
  const proposal = findEntity(root, options.id);
  if (proposal.entityType !== "proposal") throw new Error("--id должен ссылаться на proposal");
  if (proposal.data.status !== "candidate") {
    throw new Error(`Review применим только к candidate proposal: ${proposal.data.status}`);
  }
  const status = options.status ?? "candidate";
  if (!["candidate", "rejected"].includes(status)) {
    throw new Error(`Недопустимый review status: ${status}`);
  }
  const confidence = options.confidence ?? proposal.data.confidence ?? "medium";
  if (!["high", "medium", "low"].includes(confidence)) {
    throw new Error(`Недопустимый --confidence: ${confidence}`);
  }
  const evidence = [...new Set([...(proposal.data.evidence ?? []), ...(options.evidence ?? [])])];
  const unknowns = options["clear-unknowns"]
    ? [...new Set(options.unknown ?? [])]
    : [...new Set([...(proposal.data.unknowns ?? []), ...(options.unknown ?? [])])];
  const review = {
    reviewed_at: nowIso(),
    status,
    confidence,
    reason: options.reason,
    evidence: options.evidence ?? [],
    unknowns,
  };
  const updated = {
    ...proposal.data,
    status,
    confidence,
    evidence,
    unknowns,
    reviewed_at: review.reviewed_at,
    reviews: [...(proposal.data.reviews ?? []), review],
  };
  if (options.write) {
    writeJson(proposal.file, updated);
    appendAudit(root, "proposal-review", [{
      action: "review",
      id: proposal.data.id,
      status,
      confidence,
    }]);
  }
  return report("proposal-review", {
    dry_run: !options.write,
    proposal: proposal.data.id,
    status,
    confidence,
    unknowns: unknowns.length,
    errors: [],
  }, options);
}

function applyProposal(root, options) {
  if (!options.id) throw new Error("apply требует --id proposal");
  const proposal = findEntity(root, options.id);
  if (proposal.entityType !== "proposal") throw new Error("--id должен ссылаться на proposal");
  if (proposal.data.status !== "candidate") throw new Error(`Proposal уже обработан: ${proposal.data.status}`);
  const target = findEntity(root, proposal.data.target_id);
  const allowed = new Set(["title", "kind", "context", "status", "phase", "current_iteration", "next_action", "authority"]);
  for (const [key, expected] of Object.entries(proposal.data.preconditions ?? {})) {
    if (JSON.stringify(target.data[key] ?? null) !== JSON.stringify(expected)) {
      throw new Error(`Precondition failed для ${key}`);
    }
  }
  for (const key of Object.keys(proposal.data.changes)) {
    if (!allowed.has(key)) throw new Error(`Поле ${key} нельзя менять через generic proposal`);
  }
  const updated = { ...target.data, ...proposal.data.changes, updated_at: today() };
  if (updated.kind && !WORK_ITEM_KINDS.includes(updated.kind)) throw new Error(`Недопустимый kind ${updated.kind}`);
  if (updated.status && !STATUSES.includes(updated.status)) throw new Error(`Недопустимый status ${updated.status}`);
  if (updated.phase && !PHASES.includes(updated.phase)) throw new Error(`Недопустимый phase ${updated.phase}`);
  if (updated.authority && !AUTHORITIES.includes(updated.authority)) throw new Error(`Недопустимый authority ${updated.authority}`);
  if (options.write) {
    writeJson(target.file, updated);
    writeJson(proposal.file, { ...proposal.data, status: "accepted", applied_at: nowIso() });
    appendAudit(root, "apply", [{ action: "update", id: target.data.id, proposal: proposal.data.id }]);
  }
  return report("apply", { dry_run: !options.write, proposal: proposal.data.id, target: target.data.id, errors: [] }, options);
}

function checkMarkdownLinks(root, markdownFiles) {
  const broken = [];
  const pattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const file of markdownFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      let target = match[1].trim().replace(/^<|>$/g, "");
      if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
      target = target.split("#")[0];
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        // Keep the raw path and report only if it does not resolve.
      }
      const resolved = /^\/[A-Za-z]:\//.test(target)
        ? path.resolve(target.slice(1))
        : path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) {
        broken.push({
          file: normalizeRel(path.relative(root, file)),
          target: match[1],
        });
      }
    }
  }
  return broken;
}

function findUnregisteredDirectories(root, scanItems, registeredPaths, scanPolicy) {
  const registered = [...registeredPaths].sort((a, b) => a.localeCompare(b, "en"));
  const recursiveExcludes = new Set(scanPolicy.recursive_exclude ?? [...WALK_EXCLUDES]);
  const unregistered = [];

  function visit(relativePath) {
    if (registeredPaths.has(relativePath)) return;
    const prefix = `${relativePath}/`;
    if (!registered.some((candidate) => candidate.startsWith(prefix))) {
      unregistered.push(relativePath);
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relativePath), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || recursiveExcludes.has(entry.name)) continue;
      visit(normalizeRel(path.join(relativePath, entry.name)));
    }
  }

  for (const item of scanItems) visit(item.path);
  return unregistered;
}

function auditWorkspace(root, options = {}) {
  const scanPolicy = policy(root, "scan");
  const scan = scanWorkspace(root, {});
  const manifests = loadManifests(root);
  const registeredPaths = new Set(
    manifests.filter((entry) => entry.entityType === "work-item").map((entry) => normalizeRel(entry.data.path)),
  );
  const unregistered = findUnregisteredDirectories(root, scan.items, registeredPaths, scanPolicy);
  const missing = [...registeredPaths].filter((item) => !fs.existsSync(path.join(root, item)));
  const nestedGit = scan.items.flatMap((item) => item.nested_git);
  const caches = scan.items.flatMap((item) => item.detected_caches);
  const large = scan.items.filter((item) => item.size_mb >= (scanPolicy.large_directory_mb ?? 512))
    .map((item) => ({ path: item.path, size_mb: item.size_mb }));
  const allWalk = walkTree(root, {
    recursive_exclude: [...(scanPolicy.recursive_exclude ?? []), ".ai-workspace"],
  }, true);
  const brokenLinks = scanPolicy.markdown_link_check ? checkMarkdownLinks(root, allWalk.markdown) : [];
  const invalidGit = [];
  const rootGit = path.join(root, ".git");
  if (fs.existsSync(rootGit)) {
    const validDir = fs.statSync(rootGit).isDirectory() && fs.existsSync(path.join(rootGit, "HEAD"));
    const validFile = fs.statSync(rootGit).isFile() && fs.readFileSync(rootGit, "utf8").startsWith("gitdir:");
    if (!validDir && !validFile) invalidGit.push(".git");
  }
  const payload = {
    schema_version: SCHEMA_VERSION,
    generated_at: nowIso(),
    mode: "read-only",
    unregistered_work_items: unregistered,
    missing_registered_paths: missing,
    nested_git: nestedGit,
    invalid_git_boundaries: invalidGit,
    detected_caches: caches,
    large_directories: large,
    broken_markdown_links: brokenLinks,
    remediation: [
      ...(unregistered.length ? ["Review and adopt unregistered directories."] : []),
      ...(invalidGit.length ? ["Review invalid root .git marker; no automatic deletion is allowed."] : []),
      ...(caches.length ? ["Keep caches excluded from registry; prepare a separate cleanup plan if needed."] : []),
      ...(brokenLinks.length ? ["Review broken Markdown links before any physical migration."] : []),
    ],
  };
  if (options.write) {
    writeJson(path.join(control(root), "generated", "audit-report.json"), payload);
    appendAudit(root, "audit", [{ action: "write-report", path: ".ai-workspace/generated/audit-report.json" }]);
  }
  return payload;
}

function orient(root, options = {}) {
  const entities = loadManifests(root);
  const items = entities.filter((entry) => entry.entityType === "work-item").map((entry) => entry.data);
  const iterations = entities.filter((entry) => entry.entityType === "iteration").map((entry) => entry.data);
  const artifacts = entities.filter((entry) => entry.entityType === "artifact").map((entry) => entry.data);
  const proposals = entities.filter((entry) => entry.entityType === "proposal").map((entry) => entry.data);
  const sources = entities.filter((entry) => entry.entityType === "source").map((entry) => entry.data);
  const decisions = entities.filter((entry) => entry.entityType === "decision").map((entry) => entry.data);
  const relations = entities.filter((entry) => entry.entityType === "relation").map((entry) => entry.data);
  const adjacency = new Map();
  for (const relation of relations) {
    if (!adjacency.has(relation.from)) adjacency.set(relation.from, new Set());
    if (!adjacency.has(relation.to)) adjacency.set(relation.to, new Set());
    adjacency.get(relation.from).add(relation.to);
    adjacency.get(relation.to).add(relation.from);
  }
  function reachable(start, maxDepth = 3) {
    const seen = new Set([start]);
    let frontier = [start];
    for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
      const next = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (!seen.has(neighbor)) {
            seen.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    return seen;
  }
  function sourceFreshness(source) {
    const freshnessPolicy = source.freshness_policy ?? "manual";
    if (freshnessPolicy === "immutable") {
      return { status: "fresh", warning: null };
    }
    const match = /^(?:max-age-days|days):(\d+)$/.exec(freshnessPolicy);
    if (!match) {
      return {
        status: "manual-review",
        warning: `Источник ${source.id} требует ручной проверки freshness`,
      };
    }
    const observedAt = source.retrieved_at ?? source.facts_refreshed_at ?? source.registered_at;
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) {
      return { status: "unknown", warning: `Для ${source.id} отсутствует корректная дата freshness` };
    }
    const maxAgeMs = Number.parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
    const stale = Date.now() - observedMs > maxAgeMs;
    return {
      status: stale ? "stale" : "fresh",
      warning: stale ? `Источник ${source.id} устарел по policy ${freshnessPolicy}` : null,
    };
  }
  let selected = items;
  if (options.id) selected = items.filter((item) => item.id === options.id);
  if (options.path) selected = items.filter((item) => normalizeRel(item.path) === normalizeRel(options.path));
  const result = {
    workspace: workspaceConfig(root).id,
    work_items: selected.map((item) => {
      const relatedIds = reachable(item.id);
      const relatedSources = sources
        .filter((source) => relatedIds.has(source.id))
        .map((source) => ({ id: source.id, ...sourceFreshness(source) }));
      const completedIterations = iterations
        .filter((iteration) => iteration.work_item === item.id && iteration.status === "closed")
        .sort((a, b) =>
          String(b.closed_at ?? b.ended_at ?? b.started_at ?? "")
            .localeCompare(String(a.closed_at ?? a.ended_at ?? a.started_at ?? "")));
      const officialDecisions = decisions
        .filter((decision) => relatedIds.has(decision.id) && decision.status === "accepted")
        .sort((a, b) => String(b.decided_at ?? "").localeCompare(String(a.decided_at ?? "")));
      const candidateProposals = proposals.filter((proposal) =>
        proposal.status === "candidate" && proposal.target_id === item.id);
      const latestCompleted = completedIterations[0] ?? null;
      return {
        id: item.id,
        title: item.title,
        path: item.path,
        kind: item.kind,
        candidate_kind: item.classification?.status === "candidate" ? item.classification.value : null,
        classification_status: item.classification?.status ?? null,
        status: item.status,
        phase: item.phase,
        current_iteration: item.current_iteration,
        next_action: item.next_action,
        active_iteration: iterations.find((iteration) => iteration.id === item.current_iteration) ?? null,
        latest_completed_iteration: latestCompleted,
        latest_official_decision: officialDecisions[0] ?? null,
        unresolved: [
          ...(latestCompleted?.unresolved ?? []),
          ...candidateProposals.flatMap((proposal) => proposal.unknowns ?? []),
        ],
        related_sources: relatedSources,
        freshness_warnings: relatedSources.map((source) => source.warning).filter(Boolean),
        authoritative_artifacts: artifacts.filter((artifact) =>
          artifact.authority === "authoritative" && artifact.work_item === item.id),
        candidate_proposals: candidateProposals,
      };
    }),
  };
  return result;
}

function queryRegistry(root, options = {}) {
  let items = loadManifests(root);
  if (options.type) items = items.filter((entry) => entry.entityType === options.type);
  if (options.id) items = items.filter((entry) => entry.data.id === options.id);
  if (options.status) items = items.filter((entry) => entry.data.status === options.status);
  if (options.authority) items = items.filter((entry) => entry.data.authority === options.authority);
  if (options.context) items = items.filter((entry) => entry.data.context === options.context);
  const limit = options.limit === undefined ? 100 : Number.parseInt(options.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit должен быть целым числом от 1 до 1000");
  }
  const summaries = items
    .map(entitySummary)
    .sort((a, b) => a.id.localeCompare(b.id, "en"))
    .slice(0, limit)
    .map((item) => options.full ? item : Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== "payload"),
    ));
  return report("query", {
    count: Math.min(items.length, limit),
    total_matches: items.length,
    items: summaries,
    errors: [],
  }, options);
}

function handoff(root, options = {}) {
  if (!options.id) throw new Error("handoff требует --id work-item");
  const orientation = orient(root, { id: options.id });
  if (!orientation.work_items.length) throw new Error(`Work item не найден: ${options.id}`);
  const item = orientation.work_items[0];
  const lines = [
    `# Handoff: ${item.title}`,
    "",
    `- Work item: \`${item.id}\``,
    `- Path: \`${item.path}\``,
    `- Status: \`${item.status}\``,
    `- Phase: \`${item.phase}\``,
    `- Kind: \`${item.kind}\``,
    `- Classification status: \`${item.classification_status ?? "not-set"}\``,
    `- Current iteration: \`${item.current_iteration ?? "none"}\``,
    "",
    "## Следующее действие",
    "",
    item.next_action ?? "_Не зафиксировано._",
    "",
    "## Authoritative artifacts",
    "",
    ...(item.authoritative_artifacts.length
      ? item.authoritative_artifacts.map((artifact) => `- \`${artifact.id}\`: ${artifact.path}`)
      : ["_Не назначены._"]),
    "",
    "## Кандидатные предложения",
    "",
    ...(item.candidate_proposals.length
      ? item.candidate_proposals.map((proposal) =>
        `- \`${proposal.id}\` (${proposal.confidence ?? "medium"}): ${Object.entries(proposal.changes).map(([key, value]) => `${key}=${value}`).join("; ")}`)
      : ["_Нет._"]),
    "",
    "## Проверка перед продолжением",
    "",
    "```text",
    "node .ai-workspace/engine/workspace.mjs orient --id " + item.id,
    "node .ai-workspace/engine/workspace.mjs validate",
    "```",
    "",
  ];
  const file = path.join(control(root), "generated", "handoffs", `${item.id}.md`);
  if (options.write) {
    atomicWrite(file, lines.join("\n"));
    appendAudit(root, "handoff", [{ action: "write", path: normalizeRel(path.relative(root, file)) }]);
  }
  return report("handoff", { dry_run: !options.write, id: item.id, output: normalizeRel(path.relative(root, file)), errors: [] }, options);
}

function usage() {
  return `
AI-native Workspace Engine ${ENGINE_VERSION}

Usage:
  node .ai-workspace/engine/workspace.mjs <command> [options]

Commands:
  init --mode brownfield|greenfield [--id ID] [--title TITLE]
  scan [--write] [--json]
  adopt [--mapping FILE] [--write] [--json]
  register-source --kind KIND --uri URI [--id ID] [--authority STATE] [--write]
  register-work-item --path PATH --title TITLE --kind KIND --context CONTEXT [--write]
  register-decision --id ID --title TITLE --status STATUS --decision TEXT [--option TEXT] [--consequence TEXT] [--evidence REF] [--write]
  register-artifact --id ID --title TITLE --kind KIND --path PATH --role ROLE --authority STATE [--write]
  register-relation --from ID --to ID --type TYPE [--write]
  record-verification --subject ID|workspace --validator NAME --result RESULT [--write]
  refresh --id SOURCE_OR_ARTIFACT_ID [--write]
  accept-classification --id WORK_ITEM_ID [--method METHOD] [--evidence REF] [--write]
  rebuild [--json]
  validate [--json]
  audit [--write] [--json]
  orient [--id ID|--path PATH] [--json]
  query [--type TYPE] [--status STATUS] [--authority STATE] [--context CONTEXT] [--limit N] [--full] [--json]
  propose --id ID --change key=value --reason TEXT [--evidence REF] [--confidence high|medium|low] [--unknown TEXT] [--write]
  proposal-review --id PROPOSAL_ID --reason TEXT [--status candidate|rejected] [--confidence high|medium|low] [--evidence REF] [--clear-unknowns] [--unknown TEXT] [--write]
  apply --id PROPOSAL_ID [--write]
  transition --id ID --status STATUS [--phase PHASE] [--write]
  repath --id ID --path NEW_PATH [--from OLD_PATH] [--write]
  iteration-start --work-item ID --name NAME --goal GOAL [--write]
  iteration-close --id ID --summary TEXT --next-action TEXT [--output REF] [--decision REF] [--verification REF] [--unresolved TEXT] [--write]
  handoff --id WORK_ITEM_ID [--write]

Mutating commands are dry-run unless --write is supplied.
.yaml manifests use the JSON-compatible subset of YAML 1.2.
.ai-workspace/state/workspace.sqlite is a derived, rebuildable index.
.ai-workspace/generated/* is derived unless explicitly documented otherwise.
`;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "help" || options.help) {
    process.stdout.write(usage());
    return;
  }
  const root = resolveRoot(options.root);
  let result;
  switch (command) {
    case "init":
      result = initWorkspace(root, options);
      break;
    case "scan": {
      workspaceConfig(root);
      const value = scanWorkspace(root, options);
      result = report("scan", {
        items: value.items.length,
        excluded: value.excluded.length,
        output: options.write ? ".ai-workspace/generated/scan-report.json" : null,
        errors: [],
      }, options);
      break;
    }
    case "adopt":
      workspaceConfig(root);
      result = adopt(root, options);
      break;
    case "register-source":
      workspaceConfig(root);
      result = registerSource(root, options);
      break;
    case "register-work-item":
      workspaceConfig(root);
      result = registerWorkItem(root, options);
      break;
    case "register-decision":
      workspaceConfig(root);
      result = registerDecision(root, options);
      break;
    case "register-artifact":
      workspaceConfig(root);
      result = registerArtifact(root, options);
      break;
    case "register-relation":
      workspaceConfig(root);
      result = registerRelation(root, options);
      break;
    case "record-verification":
      workspaceConfig(root);
      result = recordVerification(root, options);
      break;
    case "refresh":
      workspaceConfig(root);
      result = refreshFacts(root, options);
      break;
    case "accept-classification":
      workspaceConfig(root);
      result = acceptClassification(root, options);
      break;
    case "rebuild":
      result = rebuild(root, options);
      break;
    case "validate": {
      const value = validateWorkspace(root, { checkGenerated: true });
      result = report("validate", {
        entities: value.entities.length,
        canonical_hash: value.hash ?? null,
        warnings: value.warnings,
        errors: value.errors,
      }, options);
      break;
    }
    case "audit": {
      workspaceConfig(root);
      const value = auditWorkspace(root, options);
      result = report("audit", {
        unregistered: value.unregistered_work_items.length,
        missing: value.missing_registered_paths.length,
        nested_git: value.nested_git.length,
        invalid_git: value.invalid_git_boundaries.length,
        caches: value.detected_caches.length,
        broken_links: value.broken_markdown_links.length,
        output: options.write ? ".ai-workspace/generated/audit-report.json" : null,
        errors: [],
      }, options);
      break;
    }
    case "orient": {
      workspaceConfig(root);
      const value = orient(root, options);
      if (options.json) process.stdout.write(serialize(value));
      else {
        process.stdout.write(`# Orientation: ${value.workspace}\n\n`);
        for (const item of value.work_items) {
          process.stdout.write(`- ${item.id}: ${item.title}\n`);
          process.stdout.write(`  path=${item.path}; status=${item.status}; phase=${item.phase}; candidate=${item.candidate_kind ?? "none"}\n`);
          process.stdout.write(`  next=${item.next_action ?? "not-set"}\n`);
        }
      }
      result = { ok: true };
      break;
    }
    case "query":
      workspaceConfig(root);
      result = queryRegistry(root, options);
      break;
    case "propose":
      result = propose(root, options);
      break;
    case "proposal-review":
      result = reviewProposal(root, options);
      break;
    case "apply":
      result = applyProposal(root, options);
      break;
    case "transition":
      result = transition(root, options);
      break;
    case "repath":
      result = repath(root, options);
      break;
    case "iteration-start":
      result = iterationStart(root, options);
      break;
    case "iteration-close":
      result = iterationClose(root, options);
      break;
    case "handoff":
      result = handoff(root, options);
      break;
    default:
      throw new Error(`Неизвестная команда: ${command}\n${usage()}`);
  }
  if (result?.ok === false) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`workspace-engine: ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
