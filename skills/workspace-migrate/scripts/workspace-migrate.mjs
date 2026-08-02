#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".mmd", ".toml", ".ps1",
  ".mjs", ".js", ".ts", ".tsx", ".py", ".html", ".css", ".xml", ".csv",
  ".bat", ".cmd",
]);
const WALK_EXCLUDES = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build", "coverage",
  ".tmp", "tmp",
]);
const MAX_TEXT_BYTES = 10 * 1024 * 1024;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "write") {
      options.write = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command: positional[0], options };
}

function normalizeRel(value) {
  if (typeof value !== "string") return "";
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function assertSafeRel(root, value, label) {
  const rel = normalizeRel(value);
  if (!rel || rel === "." || path.isAbsolute(rel) || rel.split("/").includes("..")) {
    throw new Error(`${label} must be a non-root workspace-relative path: ${value}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, rel);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes workspace: ${value}`);
  }
  return rel;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function serialize(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function isPrefix(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

function mapRelative(rel, moves) {
  const normalized = normalizeRel(rel);
  const match = [...moves]
    .filter((move) => isPrefix(move.from, normalized))
    .sort((a, b) => b.from.length - a.from.length)[0];
  if (!match) return normalized;
  const suffix = normalized.slice(match.from.length).replace(/^\//, "");
  return suffix ? `${match.to}/${suffix}` : match.to;
}

function mapAbsolute(root, absolute, moves) {
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return absolute;
  const normalized = normalizeRel(rel);
  const mapped = mapRelative(normalized, moves);
  return mapped === normalized ? absolute : path.resolve(root, mapped);
}

function inspectDirectory(root, rel) {
  const start = path.join(root, rel);
  let files = 0;
  let bytes = 0;
  let links = 0;
  const nestedGit = [];
  const fingerprints = [];
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const entryRel = normalizeRel(path.relative(root, full));
      if (entry.isDirectory()) {
        fingerprints.push(`D\0${entryRel}`);
        if (entry.name === ".git") nestedGit.push(entryRel);
        stack.push(full);
      } else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        files += 1;
        bytes += size;
        fingerprints.push(`F\0${entryRel}\0${size}\0${fileHash(full)}`);
      } else if (entry.isSymbolicLink()) {
        links += 1;
        fingerprints.push(`L\0${entryRel}\0${fs.readlinkSync(full)}`);
      } else {
        fingerprints.push(`O\0${entryRel}`);
      }
    }
  }
  return {
    files,
    bytes,
    links,
    nested_git: nestedGit.sort(),
    tree_sha256: sha256(fingerprints.sort().join("\n")),
  };
}

function walkTextFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const relDir = normalizeRel(path.relative(root, current));
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = normalizeRel(path.relative(root, full));
      if (entry.isDirectory()) {
        if (WALK_EXCLUDES.has(entry.name)) continue;
        if (relDir === ".ai-workspace" && ["state", "generated", "audit", "manifests"].includes(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const size = fs.statSync(full).size;
        if (size <= MAX_TEXT_BYTES) result.push({ full, rel, size });
      }
    }
  }
  return result.sort((a, b) => a.rel.localeCompare(b.rel, "en"));
}

function transformPathString(value, root, moves) {
  if (typeof value !== "string" || !value) return value;
  const normalized = value.replaceAll("\\", "/");
  const rootSlash = path.resolve(root).replaceAll("\\", "/");
  const codexRoot = rootSlash.replace(/^([A-Za-z]:)/, "/$1");
  for (const move of [...moves].sort((a, b) => b.from.length - a.from.length)) {
    if (isPrefix(move.from, normalizeRel(normalized))) {
      const mapped = mapRelative(normalizeRel(normalized), moves);
      return value.includes("\\") ? mapped.replaceAll("/", "\\") : mapped;
    }
    for (const prefix of [rootSlash, codexRoot]) {
      const oldAbsolute = `${prefix}/${move.from}`;
      if (normalized === oldAbsolute || normalized.startsWith(`${oldAbsolute}/`)) {
        const replacement = `${prefix}/${move.to}${normalized.slice(oldAbsolute.length)}`;
        return value.includes("\\") ? replacement.replaceAll("/", "\\") : replacement;
      }
    }
  }
  return value;
}

function transformObject(value, root, moves, pointer = "$", changes = []) {
  if (Array.isArray(value)) {
    return value.map((item, index) => transformObject(item, root, moves, `${pointer}[${index}]`, changes));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      transformObject(item, root, moves, `${pointer}.${key}`, changes),
    ]));
  }
  if (typeof value === "string") {
    const transformed = transformPathString(value, root, moves);
    if (transformed !== value) changes.push({ pointer, from: value, to: transformed });
    return transformed;
  }
  return value;
}

