<p align="right"><a href="README.md">🇷🇺 Русский</a> · <strong>🇬🇧 English</strong></p>

# AI-native Workspace

AI-native Workspace is a Git-ready environment where an AI agent takes an
engineering or analytical task from the first message to a verifiable result
and a clean handoff to the next contributor.
People work through conversation only: they do not have to create directories,
briefs, registries, or operational files by hand.

It supports software development, DevOps, testing, analysis, architecture,
research, migrations, and technical leadership.

![An AI agent accepts a regular request and manages the brief, sources, iterations, and verifiable result](assets/readme/agent-as-interface.svg)

## What the team gets

- **One clear interface.** People describe intent, constraints, and decisions;
  the agent organizes the workspace and operational data.
- **Context that outlives the chat.** The brief, sources, unknowns, decisions,
  and evidence are stored in a Git-friendly form and restored after a pause.
- **Verifiable progress.** Every iteration has one goal, real checks, and one
  explicitly recorded next action.

The same workflow serves developers, DevOps engineers, testers, analysts, and
technical leads. The task content changes; the way it is managed does not.

![A task moves from request through context, iteration, and checks to a result and handoff](assets/readme/task-lifecycle.svg)

## Start in one step

After cloning the repository, open the directory in your AI agent and describe
the task:

```text
We need to migrate the data storage layer from Oracle to PostgreSQL.
Start with an inventory, risks, and the first verifiable iteration.
Do not change the production environment yet.
```

The root `AGENTS.md` guides the agent. It installs or verifies the control
layer, creates the work directory and brief, registers sources, starts an
iteration, and records the next action on its own.

For more detail, see [START_HERE.md](START_HERE.md) (Russian).

## What is inside

- `$workspace-task` as the single user entry point;
- eight focused skills for bootstrap, intake, context recovery, iterations,
  verification, closure, audits, and safe migrations;
- two bundled read-only readers: the fast `workspace_explorer` and the
  independent `workspace_verifier`, each pinned to a GPT-5.6 model;
- a local Node.js 22 engine with no external database or npm dependencies;
- versioned schemas, policies, and a migration registry;
- canonical registries, an audit trail, and a rebuildable SQLite index;
- a dry-run-first installer with safe product updates.

## Read-only roles and models

`workspace_explorer` uses `gpt-5.6-terra` with `medium` reasoning;
`workspace_verifier` uses `gpt-5.6-sol` with `high` reasoning.

| Model | Strength | Limitation in this workflow |
|---|---|---|
| `gpt-5.6-terra` | Fast read-heavy scans, large files, lower cost | Less depth for ambiguous multi-step verification |
| `gpt-5.6-sol` | Maximum depth, planning, validation, and edge cases | Higher latency and token usage |
| `gpt-5.6-luna` | Low-cost bulk extraction and classification | Too quality-aggressive for brownfield evidence and independent verification |

The model IDs are pinned intentionally: role configuration takes precedence
over the parent model defaults. Availability depends on account policy, so the
selection should be rechecked for every product release.

## Git updates the practices, not your work

![Git updates the product layer while preserving user tasks, artifacts, decisions, and verification history](assets/readme/git-safe-updates.svg)

The workspace is split into two layers with different ownership rules.

### Product layer

Delivered by the upstream Git repository:

```text
.codex-plugin/
assets/
agents/
runtime/
skills/
scripts/
templates/
.gitignore
AGENTS.md
LICENSE
README.md
README.en.md
START_HERE.md
examples/
profiles.json
VERSION
```

On the next request, the agent synchronizes installed copies into
`.ai-workspace/`, `.agents/`, and `.codex/agents/`.

### User work data

Created by the agent during work and never overwritten by a product update:

```text
.ai-workspace/workspace.yaml
.ai-workspace/manifests/
.ai-workspace/state/
.ai-workspace/generated/
.ai-workspace/audit/
work/
```

Canonical registries, the audit trail, and substantive artifacts can live in a
user branch or a personal copy of the repository. The SQLite index and derived
views are rebuildable.

### How updates work

The user receives a new version through a regular `git pull`. On the next
substantive request, the agent compares `VERSION` with
`.ai-workspace/product.json`, shows a preview, and applies product-file changes
only.

The installer does not replace `workspace.yaml`, registries, audit history, the
root `AGENTS.md`, `work/**`, or other user-owned paths. Inside `.codex/agents/`,
it manages only `workspace_explorer.toml` and `workspace_verifier.toml`; custom
agents with other names are preserved. The `state` and `generated` directories
can be safely rebuilt from canonical state.

## Install into an existing project

The agent uses the bundled installer. For diagnostics or product development,
it can also be run directly:

```powershell
node scripts/install-ai-workspace.mjs `
  --target D:\path\to\workspace `
  --mode brownfield
```

By default, the command only shows the plan. Add `--write` to apply it.
To update an existing installation:

```powershell
node scripts/install-ai-workspace.mjs `
  --target D:\path\to\workspace `
  --update `
  --write
```

## Verify the product

```powershell
node --test runtime/engine/workspace.test.mjs scripts/install-ai-workspace.test.mjs scripts/readme-diagrams.test.mjs
node --check runtime/engine/workspace.mjs
node --check scripts/install-ai-workspace.mjs
```

The plugin manifest is additionally checked with the `plugin-creator`
validator, and skills with the `skill-creator` validator.

## Example

See the complete conversational
[Oracle → PostgreSQL migration example](examples/oracle-to-postgresql/README.md)
(Russian), with no manual workspace-file setup.

## License

This project is licensed under the
[Apache License 2.0](LICENSE). It permits use, modification, and distribution
provided that the license terms and notices of changed files are preserved. It
also includes an explicit patent grant.
