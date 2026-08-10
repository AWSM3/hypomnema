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

Verification records разделены по уровню доказательности:

- `assurance=attested` создаётся ручной командой `record-verification` для
  внешнего или исторического report/evidence. Такая запись не доказывает, что
  engine сам запускал validator;
- `assurance=executed` создаётся только `verify-run`. Dry-run показывает план и
  ничего не исполняет. В режиме `--write` команда запускается напрямую с
  `shell=false`, отдельными executable/argv, ограничением времени и выбранным
  рабочим каталогом внутри workspace.

`verify-run` вычисляет result из фактического exit code, signal и timeout,
сохраняет SHA-256 полного stdout/stderr и ограниченные tails, снимает checksum
subject и canonical manifests до и после запуска, затем атомарно связывает
immutable report с verification manifest. Ненулевой exit code, signal, timeout,
изменение subject или canonical manifests дают только `failed`. `validate`
проверяет report checksum, согласованность report/manifest и запрещает ложный
`passed` для `assurance=executed`.

Для локального source/artifact engine сохраняет `subject_sha256`; `refresh`
обновляет facts и сбрасывает изменённый artifact в `not-verified` без удаления
предыдущего evidence.

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
главного агента.

Главный агент собирает bounded evidence capsule детерминированно: максимум три
claims, девять точных line excerpts, SHA-256 исходных файлов, canonical hash и
product-state hash. `workspace_verifier` получает capsule inline, не имеет права
вызывать tools и возвращает один строгий JSON object protocol v2. Result
принимается только при точном совпадении capsule path/hash, полного покрытия
claims и повторной проверке текущих evidence bytes.

Engine не выдаёт себя за API запуска Codex custom agents: spawn, wait и interrupt
выполняет поддерживающий их клиент. Parent supervisor ограничивает общее ожидание
60 секундами и при timeout прерывает verifier без retry. `SubagentStop` hook
срабатывает только после остановки агента, поэтому проверяет результат, но не
служит watchdog. Невалидный ответ сразу ведёт к deterministic fallback.
Read-only sandbox остаётся защитным default, но не абсолютной изоляцией; основной
барьер — capsule-only контракт без tool calls.

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