function collectManifestUpdates(root, moves) {
  const manifestRoot = path.join(root, ".ai-workspace", "manifests");
  const updates = [];
  const stack = [manifestRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".yaml")) {
        const before = readJson(full);
        const changes = [];
        const after = transformObject(before, root, moves, "$", changes);
        if (changes.length) {
          updates.push({
            file: normalizeRel(path.relative(root, full)),
            sha256_before: fileHash(full),
            sha256_after: sha256(serialize(after)),
            changes,
          });
        }
      }
    }
  }
  return updates.sort((a, b) => a.file.localeCompare(b.file, "en"));
}

function splitAnchor(target) {
  const index = target.indexOf("#");
  return index < 0
    ? { pathPart: target, anchor: "" }
    : { pathPart: target.slice(0, index), anchor: target.slice(index) };
}

function collectMarkdownUpdates(root, moves, textFiles) {
  const updates = [];
  const pattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const item of textFiles.filter((entry) => path.extname(entry.rel).toLowerCase() === ".md")) {
    const content = fs.readFileSync(item.full, "utf8");
    const fileAfterRel = mapRelative(item.rel, moves);
    const fileAfter = path.resolve(root, fileAfterRel);
    const edits = [];
    for (const match of content.matchAll(pattern)) {
      const raw = match[1].trim().replace(/^<|>$/g, "");
      if (!raw || raw.startsWith("#") || /^[a-z]+:/i.test(raw)) continue;
      const { pathPart, anchor } = splitAnchor(raw);
      if (!pathPart) continue;
      let decoded;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        decoded = pathPart;
      }
      const codexAbsolute = /^\/[A-Za-z]:\//.test(decoded);
      const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(decoded);
      const targetBefore = codexAbsolute
        ? path.resolve(decoded.slice(1))
        : windowsAbsolute
          ? path.resolve(decoded)
          : path.resolve(path.dirname(item.full), decoded);
      if (!fs.existsSync(targetBefore)) continue;
      const targetAfter = mapAbsolute(root, targetBefore, moves);
      if (fileAfter === item.full && targetAfter === targetBefore) continue;
      let nextTarget;
      if (codexAbsolute) nextTarget = targetAfter.replaceAll("\\", "/").replace(/^([A-Za-z]:)/, "/$1");
      else if (windowsAbsolute) nextTarget = targetAfter.replaceAll("/", "\\");
      else {
        nextTarget = path.relative(path.dirname(fileAfter), targetAfter).replaceAll("\\", "/");
        if (!nextTarget.startsWith(".")) nextTarget = `./${nextTarget}`;
      }
      const encoded = nextTarget.includes(" ") ? encodeURI(nextTarget) : nextTarget;
      const start = match.index + match[0].indexOf(match[1]);
      edits.push({
        start,
        end: start + match[1].length,
        from: match[1],
        to: `${encoded}${anchor}`,
      });
    }
    if (edits.length) {
      const replacementCounts = new Map();
      for (const edit of edits) {
        const key = `${edit.from}\0${edit.to}`;
        replacementCounts.set(key, (replacementCounts.get(key) ?? 0) + 1);
      }
      updates.push({
        file_before: item.rel,
        file_after: fileAfterRel,
        sha256_before: fileHash(item.full),
        replacements: [...replacementCounts.entries()]
          .map(([key, count]) => {
            const [from, to] = key.split("\0");
            return { from, to, count };
          })
          .sort((a, b) => a.from.localeCompare(b.from, "en")),
        edits: edits.sort((a, b) => a.start - b.start),
      });
    }
  }
  return updates;
}

