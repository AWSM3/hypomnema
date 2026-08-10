import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const VERIFIER_CAPSULE_LIMITS = Object.freeze({
  max_claims: 3,
  max_evidence_entries: 9,
  max_request_bytes: 65_536,
  max_capsule_bytes: 65_536,
  max_evidence_file_bytes: 2_097_152,
  max_excerpt_bytes: 2_048,
  max_total_excerpt_bytes: 12_288,
  max_claim_chars: 1_200,
});

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = new Set(["schema_version", "claims"]);
const REQUEST_CLAIM_KEYS = new Set(["id", "claim", "evidence"]);
const REQUEST_EVIDENCE_KEYS = new Set(["path", "start_line", "end_line"]);
const CAPSULE_KEYS = new Set([
  "schema_version", "kind", "id", "created_at", "workspace", "limits", "claims", "capsule_sha256",
]);
const CAPSULE_WORKSPACE_KEYS = new Set(["root", "canonical_hash", "product_state_sha256"]);
const CAPSULE_CLAIM_KEYS = new Set(["id", "claim", "evidence"]);
const CAPSULE_EVIDENCE_KEYS = new Set(["path", "locator", "sha256", "size_bytes", "excerpt"]);
const CAPSULE_EXCERPT_KEYS = new Set(["start_line", "end_line", "sha256", "text"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
  }
  return value;
}

export function serializeVerifierCapsule(value) {
  return `${JSON.stringify(stableSort(value), null, 2)}\n`;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function normalizeRel(root, target) {
  return path.relative(root, target).replaceAll("\\", "/") || ".";
}

function assertWorkspaceFile(root, candidate, label) {
  if (typeof candidate !== "string" || !candidate) throw new Error(`${label} must be a non-empty string`);
  if (path.isAbsolute(candidate) || /^[a-z]+:/i.test(candidate)) {
    throw new Error(`${label} must be root-relative`);
  }
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} leaves the workspace`);
  if (!fs.existsSync(full)) throw new Error(`${label} does not exist: ${candidate}`);
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${candidate}`);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${candidate}`);
  const real = fs.realpathSync(full);
  const realRelative = path.relative(fs.realpathSync(resolvedRoot), real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`${label} resolves outside the workspace`);
  }
  return { full, relative: normalizeRel(resolvedRoot, full), stat };
}

function splitLinesPreserve(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function parseJsonObject(text, label) {
  const normalized = String(text).replace(/^\uFEFF/, "").trim();
  if (!normalized) throw new Error(`${label} is empty`);
  const value = JSON.parse(normalized);
  if (!isPlainObject(value)) throw new Error(`${label} must contain exactly one JSON object`);
  return value;
}

export function readVerifierCapsuleRequest(root, requestPath) {
  const requestFile = assertWorkspaceFile(root, requestPath, "verifier capsule request");
  if (requestFile.stat.size > VERIFIER_CAPSULE_LIMITS.max_request_bytes) {
    throw new Error(`verifier capsule request exceeds ${VERIFIER_CAPSULE_LIMITS.max_request_bytes} bytes`);
  }
  return {
    path: requestFile.relative,
    value: parseJsonObject(fs.readFileSync(requestFile.full, "utf8"), "verifier capsule request"),
  };
}

function validateRequest(value) {
  assertAllowedKeys(value, REQUEST_KEYS, "request");
  if (value.schema_version !== 1) throw new Error("request.schema_version must equal 1");
  if (!Array.isArray(value.claims) || !value.claims.length) {
    throw new Error("request.claims must contain at least one claim");
  }
  if (value.claims.length > VERIFIER_CAPSULE_LIMITS.max_claims) {
    throw new Error(`request.claims exceeds ${VERIFIER_CAPSULE_LIMITS.max_claims}`);
  }
  const claimIds = new Set();
  let evidenceCount = 0;
  value.claims.forEach((claim, claimIndex) => {
    const label = `request.claims[${claimIndex}]`;
    assertAllowedKeys(claim, REQUEST_CLAIM_KEYS, label);
    if (typeof claim.id !== "string" || !SAFE_ID.test(claim.id)) throw new Error(`${label}.id is invalid`);
    if (claimIds.has(claim.id)) throw new Error(`${label}.id is duplicated`);
    claimIds.add(claim.id);
    if (typeof claim.claim !== "string" || !claim.claim.trim()) throw new Error(`${label}.claim is required`);
    if (claim.claim.length > VERIFIER_CAPSULE_LIMITS.max_claim_chars) {
      throw new Error(`${label}.claim exceeds ${VERIFIER_CAPSULE_LIMITS.max_claim_chars} characters`);
    }
    if (!Array.isArray(claim.evidence) || !claim.evidence.length) {
      throw new Error(`${label}.evidence must contain at least one entry`);
    }
    claim.evidence.forEach((evidence, evidenceIndex) => {
      evidenceCount += 1;
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
      assertAllowedKeys(evidence, REQUEST_EVIDENCE_KEYS, evidenceLabel);
      if (typeof evidence.path !== "string" || !evidence.path) throw new Error(`${evidenceLabel}.path is required`);
      if (!Number.isInteger(evidence.start_line) || evidence.start_line < 1) {
        throw new Error(`${evidenceLabel}.start_line must be a positive integer`);
      }
      if (!Number.isInteger(evidence.end_line) || evidence.end_line < evidence.start_line) {
        throw new Error(`${evidenceLabel}.end_line must be at least start_line`);
      }
    });
  });
  if (evidenceCount > VERIFIER_CAPSULE_LIMITS.max_evidence_entries) {
    throw new Error(`request evidence exceeds ${VERIFIER_CAPSULE_LIMITS.max_evidence_entries} entries`);
  }
}

function collectEvidence(root, requestEvidence, label) {
  const file = assertWorkspaceFile(root, requestEvidence.path, `${label}.path`);
  if (file.stat.size > VERIFIER_CAPSULE_LIMITS.max_evidence_file_bytes) {
    throw new Error(`${label}.path exceeds ${VERIFIER_CAPSULE_LIMITS.max_evidence_file_bytes} bytes`);
  }
  const buffer = fs.readFileSync(file.full);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label}.path must contain valid UTF-8 text`);
  }
  const lines = splitLinesPreserve(text);
  if (requestEvidence.end_line > lines.length) {
    throw new Error(`${label}.end_line ${requestEvidence.end_line} exceeds ${lines.length} lines`);
  }
  const excerptText = lines.slice(requestEvidence.start_line - 1, requestEvidence.end_line).join("");
  const excerptBuffer = Buffer.from(excerptText, "utf8");
  if (excerptBuffer.length > VERIFIER_CAPSULE_LIMITS.max_excerpt_bytes) {
    throw new Error(`${label} excerpt exceeds ${VERIFIER_CAPSULE_LIMITS.max_excerpt_bytes} bytes`);
  }
  return {
    path: file.relative,
    locator: `lines ${requestEvidence.start_line}-${requestEvidence.end_line}`,
    sha256: sha256Buffer(buffer),
    size_bytes: buffer.length,
    excerpt: {
      start_line: requestEvidence.start_line,
      end_line: requestEvidence.end_line,
      sha256: sha256Buffer(excerptBuffer),
      text: excerptText,
    },
  };
}

