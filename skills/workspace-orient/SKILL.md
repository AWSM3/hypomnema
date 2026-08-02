---
name: workspace-orient
description: Restore operational context from an AI-native workspace registry. Use when Codex or a human returns after a pause, does not remember iteration order, needs the current work item, authoritative artifact, latest iteration, unresolved conflicts, freshness warnings, or a defensible next action.
---

# Workspace Orient

Восстановить контекст из канонического состояния, не полагаясь на историю чата.

## Workflow

1. Выполнить `validate`; при drift выполнить `rebuild` и повторить проверку.
2. Выполнить `orient` для конкретного `--id` или `--path`.
   Для ограниченной выборки по registry использовать `query`; `--full` добавлять
   только когда действительно нужен полный manifest payload.
3. Проверить status, phase, candidate kind, current iteration, next action, authoritative artifacts и существование путей.
4. Прочитать только manifests и содержательные файлы, необходимые для ответа.
5. Отделить подтверждённые факты от candidate classification и интерпретации.
6. Если новое evidence меняет confidence или unknowns существующего proposal, выполнить `proposal-review` сначала как dry-run.
7. Сформулировать: где мы, что официально, что неизвестно, что делать дальше.

```powershell
.\.ai-workspace\engine\workspace.ps1 validate
.\.ai-workspace\engine\workspace.ps1 orient --id <work-item-id> --json
.\.ai-workspace\engine\workspace.ps1 query --type work-item --status waiting --limit 20 --json
.\.ai-workspace\engine\workspace.ps1 proposal-review --id <proposal-id> --reason <reason> --confidence <level>
```

## Deterministic core

Использовать registry query, relation traversal, path validation, authority и freshness checks. Не реконструировать реестр из памяти или названий директорий.

## Agent judgment

Объяснить конфликты, оценить достаточность evidence и предложить next action. Не превращать candidate authority в факт.

## Mutation boundary

Работать read-only. Для изменения next action, kind, status или phase сформировать `propose`, показать diff и применять отдельно. `proposal-review` изменяет только candidate proposal и также требует отдельный `--write`.

## Completion evidence

Назвать выбранный work item, current iteration, официальный артефакт либо его отсутствие, unresolved/freshness warnings и одно конкретное next action.