function maskMarkdownTargets(content) {
  return content.replace(/(!?\[[^\]]*]\()([^)]+)(\))/g, (_match, open, target, close) => (
    `${open}${" ".repeat(target.length)}${close}`
  ));
}

function collectPlainPathWarnings(root, moves, textFiles, ignored = { paths: [], prefixes: [] }) {
  const warnings = [];
  const rootSlash = path.resolve(root).replaceAll("\\", "/");
  for (const item of textFiles) {
    if (
      ignored.paths.includes(item.rel)
      || ignored.prefixes.some((prefix) => isPrefix(prefix, item.rel))
    ) continue;
    const content = fs.readFileSync(item.full, "utf8");
    const normalized = maskMarkdownTargets(content.replaceAll("\\", "/"));
    for (const move of moves) {
      const references = [
        {
          kind: "absolute",
          needle: `${rootSlash}/${move.from}`,
          proposed: `${rootSlash}/${move.to}`,
        },
        {
          kind: "relative",
          needle: move.from,
          proposed: move.to,
        },
      ];
      const occupied = [];
      for (const reference of references) {
        let index = normalized.indexOf(reference.needle);
        while (index >= 0) {
          const end = index + reference.needle.length;
          const insideEarlier = occupied.some(([left, right]) => index >= left && end <= right);
          const before = normalized[index - 1] ?? "";
          const after = normalized[end] ?? "";
          const boundary = !/[A-Za-z0-9_.-]/.test(before) && !/[A-Za-z0-9_.-]/.test(after);
          if (!insideEarlier && boundary) {
            const line = normalized.slice(0, index).split("\n").length;
            warnings.push({
              file: item.rel,
              line,
              kind: reference.kind,
              reference: reference.needle,
              proposed: reference.proposed,
              start: index,
              end,
              from: content.slice(index, end),
              to: content.slice(index, end).includes("\\")
                ? reference.proposed.replaceAll("/", "\\")
                : reference.proposed,
            });
            occupied.push([index, end]);
          }
          index = normalized.indexOf(reference.needle, index + reference.needle.length);
        }
      }
    }
  }
  return warnings.sort((a, b) => a.file.localeCompare(b.file, "en") || a.line - b.line);
}

function matchesException(warning, exception) {
  return warning.file === normalizeRel(exception.file)
    && (exception.reference === "*" || warning.reference === exception.reference);
}

function classifyPlainPathWarnings(root, moves, warnings, mapping) {
  const exceptions = mapping.plain_path_exceptions ?? [];
  const invalidExceptions = exceptions.filter(
    (exception) => !warnings.some((warning) => matchesException(warning, exception)),
  );
  if (invalidExceptions.length) {
    throw new Error(`Plain path exceptions do not match warnings: ${JSON.stringify(invalidExceptions)}`);
  }
  const reviewed = [];
  const candidates = [];
  for (const warning of warnings) {
    const exception = exceptions.find((item) => matchesException(warning, item));
    if (exception) {
      reviewed.push({
        file: warning.file,
        line: warning.line,
        reference: warning.reference,
        reason: exception.reason,
      });
    } else {
      candidates.push(warning);
    }
  }
  if (mapping.rewrite_plain_paths !== true) {
    return { updates: [], reviewed, unresolved: candidates };
  }
  const byFile = new Map();
  for (const warning of candidates) {
    if (!byFile.has(warning.file)) byFile.set(warning.file, []);
    byFile.get(warning.file).push({
      start: warning.start,
      end: warning.end,
      from: warning.from,
      to: warning.to,
      line: warning.line,
    });
  }
  const updates = [...byFile.entries()].map(([fileBefore, edits]) => ({
    file_before: fileBefore,
    file_after: mapRelative(fileBefore, moves),
    sha256_before: fileHash(path.join(root, fileBefore)),
    edits: edits.sort((a, b) => a.start - b.start),
  })).sort((a, b) => a.file_before.localeCompare(b.file_before, "en"));
  return { updates, reviewed, unresolved: [] };
}

