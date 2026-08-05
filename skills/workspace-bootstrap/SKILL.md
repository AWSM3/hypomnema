---
name: workspace-bootstrap
description: Initialize a greenfield Hypomnema workspace or adopt an existing brownfield workspace without moving current content. Use when Codex must create the workspace contract, scan an accumulated directory, initialize canonical manifests and derived indexes, or begin a non-mutating migration assessment.
---

# Workspace Bootstrap

Создать control plane или принять существующий workspace без физической реорганизации.

## Workflow

1. Найти корень workspace и прочитать root `AGENTS.md` и доступный AI workspace contract.
2. Определить режим: `greenfield` для нового пространства или `brownfield` для накопленного.
3. Если `.ai-workspace/workspace.yaml` отсутствует, использовать bundled
   `scripts/install-ai-workspace.mjs` из product checkout либо installer из
   plugin package: сначала dry-run, затем `--write`. Не просить пользователя
   запускать эту команду вручную.
4. Не запускать update существующего control plane без явного `--update`.
5. Для brownfield сначала выполнить `scan`, затем `adopt` без `--write`.
6. Показать planned changes и явно подтвердить, что `moved_paths = 0`.
7. Применить adoption через `--write`, если карта не назначает ложную авторитетность и не перемещает данные.
8. Выполнить `rebuild`, `validate` и `audit`.

```powershell
node <plugin-root>\scripts\install-ai-workspace.mjs --target <workspace-root> --mode brownfield
node <plugin-root>\scripts\install-ai-workspace.mjs --target <workspace-root> --mode brownfield --write
.\.ai-workspace\engine\workspace.ps1 scan --write
.\.ai-workspace\engine\workspace.ps1 adopt --mapping <mapping.yaml>
.\.ai-workspace\engine\workspace.ps1 adopt --mapping <mapping.yaml> --write
.\.ai-workspace\engine\workspace.ps1 rebuild
.\.ai-workspace\engine\workspace.ps1 validate
```

## Deterministic core

Использовать bundled installer и engine для scaffold, scan, schema validation,
stable IDs, manifest creation, registry build и validation. Не создавать массово
manifests вручную.

## Agent judgment

Определить режим, предложить candidate classification, объяснить неопределённость и подготовить adoption map. Сохранять смысловой вывод как candidate, пока он не подтверждён.

## Mutation boundary

Не перемещать, не архивировать и не удалять содержательные каталоги. Не назначать `authoritative` без принятого решения или явного подтверждения человека. Любую изменяющую команду сначала выполнять без `--write`.

## Completion evidence

Предоставить scan и adoption reports, число manifests, нулевое число перемещений, успешные `rebuild` и `validate`, а также audit с оставшимися неопределённостями.
