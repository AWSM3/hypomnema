---
name: workspace-migrate
description: Plan and apply a plan-hash-approved physical path migration in a Hypomnema workspace. Use when Codex must preserve stable IDs and nested Git boundaries, detect collisions and path references, apply exact moves, validate links, or provide rollback evidence.
---

# Workspace Migrate

Физически менять пути только по утверждённому plan hash.

## Workflow

1. Выполнить `validate` и read-only `audit`.
2. Создать root-relative mapping без glob и без перекрывающихся source paths.
3. Запустить bundled script `scripts/workspace-migrate.mjs plan` без `--write`.
4. Проверить collisions, nested Git, manifest updates, Markdown rewrites,
   deterministic plain-path rewrites, явно обоснованные exceptions и rollback sequence.
5. Записать plan через `--write` и передать plan hash человеку.
6. Не применять plan, пока человек отдельно не утвердит этот hash.
7. После утверждения сначала выполнить `apply` без `--write`.
8. Применить точный plan с `--approval <hash> --write`.
9. Повторить `rebuild`, `validate` и `audit`.
10. При Windows `EPERM` не обходить lock через copy/delete. Выполнить
    `scripts/find-locking-processes.ps1`, устранить подтверждённый handle и
    повторить apply только после проверки rollback state.

```powershell
.\.ai-workspace\engine\workspace.ps1 validate
.\.ai-workspace\engine\workspace.ps1 audit --json
node <skill-root>\scripts\workspace-migrate.mjs plan --root <workspace> --mapping <map> --output <plan>
node <skill-root>\scripts\workspace-migrate.mjs apply --root <workspace> --plan <plan> --approval <hash>
```

## Deterministic core

Использовать script для path normalization, collision checks, nested Git
inventory, stable-ID manifest rewrites, Markdown link rewrites, precondition
hashes, offset-bound plain-text rewrites, exact moves, automatic rollback и post-validation.

## Agent judgment

Выбрать целевую иерархию, объяснить semantic grouping и разобрать plain-path
warnings. Для смысловых имён, которые совпали с path, добавить узкое exception
с причиной; не считать совпадение строки безопасной ссылкой без контекста.

## Mutation boundary

Plan всегда read-only по умолчанию. Apply требует точного plan hash и `--write`.
Не включать cleanup, удаление, Git history rewrite или перенос между томами в
одну migration map. При collision или изменившемся checksum остановиться.

## Completion evidence

Предоставить mapping, plan hash, список moves и Git boundaries, нулевые
collisions, обработанные warnings, apply report, rollback sequence, новый
canonical hash и успешные `validate`/`audit`.
