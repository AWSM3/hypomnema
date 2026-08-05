import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("public copy does not promote commodity or implementation details", () => {
  const publicCopy = [read("README.md"), read("README.en.md")].join("\n");
  const forbidden = [
    "среда, готовая к хранению и обновлению через Git",
    "Git-ready environment",
    "Git обновляет практики, а не вашу работу",
    "eight focused skills",
    "восемь специализированных навыков",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "SQLite index",
    "workspace_verifier",
  ];
  for (const value of forbidden) {
    assert.equal(publicCopy.includes(value), false, `Forbidden public claim returned: ${value}`);
  }
  assert.doesNotMatch(publicCopy, /\bGit-ready\b/i);
  assert.doesNotMatch(publicCopy, /\bsafe(?:ly)?\b/i);
  assert.doesNotMatch(publicCopy, /безопасн/iu);
});

test("RU and EN tell the same fit, anti-fit, evidence and documentation story", () => {
  const ru = read("README.md");
  const en = read("README.en.md");
  assert.match(ru, /^# Hypomnema$/m);
  assert.match(en, /^# Hypomnema$/m);

  for (const value of [
    "## Что сохраняет Hypomnema",
    "## Для каких задач он рассчитан",
    "## Когда он, скорее всего, лишний",
    "## Документация",
  ]) assert.equal(ru.includes(value), true, `Missing RU section: ${value}`);
  for (const value of [
    "## What Hypomnema preserves",
    "## When it fits",
    "## When it probably does not fit",
    "## Documentation",
  ]) assert.equal(en.includes(value), true, `Missing EN section: ${value}`);

  for (const document of [
    "START_HERE.md",
    "docs/ARCHITECTURE.md",
    "docs/UPGRADING.md",
    "docs/POSITIONING.md",
    "CONTRIBUTING.md",
  ]) {
    assert.equal(ru.includes(document), true, `RU README does not link ${document}`);
    assert.equal(en.includes(document), true, `EN README does not link ${document}`);
  }

  for (const readme of [ru, en]) {
    assert.match(readme, /subject checksum|checked file checksum|checksum проверенного файла/);
    assert.match(readme, /Handoff|handoff/);
    assert.match(readme, /more process than value|больше процесса, чем пользы/);
  }
});

test("plugin metadata uses the Hypomnema identity and the same resume vocabulary", () => {
  const plugin = JSON.parse(read(".codex-plugin/plugin.json"));
  assert.equal(plugin.name, "hypomnema");
  assert.equal(plugin.version, "0.4.0");
  assert.equal(plugin.interface.displayName, "Hypomnema");
  const copy = [
    plugin.description,
    plugin.interface.shortDescription,
    plugin.interface.longDescription,
  ].join(" ").toLowerCase();
  assert.match(copy, /resum/);
  assert.match(copy, /trace/);
  assert.match(copy, /verification/);
  assert.doesNotMatch(copy, /git-ready|skills|models|sqlite/);
});

test("reusable profile ships the public documentation and positioning guard", () => {
  const profiles = JSON.parse(read("profiles.json"));
  assert.equal(profiles.product_version, "0.4.0");
  const include = profiles.profiles["reusable-template"].include;
  for (const entry of [
    "CONTRIBUTING.md",
    "docs/**",
    "scripts/readme-positioning.test.mjs",
  ]) assert.equal(include.includes(entry), true, `Profile does not include ${entry}`);
  for (const file of [
    "CONTRIBUTING.md",
    "docs/ARCHITECTURE.md",
    "docs/UPGRADING.md",
    "docs/POSITIONING.md",
  ]) assert.equal(fs.existsSync(path.join(root, file)), true, `Missing packaged file ${file}`);
});
