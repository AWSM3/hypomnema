import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  capsuleEvidenceKey,
  readAndValidateVerifierCapsule,
} from "./verifier-capsule-runtime.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TOP_LEVEL_KEYS = new Set([
  "protocol_version", "agent", "capsule", "status", "snapshot", "verdict", "claims", "findings", "checks",
  "skipped_checks", "unknowns", "risks", "refused_actions", "recommended_next_action", "mutation_attempted",
]);
const CAPSULE_REF_KEYS = new Set(["path", "sha256"]);
const SNAPSHOT_KEYS = new Set([
  "workspace_root", "canonical_hash_start", "canonical_hash_end", "product_state_sha256", "stable",
]);
const CLAIM_KEYS = new Set(["claim_id", "claim", "result", "evidence", "gaps"]);
const FINDING_KEYS = new Set(["severity", "finding", "evidence"]);
const EVIDENCE_KEYS = new Set(["path", "locator", "sha256"]);
const CHECK_KEYS = new Set(["command", "exit_code", "result", "read_only"]);
const SKIPPED_KEYS = new Set(["check", "reason"]);

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unexpected field ${key}`);
  }
}

function assertStringArray(value, label, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${label} must be an array of strings`);
  }
}

function normalizeRel(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function validateEvidenceEntry(root, evidence, label, errors) {
  assertAllowedKeys(evidence, EVIDENCE_KEYS, label, errors);
  if (!isPlainObject(evidence)) return;
  for (const field of ["path", "locator", "sha256"]) {
    if (typeof evidence[field] !== "string" || !evidence[field]) errors.push(`${label}.${field} must be a non-empty string`);
  }
  if (typeof evidence.sha256 === "string" && !HASH_PATTERN.test(evidence.sha256)) {
    errors.push(`${label}.sha256 must be a lowercase SHA-256`);
  }
  if (typeof evidence.path !== "string" || !evidence.path) return;
  if (path.isAbsolute(evidence.path) || /^[a-z]+:/i.test(evidence.path)) {
    errors.push(`${label}.path must be root-relative`);
    return;
  }
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, evidence.path);
  const relative = path.relative(resolvedRoot, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`${label}.path leaves the workspace`);
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    errors.push(`${label}.path does not exist: ${evidence.path}`);
    return;
  }
  if (HASH_PATTERN.test(evidence.sha256) && sha256File(full) !== evidence.sha256) {
    errors.push(`${label}.sha256 does not match ${evidence.path}`);
  }
}

function capsuleClaimMaps(binding) {
  if (!binding) return { claims: new Map(), allEvidence: new Set() };
  const claims = new Map();
  const allEvidence = new Set();
  for (const claim of binding.capsule.claims) {
    const evidence = new Set(claim.evidence.map(capsuleEvidenceKey));
    for (const key of evidence) allEvidence.add(key);
    claims.set(claim.id, { ...claim, evidence_keys: evidence });
  }
  return { claims, allEvidence };
}

