# Разработка Hypomnema

Для разработки нужен Node.js 22+. Runtime не использует npm dependencies.

## Границы изменений

Product source находится в `runtime/`, `skills/`, `scripts/`, `templates/`,
`agents/`, `assets/` и публичной документации. Не включайте instance-owned
manifests, audit/state/generated или содержимое `work/**` в product release,
кроме явно подготовленных review artifacts текущей задачи.

## Product tests

```powershell
node --test `
  runtime/engine/workspace.test.mjs `
  runtime/engine/workspace.integrity.test.mjs `
  runtime/engine/trust-runtime.test.mjs `
  runtime/engine/verification-request.test.mjs `
  runtime/engine/verifier-capsule.test.mjs `
  runtime/engine/verifier-contract.test.mjs `
  runtime/engine/verifier-cli.test.mjs `
  runtime/engine/verify-run.test.mjs `
  skills/workspace-migrate/scripts/workspace-migrate.test.mjs `
  scripts/install-ai-workspace.test.mjs `
  scripts/readme-diagrams.test.mjs `
  scripts/readme-positioning.test.mjs

node --check runtime/engine/workspace.mjs
node --check runtime/engine/trust-runtime.mjs
node --check runtime/engine/verification-runtime.mjs
node --check runtime/engine/verifier-capsule-runtime.mjs
node --check runtime/engine/verifier-result-runtime.mjs
node --check scripts/install-ai-workspace.mjs
node --check skills/workspace-migrate/scripts/workspace-migrate.mjs
```

Plugin manifest и каждый skill дополнительно проходят соответствующие bundled
validators. Installer regression обязана подтверждать update с предыдущего
product state без изменения `workspace.yaml`, manifests, `AGENTS.md`, `work/**`
и пользовательских custom agents.

## Release gate

1. Обновить `VERSION`, plugin metadata, installer defaults и profiles.
2. Синхронизировать bundled и installed product-managed copies через installer
   dry-run, затем `--write`.
3. Запустить полный test suite и syntax checks.
4. Выполнить workspace `rebuild`, `validate` и read-only `audit`.
5. Создать review artifact с scope, evidence, ограничениями и предлагаемым
   commit pathspec.
6. Commit и push выполнять только после отдельного согласования.

## Product copy

Headline claims должны иметь строку в [docs/POSITIONING.md](docs/POSITIONING.md).
Не добавляйте обещания скорости, экономии или снижения ошибок без сравнительного
benchmark. Git, package layout, skills и model IDs не являются headline value.
