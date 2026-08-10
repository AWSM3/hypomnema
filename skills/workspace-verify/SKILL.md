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
5. Для каждого исполняемого project-specific validator сначала выполнить
   `verify-run` без `--write`: это только план, команда не запускается и state
   не меняется. Затем повторить тот же вызов с `--write`.
6. Считать `passed` только результатом `verify-run`: он выводится из exit code,
   signal, timeout и стабильности subject/canonical manifests, сохраняет полный
   SHA-256 stdout/stderr, ограниченные диагностические tails и immutable report.
7. При failure исправить canonical source или generator, а не generated
   projection. Failed run уже остаётся evidence и не переписывается.
8. `record-verification` использовать только для внешнего или исторического
   evidence; такая запись имеет assurance `attested`, а не `executed`.

```powershell
node --test runtime/engine/workspace.test.mjs runtime/engine/workspace.integrity.test.mjs runtime/engine/trust-runtime.test.mjs runtime/engine/verification-request.test.mjs runtime/engine/verifier-capsule.test.mjs runtime/engine/verifier-contract.test.mjs runtime/engine/verifier-cli.test.mjs runtime/engine/verify-run.test.mjs scripts/install-ai-workspace.test.mjs scripts/readme-diagrams.test.mjs scripts/readme-positioning.test.mjs skills/workspace-migrate/scripts/workspace-migrate.test.mjs
node --check runtime/engine/workspace.mjs
node --check runtime/engine/trust-runtime.mjs
node --check runtime/engine/verification-runtime.mjs
node --check runtime/engine/verifier-capsule-runtime.mjs
node --check runtime/engine/verifier-result-runtime.mjs
node --check scripts/install-ai-workspace.mjs
# Затем выполнить доступные validators skill-creator и plugin-creator.
```

## Независимое суждение над evidence capsule

После детерминированных tests главный агент создаёт bounded capsule командой
`verifier-capsule`: сначала dry-run, затем `--write`. Одна capsule содержит не
более трёх claims и девяти точных excerpts; больший review делится на несколько
capsule. Verifier получает JSON capsule inline и не вызывает tools.

Parent supervisor ждёт один ответ не более 60 секунд. Timeout, invalid JSON,
`partial`, `blocked` или `stale` немедленно ведут к interrupt и deterministic
fallback без retry. Результат проверяется только командой
`verifier-check --file RESULT --capsule CAPSULE --expected-hash HASH`. Hook
валидирует уже остановившегося агента и не является watchdog.
## Deterministic core

Считать schema, link, identity, lifecycle, lineage, drift, checksum и idempotence проверками engine или специализированных scripts.

## Agent judgment

Объяснить последствия failures и определить, достаточно ли evidence для содержательного утверждения. Явно отметить проверки, которые невозможно выполнить.

## Mutation boundary

Не исправлять generated-файлы вручную. Не подменять `verify-run` ручным
`record-verification --result passed`: выполненная проверка должна иметь assurance
`executed`. Не удалять и не перезаписывать immutable run report; повторный запуск
получает новый verification id.

## Completion evidence

Предоставить команды, exit status, canonical hash, project validators и оставшиеся warnings/failures.