function validateMapping(root, mapping) {
  const errors = [];
  if (mapping.schema_version !== 1) errors.push("Unsupported mapping schema_version");
  if (!mapping.id) errors.push("Mapping id is required");
  if (!Array.isArray(mapping.moves) || !mapping.moves.length) errors.push("Mapping moves are required");
  const targetRoot = assertSafeRel(root, mapping.target_root, "target_root");
  const moves = (mapping.moves ?? []).map((move, index) => ({
    index,
    from: assertSafeRel(root, move.from, `moves[${index}].from`),
    to: assertSafeRel(root, move.to, `moves[${index}].to`),
  }));
  const fromSet = new Set();
  const toSet = new Set();
  for (const move of moves) {
    if (fromSet.has(move.from)) errors.push(`Duplicate source: ${move.from}`);
    if (toSet.has(move.to)) errors.push(`Duplicate target: ${move.to}`);
    fromSet.add(move.from);
    toSet.add(move.to);
    if (!isPrefix(targetRoot, move.to)) errors.push(`Target is outside target_root: ${move.to}`);
    if (!fs.existsSync(path.join(root, move.from))) errors.push(`Source does not exist: ${move.from}`);
    if (fs.existsSync(path.join(root, move.to))) errors.push(`Target already exists: ${move.to}`);
  }
  for (const left of moves) {
    for (const right of moves) {
      if (left.index !== right.index && isPrefix(left.from, right.from)) {
        errors.push(`Overlapping sources: ${left.from} and ${right.from}`);
      }
    }
  }
  return { moves, errors: [...new Set(errors)] };
}

function buildPlan(root, mappingFile) {
  const mapping = readJson(mappingFile);
  const mappingHash = fileHash(mappingFile);
  const validation = validateMapping(root, mapping);
  const moves = validation.moves.map((move) => ({
    from: move.from,
    to: move.to,
    ...(fs.existsSync(path.join(root, move.from)) ? inspectDirectory(root, move.from) : {}),
  }));
  const textFiles = walkTextFiles(root);
  const manifestUpdates = validation.errors.length ? [] : collectManifestUpdates(root, moves);
  const markdownUpdates = validation.errors.length ? [] : collectMarkdownUpdates(root, moves, textFiles);
  const mappingDirectory = normalizeRel(path.relative(root, path.dirname(mappingFile)));
  const mappingRelative = normalizeRel(path.relative(root, mappingFile));
  const plainWarnings = validation.errors.length
    ? []
    : collectPlainPathWarnings(root, moves, textFiles, {
      paths: [mappingRelative],
      prefixes: mappingDirectory === "." ? [] : [mappingDirectory],
    });
  const plainClassification = validation.errors.length
    ? { updates: [], reviewed: [], unresolved: [] }
    : classifyPlainPathWarnings(root, moves, plainWarnings, mapping);
  const body = {
    schema_version: 1,
    migration_id: mapping.id,
    workspace_id: mapping.workspace_id,
    generator: normalizeRel(path.relative(root, SCRIPT_FILE)),
    generator_sha256: fileHash(SCRIPT_FILE),
    mapping: normalizeRel(path.relative(root, mappingFile)),
    mapping_sha256: mappingHash,
    target_root: mapping.target_root,
    moves,
    manifest_updates: manifestUpdates,
    markdown_link_updates: markdownUpdates,
    plain_text_updates: plainClassification.updates,
    reviewed_plain_path_exceptions: plainClassification.reviewed,
    plain_path_warnings: plainClassification.unresolved,
    blockers: validation.errors,
    policy: {
      preserve_nested_git: mapping.preserve_nested_git === true,
      allow_plain_path_warnings: mapping.allow_plain_path_warnings === true,
      rewrite_plain_paths: mapping.rewrite_plain_paths === true,
    },
    rollback_sequence: [...moves].reverse().map((move) => ({ from: move.to, to: move.from })),
    approval_required: true,
  };
  const planHash = sha256(serialize(body));
  return {
    ...body,
    plan_hash: planHash,
    apply_ready: validation.errors.length === 0
      && (
        plainClassification.unresolved.length === 0
        || mapping.allow_plain_path_warnings === true
      ),
  };
}

