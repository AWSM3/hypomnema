import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagramNames = [
  "agent-as-interface.svg",
  "task-lifecycle.svg",
  "git-safe-updates.svg",
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("both README variants link all three local diagrams", () => {
  for (const readmeName of ["README.md", "README.en.md"]) {
    const readme = read(readmeName);
    const linked = [...readme.matchAll(
      /!\[[^\]]+\]\((assets\/readme\/[^)]+\.svg)\)/g,
    )].map((match) => path.basename(match[1]));

    assert.deepEqual(
      linked.sort(),
      [...diagramNames].sort(),
      `${readmeName} must link every diagram exactly once`,
    );
  }
  for (const name of diagramNames) {
    assert.equal(fs.existsSync(path.join(root, "assets", "readme", name)), true);
  }
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

test("diagrams do not restore rejected English labels", () => {
  const combined = diagramNames
    .map((name) => read(path.join("assets", "readme", name)))
    .join("\n");
  const rejectedLabels = [
    "AGENT AS THE LAST UI",
    "TRACEABLE DELIVERY",
    "SAFE EVOLUTION",
    "AI AGENT",
    "Brief и источники",
    "ITERATE UNTIL EVIDENCE",
    "PRODUCT-MANAGED",
    "INSTANCE-OWNED",
    "AGENT SYNC",
    "AUDIT TRAIL",
  ];

  for (const label of rejectedLabels) {
    assert.equal(combined.includes(label), false, `Rejected label returned: ${label}`);
  }
});

test("lifecycle diagram has no orphaned dashed iteration arc", () => {
  const lifecycle = read("assets/readme/task-lifecycle.svg");
  assert.equal(lifecycle.includes("M672 350C730 263 842 257 912 340"), false);
  assert.equal(lifecycle.includes("ITERATE UNTIL EVIDENCE"), false);
});

test("split-color statements use explicit SVG spacing", () => {
  for (const name of ["agent-as-interface.svg", "git-safe-updates.svg"]) {
    const svg = read(path.join("assets", "readme", name));
    assert.match(svg, /<tspan class="lime" dx="24">/);
  }
});
