---
name: workspace-iterate
description: Start, continue, and close a semantic iteration in an AI-native workspace. Use when Codex performs research, analysis, design, implementation, artifact production, or decision work that must preserve its goal, inputs, outputs, rejected alternatives, verification, unresolved items, and next action.
---

# Workspace Iterate

Вести осмысленную итерацию с явной целью и завершением.

## Workflow

1. Выполнить `orient` по work item.
2. Продолжить current iteration либо создать новую с семантическим именем и одной проверяемой целью.
3. Зафиксировать inputs и hypotheses до существенной работы.
4. Выполнить предметную работу подходящими domain/artifact skills.
5. Регистрировать sources, decisions, artifacts и relations типизированными командами.
6. Проверить outputs детерминированными validators.
7. Закрыть iteration с summary, unresolved и одним next action.
8. Выполнить `rebuild` и `validate`.

```powershell
.\.ai-workspace\engine\workspace.ps1 iteration-start --work-item <id> --name <semantic-name> --goal <goal>
.\.ai-workspace\engine\workspace.ps1 iteration-close --id <id> --summary <summary> --output <artifact-id> --verification <verification-id> --unresolved <item> --next-action <action>
```

## Deterministic core

Использовать iteration manifests, типизированные relations, lifecycle transitions, checksums, index rebuild и completeness validation.

## Agent judgment

Сформулировать goal, hypotheses, выводы, решения, rejected alternatives и смысловую полноту. Отделять выводы от исходных facts.

## Mutation boundary

Не закрывать iteration без результата или объяснения отсутствия результата. Не подменять validator уверенным текстом. Не переписывать прошлые iterations; фиксировать supersession.

## Completion evidence

Указать goal, outputs, decisions, проверки, unresolved и next action; подтвердить отсутствие drift.
