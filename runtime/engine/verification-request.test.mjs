import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildVerificationRequest } from "./verification-runtime.mjs";

test("generated verification ids preserve uniqueness suffixes at the 128-character limit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-verification-id-"));
  try {
    const options = {
      subject: `artifact-${"s".repeat(240)}`,
      validator: `validator-${"v".repeat(240)}`,
      command: process.execPath,
    };
    const ids = Array.from({ length: 32 }, () => buildVerificationRequest(root, options).id);

    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.ok(id.length <= 128);
      assert.match(id, /-\d{8}T\d{9}z-\d+-[a-f0-9]{12}$/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
