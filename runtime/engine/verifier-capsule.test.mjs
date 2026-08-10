import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildVerifierCapsule,
  readAndValidateVerifierCapsule,
  VERIFIER_CAPSULE_LIMITS,
} from "./verifier-capsule-runtime.mjs";

const CANONICAL_HASH = "a".repeat(64);
const CAPSULE_PATH = ".ai-workspace/reports/verifier-capsules/test-capsule.json";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-capsule-"));
  fs.mkdirSync(path.join(root, ".ai-workspace", "reports", "verifier-capsules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ai-workspace", "product.json"), "{\"version\":1}\n", "utf8");
  fs.writeFileSync(path.join(root, "proof.txt"), "alpha\nbeta\ngamma\n", "utf8");
  return root;
}

function request() {
  return {
    schema_version: 1,
    claims: [{
      id: "claim-proof",
      claim: "The evidence contains beta on the second line.",
      evidence: [{ path: "proof.txt", start_line: 2, end_line: 2 }],
    }],
  };
}

function build(root, overrides = {}) {
  return buildVerifierCapsule({
    root,
    id: "test-capsule",
    request: request(),
    canonicalHash: CANONICAL_HASH,
    createdAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  });
}

function writeCapsule(root, built) {
  const file = path.join(root, ...CAPSULE_PATH.split("/"));
  fs.writeFileSync(file, built.serialized, { encoding: "utf8", flag: "wx" });
  return file;
}

test("verifier capsule is deterministic, bounded, and bound to current source bytes", () => {
  const root = fixture();
  try {
    const first = build(root);
    const second = build(root);
    assert.equal(first.serialized, second.serialized);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.capsule.claims.length, 1);
    assert.equal(first.evidence_count, 1);
    assert.equal(first.capsule.claims[0].evidence[0].locator, "lines 2-2");
    assert.equal(first.capsule.claims[0].evidence[0].excerpt.text, "beta\n");
    assert.ok(Buffer.byteLength(first.serialized) <= VERIFIER_CAPSULE_LIMITS.max_capsule_bytes);

    writeCapsule(root, first);
    const binding = readAndValidateVerifierCapsule({
      root,
      capsulePath: CAPSULE_PATH,
      expectedSha256: first.sha256,
      currentCanonicalHash: CANONICAL_HASH,
    });
    assert.equal(binding.sha256, first.sha256);
    assert.equal(binding.capsule.capsule_sha256, first.capsule.capsule_sha256);

    fs.appendFileSync(path.join(root, "proof.txt"), "changed\n", "utf8");
    assert.throws(
      () => readAndValidateVerifierCapsule({ root, capsulePath: CAPSULE_PATH, currentCanonicalHash: CANONICAL_HASH }),
      /source file changed after capsule creation/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verifier capsule rejects broad, escaping, oversized, and stale requests", async (t) => {
  const root = fixture();
  try {
    await t.test("more than three claims", () => {
      const broad = request();
      broad.claims = Array.from({ length: 4 }, (_, index) => ({
        id: `claim-${index}`,
        claim: `claim ${index}`,
        evidence: [{ path: "proof.txt", start_line: 1, end_line: 1 }],
      }));
      assert.throws(() => build(root, { request: broad }), /claims exceeds 3/);
    });

    await t.test("path traversal", () => {
      const escaping = request();
      escaping.claims[0].evidence[0].path = "../outside.txt";
      assert.throws(() => build(root, { request: escaping }), /leaves the workspace|does not exist/);
    });

    await t.test("oversized excerpt", () => {
      fs.writeFileSync(path.join(root, "large.txt"), "x".repeat(VERIFIER_CAPSULE_LIMITS.max_excerpt_bytes + 1), "utf8");
      const oversized = request();
      oversized.claims[0].evidence[0] = { path: "large.txt", start_line: 1, end_line: 1 };
      assert.throws(() => build(root, { request: oversized }), /excerpt exceeds/);
    });

    await t.test("stale canonical hash", () => {
      const built = build(root);
      writeCapsule(root, built);
      assert.throws(
        () => readAndValidateVerifierCapsule({ root, capsulePath: CAPSULE_PATH, currentCanonicalHash: "b".repeat(64) }),
        /canonical hash is stale/,
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verifier capsule must be immutable and stored in its dedicated report directory", () => {
  const root = fixture();
  try {
    const built = build(root);
    writeCapsule(root, built);
    assert.throws(
      () => fs.writeFileSync(path.join(root, ...CAPSULE_PATH.split("/")), built.serialized, { flag: "wx" }),
      /EEXIST/,
    );
    fs.writeFileSync(path.join(root, "misplaced-capsule.json"), built.serialized, "utf8");
    assert.throws(
      () => readAndValidateVerifierCapsule({ root, capsulePath: "misplaced-capsule.json", currentCanonicalHash: CANONICAL_HASH }),
      /must be stored under/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
