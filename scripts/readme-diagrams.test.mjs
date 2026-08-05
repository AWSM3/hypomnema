import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagramName = "evidence-chain.svg";

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("both README variants link the single Hypomnema evidence diagram", () => {
  for (const readmeName of ["README.md", "README.en.md"]) {
    const readme = read(readmeName);
    const linked = [...readme.matchAll(
      /!\[[^\]]+\]\((assets\/readme\/[^)]+\.svg)\)/g,
    )].map((match) => path.basename(match[1]));
    assert.deepEqual(linked, [diagramName]);
  }
  assert.equal(fs.existsSync(path.join(root, "assets", "readme", diagramName)), true);
});

test("README variants have reciprocal language navigation and matching structure", () => {
  const ru = read("README.md");
  const en = read("README.en.md");
  assert.match(
    ru,
    /^<p align="right"><strong>🇷🇺 Русский<\/strong> · <a href="README\.en\.md">🇬🇧 English<\/a><\/p>/,
  );
  assert.match(
    en,
    /^<p align="right"><a href="README\.md">🇷🇺 Русский<\/a> · <strong>🇬🇧 English<\/strong><\/p>/,
  );
  assert.equal((ru.match(/^## /gm) ?? []).length, (en.match(/^## /gm) ?? []).length);
});

test("evidence diagram carries the product identity and enforced record chain", () => {
  const svg = read(path.join("assets", "readme", diagramName));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<title id="title">Hypomnema evidence chain<\/title>/);
  for (const label of ["SOURCE", "CANDIDATE", "DECISION", "ARTIFACT", "VERIFICATION", "HANDOFF"]) {
    assert.equal(svg.includes(label), true, `Missing evidence-chain label: ${label}`);
  }
  assert.equal(svg.includes("Git"), false);
  assert.equal(svg.includes("AI AGENT"), false);
});
