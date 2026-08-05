---
name: workspace-verify
description: Deterministically validate a Hypomnema workspace contract, manifests, stable identities, local paths, relations, authority evidence, generated index drift, SQLite projection, lineage, links, and project-specific outputs. Use when Codex is preparing completion, handoff, migration, packaging, or any claim that workspace state is correct.
---

# Workspace Verify

Доказать проверяемые свойства workspace программно.

## Workflow

1. Выполнить полный skill validator при изменении engine, schemas или workspace skills.
   При изменении product package также выполнить product tests, syntax checks,
   skill validator и plugin validator.
2. Выполнить `rebuild`, если менялось каноническое состояние.
3. Выполнить `validate`.
4. Выполнить `audit` для paths, nested Git, caches и Markdown links.
5. Запустить project-specific validators для изменённых артефактов.
6. При failure исправить canonical source или generator, а не generated projection.
7. Повторить проверки и зарегистрировать verification evidence.

```powershell
node --test runtime/engine/workspace.test.mjs scripts/install-ai-workspace.test.mjs
node --check runtime/engine/workspace.mjs
node --check scripts/install-ai-workspace.mjs
# Затем выполнить доступные validators skill-creator и plugin-creator.
.\.ai-workspace\engine\workspace.ps1 rebuild
.\.ai-workspace\engine\workspace.ps1 validate
.\.ai-workspace\engine\workspace.ps1 audit --write
```

## Deterministic core

Считать schema, link, identity, lifecycle, lineage, drift, checksum и idempotence проверками engine или специализированных scripts.

## Agent judgment

Объяснить последствия failures и определить, достаточно ли evidence для содержательного утверждения. Явно отметить проверки, которые невозможно выполнить.

## Mutation boundary

Не исправлять generated-файлы вручную. Не присваивать `passed`, если команда не запускалась или завершилась ошибкой. Записывать verification только после фактической проверки.

## Completion evidence

Предоставить команды, exit status, canonical hash, project validators и оставшиеся warnings/failures.
