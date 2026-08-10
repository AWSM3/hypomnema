# Product claim ledger

Этот реестр отделяет ценность продукта от trust mechanisms, удобства установки
и внутренних деталей. Claim допускается в публичный README только на указанной
surface и только при сохранении evidence status.

| Claim | Class | Evidence | Allowed surface | Status |
|---|---|---|---|---|
| Resume from canonical state | Core value | `orient` regression | README, plugin | mechanism proven; outcome unbenchmarked |
| Verification bound to exact artifact version | Core value | integrity regressions | README, architecture | proven mechanism |
| Executed verification evidence | Trust mechanism | `verify-run` success, failure, timeout and mutation regressions | README, architecture | proven mechanism |
| Complete generated handoff | Core value | handoff regression | README, architecture | proven mechanism |
| Dry-run / explicit write boundary | Trust mechanism | engine tests | architecture | proven |
| Plan-hash physical migration | Trust mechanism | migration regressions | architecture | proven |
| Selective product update | Trust mechanism | installer regression | upgrade guide | proven |
| Local operation, no server | Adoption property | runtime inventory | README once, architecture | proven |
| Agent-maintained workspace files | Adoption property | contract and task skill | onboarding | proven behavior |
| Git compatibility | Commodity adoption property | file layout | upgrade guide only | not a differentiator |
| Skills, schemas, SQLite, model IDs | Implementation fact | repository | architecture/maintainer docs | proven fact |
| Bounded independent review and explicit fallback | Trust mechanism | immutable capsule, protocol v2 acceptance, no-retry hook and orchestration regressions | README, architecture | bounded workflow proven; semantic accuracy unbenchmarked |
| Faster resume or fewer errors | Outcome | comparative benchmark required | nowhere | unproven |

## Copy policy

- Не использовать количественные обещания до сравнительного benchmark.
- Не называть attested evidence доказательством запуска внешней команды.
- Утверждать выполненный запуск только для записи с assurance `executed` и
  неизменяемым run report.
- Не использовать `safe` / «безопасно» без конкретного enforcement boundary.
- Обязательно публиковать fit и anti-fit рядом с core value.
- Изменение headline claim требует обновить этот ledger и regression guard.
