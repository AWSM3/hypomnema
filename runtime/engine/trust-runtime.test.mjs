import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateVerifierResult,
  verifierHookResponse,
} from "./trust-runtime.mjs";
import {
  parseSingleJson,
  validateVerifierPayload,
  verifierHookPayload,
} from "./verification-runtime.mjs";
import { buildVerifierCapsule } from "./verifier-capsule-runtime.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CAPSULE_PATH = ".ai-workspace/reports/verifier-capsules/contract-fixture.json";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-verifier-contract-"));
  fs.mkdirSync(path.join(root, ".ai-workspace", "reports", "verifier-capsules"), { recursive: true });
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ai-workspace", "product.json"), "{\"version\":1}\n", "utf8");
  fs.writeFileSync(path.join(root, "evidence", "proof.txt"), "proof\n", "utf8");
  const built = buildVerifierCapsule({
    root,
    id: "contract-fixture",
    canonicalHash: HASH_A,
    createdAt: "2026-08-09T00:00:00.000Z",
    request: {
      schema_version: 1,
      claims: [{
        id: "claim-proof",
        claim: "The fixture evidence exists.",
        evidence: [{ path: "evidence/proof.txt", start_line: 1, end_line: 1 }],
      }],
    },
  });
  fs.writeFileSync(path.join(root, ...CAPSULE_PATH.split("/")), built.serialized, { encoding: "utf8", flag: "wx" });
  return { root, built };
}

function evidence(fx) {
  const item = fx.built.capsule.claims[0].evidence[0];
  return { path: item.path, locator: item.locator, sha256: item.sha256 };
}

function validResult(fx) {
  return {
    protocol_version: 2,
    agent: "workspace_verifier",
    capsule: { path: CAPSULE_PATH, sha256: fx.built.sha256 },
    status: "ok",
    snapshot: {
      workspace_root: ".",
      canonical_hash_start: HASH_A,
      canonical_hash_end: HASH_A,
      product_state_sha256: fx.built.capsule.workspace.product_state_sha256,
      stable: true,
    },
    verdict: "supported",
    claims: [{
      claim_id: "claim-proof",
      claim: "The fixture evidence exists.",
      result: "supported",
      evidence: [evidence(fx)],
      gaps: [],
    }],
    findings: [],
    checks: [],
    skipped_checks: [{
      check: "additional evidence collection",
      reason: "capsule-only verifier contract forbids tool calls",
    }],
    unknowns: [],
    risks: [],
    refused_actions: [],
    recommended_next_action: "Accept the independently reviewed claim.",
    mutation_attempted: false,
  };
}

function validate(fx, value) {
  return validateVerifierResult({
    root: fx.root,
    value,
    expectedCanonicalHash: HASH_A,
    expectedCapsulePath: CAPSULE_PATH,
    expectedCapsuleSha256: fx.built.sha256,
  });
}

function expectInvalid(fx, mutate, pattern) {
  const value = structuredClone(validResult(fx));
  mutate(value);
  const result = validate(fx, value);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), pattern);
}

