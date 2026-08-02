# AI-native workspace contract

Этот workspace управляется через `.ai-workspace/`. AI-агент является его
единственным операционным интерфейсом.

1. Любой содержательный запрос маршрутизировать через `$workspace-task`.
2. Начинать с `.ai-workspace/generated/WORKSPACE_INDEX.md`, `workspace.yaml` и
   `orient`; не полагаться на историю чата.
3. Сообщение пользователя считать входом. Самостоятельно создавать или
   обновлять `work/<slug>/BRIEF.md`, manifests, sources и служебные projections.
4. Не просить пользователя выполнять механические действия с файлами или
   workspace CLI.
5. Предпочитать deterministic script, schema или validator свободной мутации.
6. Сохранять agent inference как candidate с evidence и unknowns.
7. Для mutation сначала выполнять dry-run, затем явно добавлять `--write`.
8. После изменения manifests выполнять `rebuild` и `validate`.
9. Не перемещать, не архивировать и не удалять материалы без утверждённой
   migration map.
10. Не считать непроведённую проверку успешной.
11. При системной ошибке исправлять результат, reusable-механизм и regression
    test.
12. Product update не должен заменять `workspace.yaml`, manifests, историю
    audit trail и содержательные work-item paths. `state` и `generated` можно
    пересобрать из канонического состояния.

13. Главный агент является единственным writer. Коробочные custom agents
    `workspace_explorer` и `workspace_verifier` работают как read-only readers.
14. Пока reader работает, главный агент не изменяет workspace; при запуске он
    передаёт canonical hash и ограниченный непересекающийся scope.
15. Ответ reader является candidate evidence. Перед применением главный агент
    повторно сверяет canonical hash и SHA-256 использованных evidence-файлов.
16. `sandbox_mode = "read-only"` и `approval_policy = "never"` являются
    безопасными defaults, но не обещанием абсолютной изоляции при live override.

Базовые команды:

```powershell
.\.ai-workspace\engine\workspace.ps1 orient
.\.ai-workspace\engine\workspace.ps1 validate
.\.ai-workspace\engine\workspace.ps1 audit --json
```
