import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const engine = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "workspace.mjs");

function run(root, ...args) {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", engine, ...args, "--root", root, "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function runRaw(root, ...args) {
  return spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", engine, ...args, "--root", root, "--json"],
    { encoding: "utf8" },
  );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypomnema-fixture-"));
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta"), { recursive: true });
  fs.writeFileSync(path.join(root, "alpha", "README.md"), "# Alpha\n", "utf8");
  fs.writeFileSync(path.join(root, "beta", "note.md"), "[missing](absent.md)\n", "utf8");
  return root;
}

test("brownfield adoption is dry-run first and preserves paths", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    const dry = run(root, "adopt");
    assert.equal(dry.dry_run, true);
    assert.equal(dry.planned_changes, 2);
    assert.equal(fs.readdirSync(path.join(root, ".ai-workspace", "manifests", "work-items")).length, 0);

    const applied = run(root, "adopt", "--write");
    assert.equal(applied.moved_paths, 0);
    assert.equal(fs.existsSync(path.join(root, "alpha", "README.md")), true);
    assert.equal(fs.existsSync(path.join(root, "beta", "note.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rebuild is deterministic for Git-readable projections", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    const first = run(root, "rebuild");
    const indexFile = path.join(root, ".ai-workspace", "generated", "WORKSPACE_INDEX.md");
    const registryFile = path.join(root, ".ai-workspace", "generated", "registry.json");
    const firstIndex = fs.readFileSync(indexFile, "utf8");
    const firstRegistry = fs.readFileSync(registryFile, "utf8");

    const second = run(root, "rebuild");
    assert.equal(second.canonical_hash, first.canonical_hash);
    assert.equal(fs.readFileSync(indexFile, "utf8"), firstIndex);
    assert.equal(fs.readFileSync(registryFile, "utf8"), firstRegistry);
    assert.equal(run(root, "validate").ok, true);

    const db = new DatabaseSync(path.join(root, ".ai-workspace", "state", "workspace.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get("canonical_hash");
    db.close();
    assert.equal(row.value, first.canonical_hash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proposal apply checks preconditions and uses an explicit write boundary", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    const proposal = run(
      root,
      "propose",
      "--id",
      "wi-alpha",
      "--change",
      "kind=research",
      "--change",
      "status=active",
      "--reason",
      "Fixture classification",
      "--confidence",
      "medium",
      "--unknown",
      "Fixture review remains required",
      "--write",
    );
    const proposalManifest = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "proposals", `${proposal.proposal_id}.yaml`),
      "utf8",
    ));
    assert.equal(proposalManifest.confidence, "medium");
    assert.deepEqual(proposalManifest.unknowns, ["Fixture review remains required"]);
    const reviewDry = run(
      root,
      "proposal-review",
      "--id",
      proposal.proposal_id,
      "--reason",
      "Fixture evidence resolved",
      "--confidence",
      "high",
      "--clear-unknowns",
    );
    assert.equal(reviewDry.dry_run, true);
    run(
      root,
      "proposal-review",
      "--id",
      proposal.proposal_id,
      "--reason",
      "Fixture evidence resolved",
      "--confidence",
      "high",
      "--clear-unknowns",
      "--write",
    );
    const reviewedProposal = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "proposals", `${proposal.proposal_id}.yaml`),
      "utf8",
    ));
    assert.equal(reviewedProposal.confidence, "high");
    assert.deepEqual(reviewedProposal.unknowns, []);
    assert.equal(reviewedProposal.reviews.length, 1);
    const orientation = run(root, "orient", "--id", "wi-alpha");
    assert.equal(orientation.work_items[0].candidate_proposals[0].id, proposal.proposal_id);
    const dry = run(root, "apply", "--id", proposal.proposal_id);
    assert.equal(dry.dry_run, true);
    let item = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "work-items", "wi-alpha.yaml"),
      "utf8",
    ));
    assert.equal(item.kind, "unclassified");

    run(root, "apply", "--id", proposal.proposal_id, "--write");
    item = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "work-items", "wi-alpha.yaml"),
      "utf8",
    ));
    assert.equal(item.kind, "research");
    assert.equal(item.status, "active");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate classification requires explicit acceptance and records evidence", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    const mapping = path.join(root, "mapping.yaml");
    fs.writeFileSync(mapping, JSON.stringify({
      schema_version: 1,
      items: {
        alpha: {
          kind: "research",
          evidence: ["alpha/README.md"],
        },
      },
    }), "utf8");
    run(root, "adopt", "--mapping", "mapping.yaml", "--write");
    const dry = run(root, "accept-classification", "--id", "wi-alpha");
    assert.equal(dry.dry_run, true);
    assert.equal(dry.to, "research");

    run(
      root,
      "accept-classification",
      "--id",
      "wi-alpha",
      "--method",
      "fixture-confirmation",
      "--evidence",
      "fixture-evidence",
      "--write",
    );
    const item = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "work-items", "wi-alpha.yaml"),
      "utf8",
    ));
    assert.equal(item.kind, "research");
    assert.equal(item.classification.status, "accepted");
    assert.equal(item.classification.acceptance.method, "fixture-confirmation");
    assert.deepEqual(item.classification.acceptance.evidence, ["fixture-evidence"]);
    run(root, "rebuild");
    const index = fs.readFileSync(
      path.join(root, ".ai-workspace", "generated", "WORKSPACE_INDEX.md"),
      "utf8",
    );
    assert.match(index, /accepted: research/);
    const orientation = run(root, "orient", "--id", "wi-alpha");
    assert.equal(orientation.work_items[0].candidate_kind, null);
    assert.equal(orientation.work_items[0].classification_status, "accepted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact verification updates its canonical verification status", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(
      root,
      "register-artifact",
      "--id",
      "artifact-alpha",
      "--title",
      "Alpha",
      "--kind",
      "markdown-document",
      "--path",
      "alpha/README.md",
      "--role",
      "output",
      "--authority",
      "accepted",
      "--write",
    );
    run(
      root,
      "record-verification",
      "--id",
      "verify-alpha",
      "--subject",
      "artifact-alpha",
      "--validator",
      "fixture-validator",
      "--result",
      "passed",
      "--evidence",
      "fixture-test",
      "--write",
    );
    let artifact = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "artifacts", "artifact-alpha.yaml"),
      "utf8",
    ));
    assert.equal(artifact.verification_status, "passed");
    const verification = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "verifications", "verify-alpha.yaml"),
      "utf8",
    ));
    assert.equal(verification.subject_sha256, artifact.sha256);
    assert.deepEqual(verification.evidence, ["fixture-test"]);
    fs.appendFileSync(path.join(root, "alpha", "README.md"), "changed\n", "utf8");
    run(root, "refresh", "--id", "artifact-alpha", "--write");
    artifact = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "artifacts", "artifact-alpha.yaml"),
      "utf8",
    ));
    assert.equal(artifact.verification_status, "not-verified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit reports broken links without deleting or moving data", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    const result = run(root, "audit", "--write");
    assert.equal(result.broken_links, 1);
    assert.equal(fs.existsSync(path.join(root, "beta", "note.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit accepts existing Codex-style absolute Windows file links", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    const existing = path.join(root, "alpha", "README.md").replaceAll("\\", "/");
    const codexTarget = existing.replace(/^([A-Za-z]:)/, "/$1");
    fs.writeFileSync(path.join(root, "beta", "note.md"), `[absolute](${codexTarget})\n`, "utf8");
    const result = run(root, "audit", "--write");
    assert.equal(result.broken_links, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit understands nested registered paths and still reports stray branches", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    fs.mkdirSync(path.join(root, "work", "group"), { recursive: true });
    fs.renameSync(path.join(root, "alpha"), path.join(root, "work", "group", "alpha"));
    run(root, "repath", "--id", "wi-alpha", "--from", "alpha", "--path", "work/group/alpha", "--write");

    const nested = run(root, "audit", "--write");
    assert.equal(nested.unregistered, 0);

    fs.mkdirSync(path.join(root, "work", "group", "stray"), { recursive: true });
    const withStray = run(root, "audit", "--write");
    assert.equal(withStray.unregistered, 1);
    const report = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "generated", "audit-report.json"),
      "utf8",
    ));
    assert.deepEqual(report.unregistered_work_items, ["work/group/stray"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repath preserves stable identity after an external path move", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    fs.renameSync(path.join(root, "alpha"), path.join(root, "gamma"));

    const dry = run(root, "repath", "--id", "wi-alpha", "--from", "alpha", "--path", "gamma");
    assert.equal(dry.dry_run, true);
    assert.equal(dry.identity_preserved, true);
    run(root, "repath", "--id", "wi-alpha", "--from", "alpha", "--path", "gamma", "--write");
    run(root, "rebuild");

    const item = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "work-items", "wi-alpha.yaml"),
      "utf8",
    ));
    assert.equal(item.id, "wi-alpha");
    assert.equal(item.path, "gamma");
    assert.equal(run(root, "validate").ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("decision captures options, consequences, evidence and supersession", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    run(
      root,
      "register-decision",
      "--id",
      "decision-first",
      "--title",
      "First",
      "--status",
      "accepted",
      "--decision",
      "Use A",
      "--option",
      "A",
      "--option",
      "B",
      "--consequence",
      "Runtime remains local",
      "--evidence",
      "alpha/README.md",
      "--write",
    );
    run(
      root,
      "register-decision",
      "--id",
      "decision-second",
      "--title",
      "Second",
      "--status",
      "accepted",
      "--decision",
      "Use B",
      "--supersedes",
      "decision-first",
      "--evidence",
      "alpha/README.md",
      "--write",
    );
    run(root, "rebuild");
    const first = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "manifests", "decisions", "decision-first.yaml"),
      "utf8",
    ));
    assert.deepEqual(first.considered_options, ["A", "B"]);
    assert.deepEqual(first.consequences, ["Runtime remains local"]);
    assert.equal(run(root, "validate").ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("authoritative artifact requires evidence and accepted authority decision", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    const rejected = runRaw(
      root,
      "register-artifact",
      "--id",
      "artifact-alpha",
      "--title",
      "Alpha",
      "--kind",
      "document",
      "--path",
      "alpha/README.md",
      "--role",
      "output",
      "--authority",
      "authoritative",
      "--write",
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /требует --evidence/);

    run(
      root,
      "register-decision",
      "--id",
      "decision-authority",
      "--title",
      "Authority",
      "--status",
      "accepted",
      "--decision",
      "Alpha is authoritative",
      "--evidence",
      "alpha/README.md",
      "--write",
    );
    run(
      root,
      "register-artifact",
      "--id",
      "artifact-alpha",
      "--title",
      "Alpha",
      "--kind",
      "document",
      "--path",
      "alpha/README.md",
      "--role",
      "output",
      "--authority",
      "authoritative",
      "--evidence",
      "decision-authority",
      "--decision",
      "decision-authority",
      "--write",
    );
    run(root, "rebuild");
    assert.equal(run(root, "validate").ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("query provides bounded summaries and source intake preserves uncertainty", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    run(
      root,
      "register-source",
      "--id",
      "src-alpha",
      "--kind",
      "local-document",
      "--uri",
      "alpha/README.md",
      "--provenance",
      "fixture-observation",
      "--unknown",
      "Owner is not confirmed",
      "--write",
    );
    run(root, "rebuild");
    const query = run(root, "query", "--type", "source", "--limit", "1");
    assert.equal(query.count, 1);
    assert.equal("payload" in query.items[0], false);
    const full = run(root, "query", "--id", "src-alpha", "--full");
    assert.equal(full.items[0].payload.provenance, "fixture-observation");
    assert.deepEqual(full.items[0].payload.unknowns, ["Owner is not confirmed"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("orient restores latest iteration, accepted decision, unresolved items and freshness warnings", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    run(
      root,
      "register-work-item",
      "--id",
      "wi-context",
      "--path",
      "alpha",
      "--title",
      "Context",
      "--kind",
      "research",
      "--context",
      "fixture",
      "--write",
    );
    run(
      root,
      "register-source",
      "--id",
      "src-stale",
      "--kind",
      "external-link",
      "--uri",
      "https://example.test/source",
      "--retrieved-at",
      "2020-01-01T00:00:00Z",
      "--freshness",
      "max-age-days:30",
      "--write",
    );
    run(
      root,
      "register-decision",
      "--id",
      "decision-context",
      "--title",
      "Context decision",
      "--status",
      "accepted",
      "--decision",
      "Keep local-first",
      "--evidence",
      "src-stale",
      "--write",
    );
    run(root, "register-relation", "--from", "wi-context", "--to", "src-stale", "--type", "relates-to", "--write");
    run(root, "register-relation", "--from", "wi-context", "--to", "decision-context", "--type", "implements", "--write");
    run(
      root,
      "iteration-start",
      "--id",
      "iter-context-one",
      "--work-item",
      "wi-context",
      "--name",
      "context-one",
      "--goal",
      "Restore context",
      "--write",
    );
    run(
      root,
      "iteration-close",
      "--id",
      "iter-context-one",
      "--summary",
      "Context captured",
      "--next-action",
      "Refresh source",
      "--unresolved",
      "External owner is unknown",
      "--write",
    );
    run(
      root,
      "iteration-start",
      "--id",
      "iter-context-two",
      "--work-item",
      "wi-context",
      "--name",
      "context-two",
      "--goal",
      "Capture newer context",
      "--write",
    );
    run(
      root,
      "iteration-close",
      "--id",
      "iter-context-two",
      "--summary",
      "Newer context captured",
      "--next-action",
      "Refresh source",
      "--unresolved",
      "Newer unresolved item",
      "--write",
    );
    run(root, "rebuild");

    const orientation = run(root, "orient", "--id", "wi-context");
    const item = orientation.work_items[0];
    assert.equal(item.latest_completed_iteration.id, "iter-context-two");
    assert.equal(item.latest_official_decision.id, "decision-context");
    assert.deepEqual(item.unresolved, ["Newer unresolved item"]);
    assert.equal(item.related_sources[0].status, "stale");
    assert.equal(item.freshness_warnings.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status transition is typed, audited and projected transactionally to SQLite", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "brownfield", "--id", "fixture");
    run(root, "adopt", "--write");
    const dry = run(root, "transition", "--id", "wi-alpha", "--status", "active", "--phase", "research");
    assert.equal(dry.dry_run, true);
    run(root, "transition", "--id", "wi-alpha", "--status", "active", "--phase", "research", "--write");
    run(root, "rebuild");
    assert.equal(run(root, "validate").ok, true);

    const db = new DatabaseSync(path.join(root, ".ai-workspace", "state", "workspace.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT status, phase FROM entities WHERE id = ?").get("wi-alpha");
    db.close();
    assert.equal(row.status, "active");
    assert.equal(row.phase, "research");

    const events = fs.readFileSync(path.join(root, ".ai-workspace", "audit", "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.command === "transition"), true);
    assert.equal(events.some((event) => event.command === "rebuild"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("product checkout folders are excluded from work-item discovery", () => {
  const root = fixture();
  try {
    run(root, "init", "--mode", "greenfield", "--id", "fixture");
    for (const dir of [
      ".codex-plugin",
      "scripts",
      "runtime/engine",
      "skills/workspace-task",
      "templates",
      "examples",
      "assets/readme",
      "agents",
      "docs",
    ]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(root, "scripts", "install-ai-workspace.mjs"), "// installer\n", "utf8");
    fs.writeFileSync(path.join(root, "runtime", "engine", "workspace.mjs"), "// engine\n", "utf8");
    fs.writeFileSync(path.join(root, "skills", "workspace-task", "SKILL.md"), "# task\n", "utf8");

    run(root, "scan", "--write");
    const report = JSON.parse(fs.readFileSync(
      path.join(root, ".ai-workspace", "generated", "scan-report.json"),
      "utf8",
    ));
    assert.deepEqual(report.items.map((item) => item.path), ["alpha", "beta"]);
    for (const dir of ["runtime", "scripts", "skills", "templates", "examples", "assets", "agents", "docs"]) {
      assert.equal(report.excluded.includes(dir), true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