test("capsule-only verifier contract accepts one fully bound protocol v2 result", () => {
  const fx = fixture();
  try {
    const result = validate(fx, validResult(fx));
    assert.equal(result.valid, true);
    assert.equal(result.accepted, true);
    assert.equal(result.evidence_count, 1);
    assert.equal(result.capsule_path, CAPSULE_PATH);
    assert.equal(result.capsule_sha256, fx.built.sha256);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("protocol v2 rejects unbound claims, non-capsule evidence, tools, and stale variants", async (t) => {
  const fx = fixture();
  try {
    const cases = [
      ["unexpected top-level field", (v) => { v.extra = true; }, /unexpected field extra/],
      ["wrong protocol", (v) => { v.protocol_version = 1; }, /protocol_version must equal 2/],
      ["wrong agent", (v) => { v.agent = "other"; }, /must equal workspace_verifier/],
      ["wrong capsule path", (v) => { v.capsule.path = "other.json"; }, /does not match the requested capsule/],
      ["wrong capsule hash", (v) => { v.capsule.sha256 = HASH_B; }, /does not match the requested capsule/],
      ["invalid status", (v) => { v.status = "done"; }, /status is invalid/],
      ["mutation attempted", (v) => { v.mutation_attempted = true; }, /mutation_attempted must be false/],
      ["wrong workspace root", (v) => { v.snapshot.workspace_root = "evidence"; }, /does not identify/],
      ["stale start hash", (v) => { v.snapshot.canonical_hash_start = HASH_B; }, /canonical_hash_start is stale/],
      ["wrong product hash", (v) => { v.snapshot.product_state_sha256 = HASH_B; }, /product state/],
      ["empty claims", (v) => { v.claims = []; }, /at least one claim|cover every capsule claim/],
      ["wrong claim id", (v) => { v.claims[0].claim_id = "claim-other"; }, /not present in the capsule/],
      ["changed claim text", (v) => { v.claims[0].claim = "Different claim"; }, /does not match capsule text/],
      ["supported without evidence", (v) => { v.claims[0].evidence = []; }, /evidence is required for supported/],
      ["inconclusive without gaps", (v) => { v.claims[0].result = "inconclusive"; v.claims[0].evidence = []; v.verdict = "inconclusive"; }, /gaps is required/],
      ["invented locator", (v) => { v.claims[0].evidence[0].locator = "lines 1-2"; }, /not present in the capsule/],
      ["wrong evidence hash", (v) => { v.claims[0].evidence[0].sha256 = HASH_B; }, /does not match|not present in the capsule/],
      ["finding outside capsule", (v) => { v.findings = [{ severity: "high", finding: "problem", evidence: [{ ...evidence(fx), locator: "lines 2-2" }] }]; }, /not present in the capsule/],
      ["tool call reported", (v) => { v.checks = [{ command: "validate", exit_code: 0, result: "ok", read_only: true }]; }, /must be empty/],
      ["verdict contradicts claims", (v) => { v.verdict = "inconclusive"; }, /must equal supported/],
    ];
    for (const [name, mutate, pattern] of cases) {
      await t.test(name, () => expectInvalid(fx, mutate, pattern));
    }

    await t.test("partial is structurally valid but not accepted", () => {
      const value = validResult(fx);
      value.status = "partial";
      const result = validate(fx, value);
      assert.equal(result.valid, true);
      assert.equal(result.accepted, false);
      assert.match(result.warnings.join("\n"), /requires deterministic fallback/);
    });

    await t.test("stale is structurally valid but not accepted", () => {
      const value = validResult(fx);
      value.status = "stale";
      value.snapshot.stable = false;
      value.snapshot.canonical_hash_end = HASH_B;
      const result = validate(fx, value);
      assert.equal(result.valid, true);
      assert.equal(result.accepted, false);
    });

    await t.test("current canonical drift forces fallback", () => {
      const result = validateVerifierPayload({
        root: fx.root,
        value: validResult(fx),
        expectedCanonicalHash: HASH_A,
        currentCanonicalHash: HASH_B,
        expectedCapsulePath: CAPSULE_PATH,
        expectedCapsuleSha256: fx.built.sha256,
      });
      assert.equal(result.valid, true);
      assert.equal(result.accepted, false);
      assert.match(result.warnings.join("\n"), /canonical hash changed/);
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("verifier hook fails invalid JSON immediately without a correction loop", () => {
  const invalid = { valid: false, accepted: false, errors: ["bad JSON"], warnings: [] };
  const first = verifierHookResponse({ stop_hook_active: false }, invalid);
  assert.equal(first.continue, false);
  assert.equal("decision" in first, false);
  assert.match(first.systemMessage, /fallback without retrying/);
  const accepted = verifierHookResponse(
    { stop_hook_active: false },
    { valid: true, accepted: true, errors: [], warnings: [] },
  );
  assert.deepEqual(accepted, { continue: true });
});

test("verifier hook validates event identity and exact capsule-bound JSON", () => {
  const fx = fixture();
  try {
    const base = {
      hook_event_name: "SubagentStop",
      agent_type: "workspace_verifier",
      stop_hook_active: false,
      last_assistant_message: JSON.stringify(validResult(fx)),
    };
    assert.deepEqual(verifierHookPayload({ root: fx.root, input: base, currentCanonicalHash: HASH_A }), { continue: true });
    const wrongAgent = verifierHookPayload({
      root: fx.root,
      input: { ...base, agent_type: "workspace_explorer" },
      currentCanonicalHash: HASH_A,
    });
    assert.equal(wrongAgent.continue, false);
    const invalid = verifierHookPayload({
      root: fx.root,
      input: { ...base, last_assistant_message: "not-json" },
      currentCanonicalHash: HASH_A,
    });
    assert.equal(invalid.continue, false);
    assert.equal("decision" in invalid, false);
    assert.throws(() => parseSingleJson("{}\n{}", "result"), /Unexpected non-whitespace character|Unexpected token/);
    assert.throws(() => parseSingleJson("[]", "result"), /exactly one JSON object/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