function verifyPlan(root, plan, approval) {
  const { plan_hash: ignored, apply_ready: ignoredReady, ...body } = plan;
  const expected = sha256(serialize(body));
  if (plan.plan_hash !== expected) throw new Error("Plan hash is invalid");
  if (approval !== plan.plan_hash) throw new Error("Approval does not match plan hash");
  if (fileHash(SCRIPT_FILE) !== plan.generator_sha256) {
    throw new Error("Migration generator changed after plan creation");
  }
  if (plan.blockers.length) throw new Error(`Plan has blockers: ${plan.blockers.join("; ")}`);
  if (plan.plain_path_warnings.length && !plan.policy.allow_plain_path_warnings) {
    throw new Error("Plan has unresolved plain path warnings");
  }
  for (const move of plan.moves) {
    assertSafeRel(root, move.from, "move.from");
    assertSafeRel(root, move.to, "move.to");
    if (!fs.existsSync(path.join(root, move.from))) throw new Error(`Source changed or missing: ${move.from}`);
    if (fs.existsSync(path.join(root, move.to))) throw new Error(`Target collision: ${move.to}`);
    const current = inspectDirectory(root, move.from);
    if (
      current.tree_sha256 !== move.tree_sha256
      || current.files !== move.files
      || current.bytes !== move.bytes
      || current.links !== move.links
    ) {
      throw new Error(`Source tree precondition changed: ${move.from}`);
    }
  }
  for (const update of plan.manifest_updates) {
    if (fileHash(path.join(root, update.file)) !== update.sha256_before) {
      throw new Error(`Manifest precondition changed: ${update.file}`);
    }
  }
  for (const update of plan.markdown_link_updates) {
    if (fileHash(path.join(root, update.file_before)) !== update.sha256_before) {
      throw new Error(`Markdown precondition changed: ${update.file_before}`);
    }
  }
  for (const update of plan.plain_text_updates ?? []) {
    if (fileHash(path.join(root, update.file_before)) !== update.sha256_before) {
      throw new Error(`Plain text precondition changed: ${update.file_before}`);
    }
  }
}

function combinedTextUpdates(plan) {
  const combined = new Map();
  for (const update of [
    ...plan.markdown_link_updates,
    ...(plan.plain_text_updates ?? []),
  ]) {
    const key = `${update.file_before}\0${update.file_after}`;
    const existing = combined.get(key) ?? {
      file_before: update.file_before,
      file_after: update.file_after,
      sha256_before: update.sha256_before,
      edits: [],
    };
    if (existing.sha256_before !== update.sha256_before) {
      throw new Error(`Text update precondition conflict: ${update.file_before}`);
    }
    existing.edits.push(...update.edits);
    combined.set(key, existing);
  }
  return [...combined.values()].map((update) => ({
    ...update,
    edits: update.edits.sort((a, b) => a.start - b.start),
  }));
}

