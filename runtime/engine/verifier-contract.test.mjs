import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relative) {
  return fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
}

test("workspace_verifier is a one-response capsule-only medium-effort agent", () => {
  const agent = read("agents/workspace_verifier.toml");
  assert.match(agent, /^model_reasoning_effort = "medium"$/m);
  assert.match(agent, /Do not call tools/);
  assert.match(agent, /one assistant response/);
  assert.match(agent, /"protocol_version": 2/);
  assert.match(agent, /"checks": \[\]/);
  assert.doesNotMatch(agent, /120-second|120 seconds|tool calls are allowed/i);
});

test("orchestration owns a 60-second no-retry watchdog and exact capsule check", () => {
  const taskSkill = read("skills/workspace-task/SKILL.md");
  const verifySkill = read("skills/workspace-verify/SKILL.md");
  const architecture = read("docs/ARCHITECTURE.md");
  const contract = read("templates/AI_WORKSPACE_CONTRACT.md");
  for (const content of [taskSkill, verifySkill, architecture, contract]) {
    assert.match(content, /60 (?:секунд|seconds)/i);
    assert.doesNotMatch(content, /120 (?:секунд|seconds)/i);
  }
  assert.match(taskSkill, /verifier-capsule --id ID --request PATH/);
  assert.match(taskSkill, /verifier-check --file RESULT --capsule CAPSULE/);
  assert.match(taskSkill, /не является watchdog/);
  assert.match(taskSkill, /без correction loop/);
});

test("protocol schemas and hook enforce capsule-only protocol v2 without correction retries", () => {
  const resultSchema = JSON.parse(read("runtime/schemas/verifier-result.schema.json"));
  const capsuleSchema = JSON.parse(read("runtime/schemas/verifier-capsule.schema.json"));
  const requestSchema = JSON.parse(read("runtime/schemas/verifier-capsule-request.schema.json"));
  assert.equal(resultSchema.properties.protocol_version.const, 2);
  assert.equal(resultSchema.properties.checks.maxItems, 0);
  assert.equal(resultSchema.properties.claims.maxItems, 3);
  assert.equal(capsuleSchema.properties.claims.maxItems, 3);
  assert.equal(requestSchema.properties.claims.maxItems, 3);

  const hookRuntime = read("runtime/engine/verifier-result-runtime.mjs");
  assert.match(hookRuntime, /fallback without retrying the verifier/);
  assert.doesNotMatch(hookRuntime, /decision:\s*"block"/);
});