export function buildVerifierCapsule({ root, id, request, canonicalHash, createdAt = new Date().toISOString() }) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error("verifier capsule --id is invalid");
  if (typeof canonicalHash !== "string" || !HASH_PATTERN.test(canonicalHash)) {
    throw new Error("verifier capsule canonical hash is invalid");
  }
  validateRequest(request);
  let totalExcerptBytes = 0;
  const claims = request.claims.map((claim, claimIndex) => ({
    id: claim.id,
    claim: claim.claim.trim(),
    evidence: claim.evidence.map((evidence, evidenceIndex) => {
      const collected = collectEvidence(root, evidence, `request.claims[${claimIndex}].evidence[${evidenceIndex}]`);
      totalExcerptBytes += Buffer.byteLength(collected.excerpt.text, "utf8");
      return collected;
    }),
  }));
  if (totalExcerptBytes > VERIFIER_CAPSULE_LIMITS.max_total_excerpt_bytes) {
    throw new Error(`capsule excerpts exceed ${VERIFIER_CAPSULE_LIMITS.max_total_excerpt_bytes} bytes`);
  }
  const productFile = path.join(root, ".ai-workspace", "product.json");
  const core = {
    schema_version: 1,
    kind: "hypomnema-verifier-capsule",
    id,
    created_at: createdAt,
    workspace: {
      root: ".",
      canonical_hash: canonicalHash,
      product_state_sha256: fs.existsSync(productFile) ? sha256File(productFile) : null,
    },
    limits: { ...VERIFIER_CAPSULE_LIMITS },
    claims,
  };
  const capsule = {
    ...core,
    capsule_sha256: sha256Buffer(serializeVerifierCapsule(core)),
  };
  const serialized = serializeVerifierCapsule(capsule);
  if (Buffer.byteLength(serialized, "utf8") > VERIFIER_CAPSULE_LIMITS.max_capsule_bytes) {
    throw new Error(`verifier capsule exceeds ${VERIFIER_CAPSULE_LIMITS.max_capsule_bytes} bytes`);
  }
  return {
    capsule,
    serialized,
    sha256: sha256Buffer(serialized),
    evidence_count: claims.reduce((sum, claim) => sum + claim.evidence.length, 0),
    excerpt_bytes: totalExcerptBytes,
  };
}

