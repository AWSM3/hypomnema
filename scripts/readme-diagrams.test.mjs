import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagrams = {
  "README.md": "evidence-chain.ru.svg",
  "README.en.md": "evidence-chain.svg",
};

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("each README variant links its localized Hypomnema evidence diagram", () => {
  for (const [readmeName, diagramName] of Object.entries(diagrams)) {
    const readme = read(readmeName);
    const linked = [...readme.matchAll(
      /!\[[^\]]+\]\((assets\/readme\/[^)]+\.svg)\)/g,
    )].map((match) => path.basename(match[1]));
    assert.deepEqual(linked, [diagramName]);
    assert.equal(fs.existsSync(path.join(root, "assets", "readme", diagramName)), true);
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

test("evidence diagram carries the product identity and enforced record chain", () => {
  const svg = read(path.join("assets", "readme", diagrams["README.en.md"]));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<title id="title">Hypomnema evidence chain<\/title>/);
  for (const label of ["SOURCE", "CANDIDATE", "DECISION", "ARTIFACT", "VERIFICATION", "HANDOFF"]) {
    assert.equal(svg.includes(label), true, `Missing evidence-chain label: ${label}`);
  }
  assert.equal(svg.includes("Git"), false);
  assert.equal(svg.includes("AI AGENT"), false);
  assert.equal(svg.includes("exact version"), true);
  assert.doesNotMatch(svg, /sha-?256|checksum/i);
});
test("Russian evidence diagram translates visible and accessibility copy", () => {
  const svg = read(path.join("assets", "readme", diagrams["README.md"]));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<title id="title">Цепочка свидетельств Hypomnema<\/title>/);
  assert.match(svg, /<desc id="desc">[^<]*конкретной версией[^<]*<\/desc>/);
  for (const label of [
    "ИСТОЧНИК",
    "КАНДИДАТ",
    "РЕШЕНИЕ",
    "АРТЕФАКТ",
    "ПРОВЕРКА",
    "ПЕРЕДАЧА",
    "происхождение",
    "актуальность",
    "неизвестное",
    "есть основания",
    "точная версия",
    "текущая версия",
    "следующий шаг",
  ]) {
    assert.equal(svg.includes(label), true, `Missing Russian evidence-chain label: ${label}`);
  }
  for (const untranslated of ["SOURCE", "CANDIDATE", "DECISION", "ARTIFACT", "VERIFICATION", "HANDOFF"]) {
    assert.equal(svg.includes(untranslated), false, `Untranslated evidence-chain label: ${untranslated}`);
  }
  assert.doesNotMatch(svg, /sha-?256|checksum|контрольн\S*\s+сумм/iu);
});
