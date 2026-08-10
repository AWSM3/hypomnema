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
  const publicIntegrityCopy = [
    publicCopy,
    read("START_HERE.md"),
    read("docs/POSITIONING.md"),
    read("assets/readme/evidence-chain.svg"),
    read("assets/readme/evidence-chain.ru.svg"),
  ].join("\n");
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
  assert.doesNotMatch(publicIntegrityCopy, /sha-?256|checksum|контрольн\S*\s+сумм/iu);
});

test("RU and EN tell the same fit, anti-fit, evidence and documentation story", () => {
  const ru = read("README.md");
  const en = read("README.en.md");
  assert.match(ru, /^# Hypomnema$/m);
  assert.match(en, /^# Hypomnema$/m);

  for (const value of [
    "## Что остаётся в проекте",
    "## Когда Hypomnema полезна",
    "## Когда Hypomnema не нужна",
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

  assert.match(ru, /конкретной версии результата/);
  assert.match(en, /specific result version/);
  assert.match(ru, /Агент ограничивает время\s+ожидания/);
  assert.match(en, /calling agent bounds how long it waits/i);
  assert.doesNotMatch(ru, /жёсткий срок/);
  assert.doesNotMatch(en, /own deadline/);
  assert.match(ru, /отсутстви[еи] независимого подтверждения/);
  assert.match(en, /missing independent\s+confirmation/);
  assert.match(ru, /передач[аиу]/);
  assert.match(en, /handoff/i);
  assert.match(ru, /больше процесса, чем\s+пользы/);
  assert.match(en, /more process than value/);
});

test("Russian README avoids internal English workflow jargon", () => {
  const ru = read("README.md");
  for (const jargon of [
    "AI-native workspace",
    "AI-агент",
    "iteration",
    "unresolved items",
    "freshness warnings",
    "canonical workspace-state",
    "handoff",
    "summary",
    "outputs",
    "authority/status",
    "verification evidence",
    "brief",
    "manifests",
    "lifecycle-state",
    "brownfield",
    "production change",
    "approval boundary",
    "issue tracker",
    "continuity",
    "product-managed",
    "audit trail",
    "custom agents",
  ]) assert.equal(ru.toLowerCase().includes(jargon.toLowerCase()), false, `English jargon returned: ${jargon}`);
});

test("0.5 and 0.6 documentation covers executed checks and bounded fallback", () => {
  const upgrading = read("docs/UPGRADING.md");
  const start = read("START_HERE.md");
  const example = read("examples/oracle-to-postgresql/README.md");

  assert.match(upgrading, /## Переход на 0\.5\.0/);
  assert.match(upgrading, /verify-run/);
  assert.match(upgrading, /attested/);
  assert.match(upgrading, /## Переход на 0\.6\.0/);
  assert.match(upgrading, /Ожидание отдельной проверки ограничивает вызывающий агент/);
  assert.match(upgrading, /детерминированной проверке/);
  assert.match(start, /Время ожидания ограничивает\s+вызывающий агент/);
  assert.match(start, /независимое\s+подтверждение не получено/);
  assert.match(example, /Сохрани фактически выполненный результат и основания/);
  assert.match(example, /что проверено фактическим запуском/);
});

test("plugin metadata uses the Hypomnema identity and the same resume vocabulary", () => {
  const plugin = JSON.parse(read(".codex-plugin/plugin.json"));
  assert.equal(plugin.name, "hypomnema");
  assert.equal(plugin.version, "0.6.0");
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
  assert.equal(profiles.product_version, "0.6.0");
  const include = profiles.profiles["reusable-template"].include;
  for (const entry of [
    "CONTRIBUTING.md",
    "docs/**",
    "hooks/**",
    "scripts/readme-positioning.test.mjs",
  ]) assert.equal(include.includes(entry), true, `Profile does not include ${entry}`);
  for (const file of [
    "CONTRIBUTING.md",
    "hooks/hooks.json",
    "docs/ARCHITECTURE.md",
    "docs/UPGRADING.md",
    "docs/POSITIONING.md",
  ]) assert.equal(fs.existsSync(path.join(root, file)), true, `Missing packaged file ${file}`);
});