function validateCapsuleShape(capsule) {
  assertAllowedKeys(capsule, CAPSULE_KEYS, "capsule");
  if (capsule.schema_version !== 1) throw new Error("capsule.schema_version must equal 1");
  if (capsule.kind !== "hypomnema-verifier-capsule") throw new Error("capsule.kind is invalid");
  if (typeof capsule.id !== "string" || !SAFE_ID.test(capsule.id)) throw new Error("capsule.id is invalid");
  if (typeof capsule.created_at !== "string" || Number.isNaN(Date.parse(capsule.created_at))) {
    throw new Error("capsule.created_at must be an ISO timestamp");
  }
  if (typeof capsule.capsule_sha256 !== "string" || !HASH_PATTERN.test(capsule.capsule_sha256)) {
    throw new Error("capsule.capsule_sha256 is invalid");
  }
  assertAllowedKeys(capsule.workspace, CAPSULE_WORKSPACE_KEYS, "capsule.workspace");
  if (capsule.workspace.root !== ".") throw new Error("capsule.workspace.root must equal .");
  if (!HASH_PATTERN.test(capsule.workspace.canonical_hash)) throw new Error("capsule.workspace.canonical_hash is invalid");
  if (capsule.workspace.product_state_sha256 !== null && !HASH_PATTERN.test(capsule.workspace.product_state_sha256)) {
    throw new Error("capsule.workspace.product_state_sha256 is invalid");
  }
  assertAllowedKeys(capsule.limits, new Set(Object.keys(VERIFIER_CAPSULE_LIMITS)), "capsule.limits");
  for (const [key, expected] of Object.entries(VERIFIER_CAPSULE_LIMITS)) {
    if (capsule.limits[key] !== expected) throw new Error(`capsule.limits.${key} does not match the runtime limit`);
  }
  if (!Array.isArray(capsule.claims) || !capsule.claims.length || capsule.claims.length > VERIFIER_CAPSULE_LIMITS.max_claims) {
    throw new Error("capsule.claims is invalid");
  }
  const ids = new Set();
  let evidenceCount = 0;
  let totalExcerptBytes = 0;
  capsule.claims.forEach((claim, claimIndex) => {
    const label = `capsule.claims[${claimIndex}]`;
    assertAllowedKeys(claim, CAPSULE_CLAIM_KEYS, label);
    if (typeof claim.id !== "string" || !SAFE_ID.test(claim.id) || ids.has(claim.id)) throw new Error(`${label}.id is invalid`);
    ids.add(claim.id);
    if (typeof claim.claim !== "string" || !claim.claim.trim()) throw new Error(`${label}.claim is required`);
    if (claim.claim.length > VERIFIER_CAPSULE_LIMITS.max_claim_chars) throw new Error(`${label}.claim is too large`);
    if (!Array.isArray(claim.evidence) || !claim.evidence.length) throw new Error(`${label}.evidence is required`);
    claim.evidence.forEach((evidence, evidenceIndex) => {
      evidenceCount += 1;
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
      assertAllowedKeys(evidence, CAPSULE_EVIDENCE_KEYS, evidenceLabel);
      assertAllowedKeys(evidence.excerpt, CAPSULE_EXCERPT_KEYS, `${evidenceLabel}.excerpt`);
      if (typeof evidence.path !== "string" || !evidence.path) throw new Error(`${evidenceLabel}.path is invalid`);
      if (typeof evidence.locator !== "string" || !evidence.locator) throw new Error(`${evidenceLabel}.locator is invalid`);
      if (!HASH_PATTERN.test(evidence.sha256)) throw new Error(`${evidenceLabel}.sha256 is invalid`);
      if (!Number.isInteger(evidence.size_bytes) || evidence.size_bytes < 0
        || evidence.size_bytes > VERIFIER_CAPSULE_LIMITS.max_evidence_file_bytes) {
        throw new Error(`${evidenceLabel}.size_bytes is invalid`);
      }
      if (!Number.isInteger(evidence.excerpt.start_line) || evidence.excerpt.start_line < 1
        || !Number.isInteger(evidence.excerpt.end_line)
        || evidence.excerpt.end_line < evidence.excerpt.start_line) {
        throw new Error(`${evidenceLabel}.excerpt line range is invalid`);
      }
      if (evidence.locator !== `lines ${evidence.excerpt.start_line}-${evidence.excerpt.end_line}`) {
        throw new Error(`${evidenceLabel}.locator does not match excerpt lines`);
      }
      if (!HASH_PATTERN.test(evidence.excerpt.sha256)) throw new Error(`${evidenceLabel}.excerpt.sha256 is invalid`);
      if (typeof evidence.excerpt.text !== "string") throw new Error(`${evidenceLabel}.excerpt.text is invalid`);
      const excerptBytes = Buffer.byteLength(evidence.excerpt.text, "utf8");
      if (excerptBytes > VERIFIER_CAPSULE_LIMITS.max_excerpt_bytes) throw new Error(`${evidenceLabel}.excerpt is too large`);
      totalExcerptBytes += excerptBytes;
      if (sha256Buffer(Buffer.from(evidence.excerpt.text, "utf8")) !== evidence.excerpt.sha256) {
        throw new Error(`${evidenceLabel}.excerpt.sha256 does not match text`);
      }
    });
  });
  if (evidenceCount > VERIFIER_CAPSULE_LIMITS.max_evidence_entries) throw new Error("capsule has too many evidence entries");
  if (totalExcerptBytes > VERIFIER_CAPSULE_LIMITS.max_total_excerpt_bytes) throw new Error("capsule excerpts are too large");
  const { capsule_sha256: ignored, ...core } = capsule;
  if (sha256Buffer(serializeVerifierCapsule(core)) !== capsule.capsule_sha256) {
    throw new Error("capsule.capsule_sha256 does not match capsule content");
  }
}