export function validateVerifierResult({
  root,
  value,
  expectedCanonicalHash,
  expectedCapsulePath = null,
  expectedCapsuleSha256 = null,
}) {
  const errors = [];
  const warnings = [];
  assertAllowedKeys(value, TOP_LEVEL_KEYS, "result", errors);
  if (!isPlainObject(value)) return { valid: false, accepted: false, errors, warnings, evidence_count: 0 };

  if (value.protocol_version !== 2) errors.push("result.protocol_version must equal 2");
  if (value.agent !== "workspace_verifier") errors.push("result.agent must equal workspace_verifier");
  if (!["ok", "partial", "blocked", "stale"].includes(value.status)) errors.push("result.status is invalid");
  if (!["supported", "contradicted", "inconclusive"].includes(value.verdict)) errors.push("result.verdict is invalid");
  if (value.mutation_attempted !== false) errors.push("result.mutation_attempted must be false");
  if (typeof value.recommended_next_action !== "string" || !value.recommended_next_action.trim()) {
    errors.push("result.recommended_next_action must be a non-empty string");
  }
  for (const field of ["unknowns", "risks", "refused_actions"]) {
    assertStringArray(value[field], `result.${field}`, errors);
  }

  let capsuleBinding = null;
  assertAllowedKeys(value.capsule, CAPSULE_REF_KEYS, "result.capsule", errors);
  if (isPlainObject(value.capsule)) {
    if (typeof value.capsule.path !== "string" || !value.capsule.path) errors.push("result.capsule.path is required");
    if (typeof value.capsule.sha256 !== "string" || !HASH_PATTERN.test(value.capsule.sha256)) {
      errors.push("result.capsule.sha256 must be a lowercase SHA-256");
    }
    if (expectedCapsulePath !== null && normalizeRel(value.capsule.path) !== normalizeRel(expectedCapsulePath)) {
      errors.push("result.capsule.path does not match the requested capsule");
    }
    if (expectedCapsuleSha256 !== null && value.capsule.sha256 !== expectedCapsuleSha256) {
      errors.push("result.capsule.sha256 does not match the requested capsule");
    }
    if (typeof value.capsule.path === "string" && HASH_PATTERN.test(value.capsule.sha256)) {
      try {
        capsuleBinding = readAndValidateVerifierCapsule({
          root,
          capsulePath: value.capsule.path,
          expectedSha256: value.capsule.sha256,
          currentCanonicalHash: expectedCanonicalHash,
        });
      } catch (error) {
        errors.push(`result.capsule is invalid: ${error.message}`);
      }
    }
  }

  assertAllowedKeys(value.snapshot, SNAPSHOT_KEYS, "result.snapshot", errors);
  if (isPlainObject(value.snapshot)) {
    if (typeof value.snapshot.workspace_root !== "string" || !value.snapshot.workspace_root) {
      errors.push("result.snapshot.workspace_root must be a non-empty string");
    } else {
      const declaredRoot = path.isAbsolute(value.snapshot.workspace_root)
        ? path.resolve(value.snapshot.workspace_root)
        : path.resolve(root, value.snapshot.workspace_root);
      if (declaredRoot !== path.resolve(root)) errors.push("result.snapshot.workspace_root does not identify the current workspace");
    }
    for (const field of ["canonical_hash_start", "canonical_hash_end"]) {
      if (typeof value.snapshot[field] !== "string" || !HASH_PATTERN.test(value.snapshot[field])) {
        errors.push(`result.snapshot.${field} must be a lowercase SHA-256`);
      }
    }
    if (typeof value.snapshot.stable !== "boolean") errors.push("result.snapshot.stable must be a boolean");
    if (value.snapshot.canonical_hash_start !== expectedCanonicalHash) errors.push("result.snapshot.canonical_hash_start is stale");
    if (value.status === "stale") {
      if (value.snapshot.stable !== false) errors.push("stale result.snapshot.stable must be false");
    } else {
      if (value.snapshot.stable !== true) errors.push("non-stale result.snapshot.stable must be true");
      if (value.snapshot.canonical_hash_end !== expectedCanonicalHash) errors.push("result.snapshot.canonical_hash_end is stale");
    }
    const productFile = path.join(root, ".ai-workspace", "product.json");
    const expectedProductHash = fs.existsSync(productFile) ? sha256File(productFile) : null;
    if (value.snapshot.product_state_sha256 !== expectedProductHash) {
      errors.push("result.snapshot.product_state_sha256 does not match current product state");
    }
    if (capsuleBinding) {
      if (value.snapshot.canonical_hash_start !== capsuleBinding.capsule.workspace.canonical_hash) {
        errors.push("result.snapshot does not match capsule canonical hash");
      }
      if (value.snapshot.product_state_sha256 !== capsuleBinding.capsule.workspace.product_state_sha256) {
        errors.push("result.snapshot does not match capsule product state");
      }
    }
  }

  const expected = capsuleClaimMaps(capsuleBinding);
  let evidenceCount = 0;
  const seenClaimIds = new Set();
  if (!Array.isArray(value.claims)) errors.push("result.claims must be an array");
  else {
    if (!value.claims.length) errors.push("result.claims must contain at least one claim");
    value.claims.forEach((claim, index) => {
      const label = `result.claims[${index}]`;
      assertAllowedKeys(claim, CLAIM_KEYS, label, errors);
      if (!isPlainObject(claim)) return;
      if (typeof claim.claim_id !== "string" || !claim.claim_id) errors.push(`${label}.claim_id is required`);
      else if (seenClaimIds.has(claim.claim_id)) errors.push(`${label}.claim_id is duplicated`);
      else seenClaimIds.add(claim.claim_id);
      const expectedClaim = expected.claims.get(claim.claim_id);
      if (capsuleBinding && !expectedClaim) errors.push(`${label}.claim_id is not present in the capsule`);
      if (typeof claim.claim !== "string" || !claim.claim.trim()) errors.push(`${label}.claim must be a non-empty string`);
      else if (expectedClaim && claim.claim !== expectedClaim.claim) errors.push(`${label}.claim does not match capsule text`);
      if (!["supported", "contradicted", "inconclusive"].includes(claim.result)) errors.push(`${label}.result is invalid`);
      assertStringArray(claim.gaps, `${label}.gaps`, errors);
      if (!Array.isArray(claim.evidence)) errors.push(`${label}.evidence must be an array`);
      else {
        if (["supported", "contradicted"].includes(claim.result) && !claim.evidence.length) {
          errors.push(`${label}.evidence is required for ${claim.result}`);
        }
        claim.evidence.forEach((entry, evidenceIndex) => {
          evidenceCount += 1;
          validateEvidenceEntry(root, entry, `${label}.evidence[${evidenceIndex}]`, errors);
          if (expectedClaim && !expectedClaim.evidence_keys.has(capsuleEvidenceKey(entry))) {
            errors.push(`${label}.evidence[${evidenceIndex}] is not present in the capsule`);
          }
        });
      }
      if (claim.result === "inconclusive" && Array.isArray(claim.gaps) && !claim.gaps.length) {
        errors.push(`${label}.gaps is required for an inconclusive claim`);
      }
    });
    if (capsuleBinding) {
      if (value.claims.length !== expected.claims.size) errors.push("result.claims must cover every capsule claim exactly once");
      for (const claimId of expected.claims.keys()) {
        if (!seenClaimIds.has(claimId)) errors.push(`result.claims is missing capsule claim ${claimId}`);
      }
    }
    if (value.claims.length) {
      const expectedVerdict = value.claims.some((claim) => claim?.result === "contradicted")
        ? "contradicted"
        : value.claims.every((claim) => claim?.result === "supported")
          ? "supported"
          : "inconclusive";
      if (value.verdict !== expectedVerdict) errors.push(`result.verdict must equal ${expectedVerdict} for the reported claims`);
    }
  }

  if (!Array.isArray(value.findings)) errors.push("result.findings must be an array");
  else value.findings.forEach((finding, index) => {
    const label = `result.findings[${index}]`;
    assertAllowedKeys(finding, FINDING_KEYS, label, errors);
    if (!isPlainObject(finding)) return;
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) errors.push(`${label}.severity is invalid`);
    if (typeof finding.finding !== "string" || !finding.finding) errors.push(`${label}.finding must be a non-empty string`);
    if (!Array.isArray(finding.evidence) || !finding.evidence.length) errors.push(`${label}.evidence must contain at least one entry`);
    else finding.evidence.forEach((entry, evidenceIndex) => {
      evidenceCount += 1;
      validateEvidenceEntry(root, entry, `${label}.evidence[${evidenceIndex}]`, errors);
      if (capsuleBinding && !expected.allEvidence.has(capsuleEvidenceKey(entry))) {
        errors.push(`${label}.evidence[${evidenceIndex}] is not present in the capsule`);
      }
    });
  });

  if (!Array.isArray(value.checks)) errors.push("result.checks must be an array");
  else {
    if (value.checks.length) errors.push("result.checks must be empty for capsule-only verification");
    value.checks.forEach((check, index) => {
      const label = `result.checks[${index}]`;
      assertAllowedKeys(check, CHECK_KEYS, label, errors);
    });
  }

  if (!Array.isArray(value.skipped_checks)) errors.push("result.skipped_checks must be an array");
  else value.skipped_checks.forEach((item, index) => {
    const label = `result.skipped_checks[${index}]`;
    assertAllowedKeys(item, SKIPPED_KEYS, label, errors);
    if (!isPlainObject(item)) return;
    if (typeof item.check !== "string" || !item.check) errors.push(`${label}.check must be a non-empty string`);
    if (typeof item.reason !== "string" || !item.reason) errors.push(`${label}.reason must be a non-empty string`);
  });

  if (value.status !== "ok") warnings.push(`verifier status ${value.status} requires deterministic fallback`);
  const valid = errors.length === 0;
  return {
    valid,
    accepted: valid && Boolean(capsuleBinding) && value.status === "ok" && value.snapshot?.stable === true,
    errors,
    warnings,
    evidence_count: evidenceCount,
    capsule_path: capsuleBinding?.path ?? null,
    capsule_sha256: capsuleBinding?.sha256 ?? null,
  };
}

export function verifierHookResponse(input, validation) {
  const reason = validation.errors.slice(0, 4).join("; ") || "verifier result was not accepted";
  if (!validation.valid) {
    return {
      continue: false,
      stopReason: "Hypomnema capsule verifier contract failed.",
      systemMessage: `Independent verification is invalid; run deterministic main-agent fallback without retrying the verifier. ${reason}`,
    };
  }
  if (!validation.accepted) {
    return {
      continue: true,
      systemMessage: validation.warnings.join("; ") || "Independent verification requires fallback.",
    };
  }
  return { continue: true };
}
