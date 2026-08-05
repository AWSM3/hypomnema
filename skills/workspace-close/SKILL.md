---
name: workspace-close
description: Close or pause a Hypomnema work item after recording outputs, verification, unresolved items, and one next action. Use when Codex must generate a handoff independent of chat history or prepare a non-mutating archive plan.
---

# Workspace Close

Завершить или безопасно приостановить work item с воспроизводимым handoff.

## Workflow

1. Выполнить `orient` и убедиться, что выбрана правильная current iteration.
2. Зарегистрировать outputs, decisions, relations и verification evidence.
3. Назначать authoritative artifact только при наличии принятого решения или подтверждения человека.
4. Закрыть active iteration с summary, unresolved и next action.
5. Выполнить `rebuild`, `validate` и project-specific checks.
6. Сформировать handoff через engine.
7. Предложить lifecycle transition отдельным dry-run.
8. Подготовить archive plan, но не применять физическое архивирование.

```powershell
.\.ai-workspace\engine\workspace.ps1 handoff --id <work-item-id>
.\.ai-workspace\engine\workspace.ps1 handoff --id <work-item-id> --write
.\.ai-workspace\engine\workspace.ps1 transition --id <work-item-id> --status done
```

## Deterministic core

Использовать completeness checks, authority rules, lifecycle transition, handoff generation, registry rebuild и validation.

## Agent judgment

Сформулировать summary, unresolved, последствия, официальный результат и условия возобновления.

## Mutation boundary

Не удалять drafts/tmp и не перемещать данные. Не выполнять transition до успешной проверки и согласования. Archive plan не равен archive apply.

## Completion evidence

Предоставить authoritative outputs, verification results, unresolved items, handoff path, next action и предлагаемый status transition.
