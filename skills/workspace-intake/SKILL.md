---
name: workspace-intake
description: Register new work, local or external sources, provenance, initial scope, and unknowns in an AI-native workspace. Use when a new request, project, task, research topic, document, repository, URL, or dependency enters the workspace and must receive stable identity before substantive work begins.
---

# Workspace Intake

Зарегистрировать новую работу и источники до начала содержательной обработки.

## Workflow

1. Выполнить `orient`, чтобы не создать дубликат.
2. Определить, является ли вход новым work item, source или продолжением существующего элемента.
3. Зафиксировать фактические path/URI, checksum, размер, время регистрации и freshness policy.
4. Предложить kind, context, relations, scope и unknowns отдельно от фактов.
5. Выполнить команды без `--write`, проверить IDs и diff.
6. Применить точные команды с `--write`.
7. Выполнить `rebuild` и `validate`.

```powershell
.\.ai-workspace\engine\workspace.ps1 register-work-item --path <path> --title <title> --kind <kind> --context <context>
.\.ai-workspace\engine\workspace.ps1 register-source --kind <kind> --uri <uri> --provenance <provenance> --freshness <policy> --unknown <unknown>
```

## Deterministic core

Использовать engine для ID creation, source registration, checksum, manifest serialization и registry update.

## Agent judgment

Определить смысловой scope, candidate kind, context, unknowns и предполагаемые relations. Явно указывать, какое поле является inference.

## Mutation boundary

Не копировать и не преобразовывать оригинал без отдельной задачи. Не додумывать retrieved time, owner, authority или provenance. Не изменять canonical manifest напрямую, если существует типизированная команда.

## Completion evidence

Предоставить IDs, provenance, freshness policy, связи с work item, unknowns и успешный post-validation.