function missingDirectories(directory, root) {
  const resolvedRoot = path.resolve(root);
  const result = [];
  let current = path.resolve(directory);
  while (current !== resolvedRoot && !fs.existsSync(current)) {
    const relative = path.relative(resolvedRoot, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Target parent escapes workspace: ${directory}`);
    }
    result.push(current);
    current = path.dirname(current);
  }
  return result;
}

function applyPlan(root, plan, options) {
  verifyPlan(root, plan, options.approval);
  if (!options.write) {
    return {
      ok: true,
      kind: "workspace-migrate-apply",
      dry_run: true,
      migration_id: plan.migration_id,
      plan_hash: plan.plan_hash,
      moves: plan.moves.length,
      manifest_updates: plan.manifest_updates.length,
      markdown_link_updates: plan.markdown_link_updates.length,
      plain_text_updates: plan.plain_text_updates?.length ?? 0,
    };
  }

  const manifestBackups = new Map();
  const textBackups = new Map();
  const completedMoves = [];
  const createdDirectories = new Set();
  try {
    for (const update of plan.manifest_updates) {
      const file = path.join(root, update.file);
      manifestBackups.set(file, fs.readFileSync(file));
    }
    const textUpdates = combinedTextUpdates(plan);
    for (const update of textUpdates) {
      const file = path.join(root, update.file_before);
      textBackups.set(update.file_after, fs.readFileSync(file));
    }
    for (const move of plan.moves) {
      const from = path.join(root, move.from);
      const to = path.join(root, move.to);
      for (const directory of missingDirectories(path.dirname(to), root)) {
        createdDirectories.add(directory);
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      completedMoves.push(move);
    }
    for (const update of plan.manifest_updates) {
      const file = path.join(root, update.file);
      const current = readJson(file);
      const changes = [];
      const transformed = transformObject(current, root, plan.moves, "$", changes);
      const content = serialize(transformed);
      if (sha256(content) !== update.sha256_after) throw new Error(`Manifest result drift: ${update.file}`);
      atomicWrite(file, content);
    }
    for (const update of textUpdates) {
      const file = path.join(root, update.file_after);
      let content = fs.readFileSync(file, "utf8");
      for (const edit of [...update.edits].reverse()) {
        if (content.slice(edit.start, edit.end) !== edit.from) {
          throw new Error(`Markdown replacement drift: ${update.file_after}`);
        }
        content = `${content.slice(0, edit.start)}${edit.to}${content.slice(edit.end)}`;
      }
      atomicWrite(file, content);
    }
    const engine = path.join(root, ".ai-workspace", "engine", "workspace.mjs");
    for (const command of ["rebuild", "validate"]) {
      const result = spawnSync(process.execPath, [engine, command, "--root", root, "--json"], {
        cwd: root,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
    }
    const auditFile = path.join(root, ".ai-workspace", "audit", "events.jsonl");
    fs.appendFileSync(auditFile, `${JSON.stringify({
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      command: "workspace-migrate",
      status: "applied",
      plan_hash: plan.plan_hash,
      migration_id: plan.migration_id,
      changes: plan.moves.map((move) => ({ action: "move", from: move.from, to: move.to })),
    })}\n`, "utf8");
  } catch (error) {
    for (const [relAfter, content] of textBackups) {
      const file = path.join(root, relAfter);
      if (fs.existsSync(file)) atomicWrite(file, content);
    }
    for (const [file, content] of manifestBackups) atomicWrite(file, content);
    for (const move of [...completedMoves].reverse()) {
      const from = path.join(root, move.to);
      const to = path.join(root, move.from);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
      }
    }
    for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
        fs.rmdirSync(directory);
      }
    }
    throw new Error(`Migration rolled back: ${error.message}`);
  }
  return {
    ok: true,
    kind: "workspace-migrate-apply",
    dry_run: false,
    migration_id: plan.migration_id,
    plan_hash: plan.plan_hash,
    moves: plan.moves.length,
    manifest_updates: plan.manifest_updates.length,
    markdown_link_updates: plan.markdown_link_updates.length,
    plain_text_updates: plan.plain_text_updates?.length ?? 0,
    rollback_sequence: plan.rollback_sequence,
  };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!["plan", "apply"].includes(command)) {
    throw new Error("Usage: workspace-migrate.mjs plan|apply --root PATH ...");
  }
  if (!options.root) throw new Error("--root is required");
  const root = path.resolve(options.root);
  if (!fs.existsSync(path.join(root, ".ai-workspace", "workspace.yaml"))) {
    throw new Error(`Not an AI-native workspace: ${root}`);
  }
  if (command === "plan") {
    if (!options.mapping) throw new Error("--mapping is required");
    const mappingFile = path.resolve(root, options.mapping);
    const plan = buildPlan(root, mappingFile);
    const output = options.output
      ? path.resolve(root, options.output)
      : path.join(root, ".ai-workspace", "generated", `${plan.migration_id}.plan.json`);
    if (options.write) atomicWrite(output, serialize(plan));
    process.stdout.write(serialize({
      ok: plan.blockers.length === 0,
      kind: "workspace-migrate-plan",
      dry_run: !options.write,
      output: normalizeRel(path.relative(root, output)),
      ...plan,
    }));
    if (plan.blockers.length) process.exitCode = 1;
    return;
  }
  if (!options.plan || !options.approval) throw new Error("apply requires --plan and --approval");
  const plan = readJson(path.resolve(root, options.plan));
  process.stdout.write(serialize(applyPlan(root, plan, options)));
}

try {
  main();
} catch (error) {
  process.stderr.write(`workspace-migrate: ERROR: ${error.message}\n`);
  process.exitCode = 1;
}
