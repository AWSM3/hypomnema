# Архитектура Hypomnema

Hypomnema — локальный lifecycle-слой для длительной работы с AI-агентом.
Пользователь сообщает намерение, evidence и решения в разговоре; главный агент
поддерживает состояние workspace и остаётся единственным canonical writer.

## Canonical state

Источник истины — manifests в `.ai-workspace/manifests/`. Сущности имеют stable
ID и не зависят от имени каталога или истории чата:

- `work-item` — задача и её текущий lifecycle;
- `source` — источник, provenance, freshness и unknowns;
- `decision` — варианты, принятое решение и evidence;
- `iteration` — одна цель, summary, outputs, проверки и следующий шаг;
- `artifact` — результат с authority, lineage и checksum;
- `verification` — validator, result, evidence/report и checksum subject;
- `relation` — явная связь между сущностями;
- `proposal` — candidate change до принятия.

Generated Markdown index, JSON registry и SQLite — производные projections. Их
можно пересобрать командой `rebuild`; они не заменяют manifests.

## Evidence chain

Источник не становится решением автоматически. Candidate inference остаётся
candidate, human decision записывается отдельно, artifact связывается с задачей
и sources, а verification относится к конкретной версии локального файла.

Для `result=passed` engine требует хотя бы один `report` или `evidence`. Для
локального source/artifact он пересчитывает SHA-256 перед записью и сохраняет
`subject_sha256`. `validate` обнаруживает drift между файлом и manifest. Команда
`refresh` обновляет facts и сбрасывает изменённый artifact в `not-verified`.

Это evidence record, а не утверждение, что engine сам запустил внешний test
command: достоверность переданного report/evidence остаётся ответственностью
validator workflow.

## Handoff и восстановление

`orient` восстанавливает цель, активную или последнюю закрытую iteration,
accepted decisions, связанные outputs, verification records, unresolved items,
freshness warnings и следующий шаг. `handoff --write` сохраняет тот же срез в
`.ai-workspace/generated/handoffs/`.

Artifact принадлежит задаче через поле `work_item` или accepted relation
`produces`. Один artifact может ссылаться на несколько sources.

## Границы изменений

- Изменяющие workspace-команды сначала формируют dry-run; запись требует
  `--write`.
- Физическая миграция paths создаёт детерминированный plan и применяется только
  с точным отдельно подтверждённым `plan_hash`.
- Migration preconditions проверяют collisions, checksum дерева, nested Git,
  manifest и Markdown rewrites; при ошибке apply выполняет rollback sequence.
- Candidate inference не становится human decision или authoritative artifact
  без соответствующего evidence и подтверждения.

## Read-only readers

`workspace_explorer` и `workspace_verifier` — optional read-only роли для узких
исследовательских и review-задач. Их результат является candidate evidence;
решения, canonical writes и verification records остаются ответственностью
главного агента. При отсутствии schema-valid результата главный агент выполняет
детерминированные проверки сам и не записывает independent verdict.

В engine нет общего multi-process lock для canonical writers. Одновременные
записывающие процессы не поддерживаются; orchestration должен сохранять правило
single writer.

## Ownership boundary

Installer различает product-managed runtime/skills/templates и instance-owned
workspace state. Полная таблица и update protocol приведены в
[UPGRADING.md](UPGRADING.md).

## Требования

- Node.js 22+;
- локальная файловая система;
- отдельный сервер и внешняя база данных не требуются.