export function readAndValidateVerifierCapsule({ root, capsulePath, expectedSha256 = null, currentCanonicalHash = null }) {
  const file = assertWorkspaceFile(root, capsulePath, "verifier capsule");
  if (!file.relative.startsWith(".ai-workspace/reports/verifier-capsules/")) {
    throw new Error("verifier capsule must be stored under .ai-workspace/reports/verifier-capsules/");
  }
  if (file.stat.size > VERIFIER_CAPSULE_LIMITS.max_capsule_bytes) {
    throw new Error(`verifier capsule exceeds ${VERIFIER_CAPSULE_LIMITS.max_capsule_bytes} bytes`);
  }
  const serialized = fs.readFileSync(file.full, "utf8");
  const fileSha256 = sha256Buffer(serialized);
  if (expectedSha256 !== null && fileSha256 !== expectedSha256) {
    throw new Error("verifier capsule file SHA-256 does not match result binding");
  }
  const capsule = parseJsonObject(serialized, "verifier capsule");
  validateCapsuleShape(capsule);
  if (currentCanonicalHash !== null && capsule.workspace.canonical_hash !== currentCanonicalHash) {
    throw new Error("verifier capsule canonical hash is stale");
  }
  const productFile = path.join(root, ".ai-workspace", "product.json");
  const currentProductHash = fs.existsSync(productFile) ? sha256File(productFile) : null;
  if (capsule.workspace.product_state_sha256 !== currentProductHash) {
    throw new Error("verifier capsule product state is stale");
  }
  capsule.claims.forEach((claim, claimIndex) => {
    claim.evidence.forEach((evidence, evidenceIndex) => {
      const label = `capsule.claims[${claimIndex}].evidence[${evidenceIndex}]`;
      const current = assertWorkspaceFile(root, evidence.path, `${label}.path`);
      const buffer = fs.readFileSync(current.full);
      if (buffer.length !== evidence.size_bytes || sha256Buffer(buffer) !== evidence.sha256) {
        throw new Error(`${label} source file changed after capsule creation`);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      const lines = splitLinesPreserve(text);
      if (evidence.excerpt.end_line > lines.length) {
        throw new Error(`${label}.excerpt exceeds current source line count`);
      }
      const excerpt = lines.slice(evidence.excerpt.start_line - 1, evidence.excerpt.end_line).join("");
      if (excerpt !== evidence.excerpt.text) throw new Error(`${label} excerpt no longer matches source file`);
    });
  });
  return { capsule, path: file.relative, sha256: fileSha256 };
}

export function capsuleEvidenceKey(value) {
  return `${value.path}\u0000${value.locator}\u0000${value.sha256}`;
}
