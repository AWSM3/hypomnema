---
name: workspace-audit
description: Perform a non-destructive brownfield audit of an accumulated Hypomnema workspace. Use when Codex must find unregistered top-level items, orphan or missing paths, nested Git boundaries, invalid Git markers, caches, large directories, broken Markdown links, registry drift, or prepare a remediation plan without cleanup or physical reorganization.
---

# Workspace Audit

Исследовать накопившееся состояние в read-only режиме и подготовить remediation plan.

## Workflow

1. Выполнить `scan` и сравнить результат с work-item manifests.
2. Выполнить `audit` сначала без `--write`.
3. Разделить находки на unregistered items, missing paths, Git boundaries, caches/generated, broken links, large directories и semantic uncertainty.
4. Проверить каждый предлагаемый target точным root-relative path.
5. Сформировать приоритетный remediation plan без применения.
6. Записать machine-readable audit report через `--write`.

```powershell
.\.ai-workspace\engine\workspace.ps1 scan --json
.\.ai-workspace\engine\workspace.ps1 audit --json
.\.ai-workspace\engine\workspace.ps1 audit --write --json
```

## Deterministic core

Использовать filesystem inventory, registry comparison, Git-boundary detection, cache rules, size calculation и link checking.

## Agent judgment

Объяснить назначение неоднозначных каталогов, предложить candidate classification и оценить риски remediation.

## Mutation boundary

Не удалять caches, не перемещать каталоги, не исправлять links и не менять Git metadata. Физическая операция относится к отдельному migration plan и требует подтверждения.

## Completion evidence

Предоставить audit report, количество находок, точные пути и non-destructive remediation plan.
