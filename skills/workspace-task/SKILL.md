---
name: workspace-task
description: Orchestrate substantive engineering, operations, testing, analysis, architecture, research, migration, and delivery work through a Hypomnema workspace while the agent remains the only user interface. Use whenever a user starts, continues, changes, verifies, pauses, resumes, or closes a task in a managed workspace, even when the user does not name this skill or provide prepared files.
---

# Workspace Task

Вести работу от сообщения пользователя до проверяемого результата. Не требовать
от пользователя создавать каталоги, manifests, brief или другие файлы и не
перекладывать на него выполнение workspace-команд.

## Entry routing

1. Найти корень workspace.
2. Если control plane отсутствует, использовать `$workspace-bootstrap`.
   Запустить bundled installer сначала без `--write`, проверить границы, затем
   применить. Выбрать `greenfield`, если содержательных материалов ещё нет, иначе
   `brownfield`. Ничего не перемещать.
3. Выполнить `validate`. При drift выполнить `rebuild` и повторить `validate`.
4. Выполнить `orient` и определить, относится ли сообщение к существующему work
   item. Не создавать дубликат только из-за новой формулировки.
5. Для нового намерения выполнить раздел «Новая задача». Для продолжения —
   раздел «Продолжение».

## Новая задача

1. Считать сообщение пользователя исходной постановкой. Задать вопрос только
   тогда, когда без ответа можно выбрать неверный объект или совершить рискованное
   действие. Остальные пробелы сохранить как unknowns.
2. Выбрать непротиворечивый root-relative путь. По умолчанию использовать
   `work/<semantic-slug>/`. Создать каталог и заполнить `BRIEF.md` по
   [assets/task-brief.md](assets/task-brief.md). Не оставлять placeholders.
3. Сохранить формулировку пользователя в brief без смыслового расширения.
   Отделить факты, ограничения, assumptions, unknowns и критерии готовности.
4. Через `$workspace-intake` зарегистрировать:
   - work item;
   - `BRIEF.md` как `local-user-request`;
   - явно названные локальные и внешние источники;
   - связи work item с источниками.
5. Kind брать из явной постановки. При неоднозначности использовать
   `unclassified` и candidate proposal, а не уверенную классификацию.
6. Через `$workspace-iterate` открыть первую содержательную iteration. Её цель
   должна уменьшать главный риск или неизвестность, а не только оформлять реестр.
7. Выполнить `rebuild` и `validate`, затем перейти к предметной работе в том же
   turn, если она безопасна и укладывается в запрос.

Всегда выполнять изменяющие engine-команды сначала как dry-run, затем с
`--write`. Создание agent-managed `work/<slug>/BRIEF.md` является частью
явного запроса на начало работы и не требует отдельного согласования.

## Продолжение

1. Использовать `$workspace-orient`; не восстанавливать состояние из памяти чата.
2. Учесть новое сообщение как evidence:
   - дополнить brief датированным уточнением либо создать отдельный source;
   - выполнить `refresh` для изменённого локального source;
   - зарегистрировать новые relations.
3. Продолжить active iteration, если цель прежняя. Если цель достигнута или
   изменилась, корректно закрыть её и открыть следующую.
4. Выполнить предметную работу подходящими domain skills.
5. Регистрировать решения, артефакты и фактически выполненные проверки.
6. После изменения канонического состояния выполнить `rebuild` и `validate`.

## Завершение turn

Перед ответом пользователю зафиксировать:

- выбранный work item и текущую iteration;
- созданные или изменённые артефакты;
- решения и rejected alternatives, если они появились;
- реально выполненные проверки и их результат;
- unresolved items;
- один конкретный next action.

Не закрывать iteration только потому, что закончился turn. Закрывать её, когда
достигнута цель или зафиксирован содержательный отрицательный результат.

## Read-only субагенты

Главный агент остаётся единственным writer и единственным интерфейсом
пользователя. `workspace_explorer` можно использовать для узкого параллельного
сбора evidence. `workspace_verifier` получает только заранее собранную evidence
capsule и выносит независимое суждение без доступа к инструментам.

Не делегировать субагентам intake, orient, решения, изменение manifests,
`rebuild`, фиксацию verification, migration apply, Git-операции или внешние side
effects. Не выполнять никаких мутаций, пока хотя бы один reader работает.

Для `workspace_verifier` использовать fail-bounded цикл:

1. Главный агент сначала выполняет все детерминированные проверки и определяет
   точные root-relative evidence paths и диапазоны строк.
2. Создать JSON request с максимум тремя claims и суммарно девятью evidence
   entries. Для большего review разбить claims на несколько независимых capsule.
3. Выполнить `verifier-capsule --id ID --request PATH` без `--write`, проверить
   план, затем повторить с `--write`. Capsule создаётся эксклюзивно в
   `.ai-workspace/reports/verifier-capsules/` и не перезаписывается.
4. Передать verifier полный JSON capsule inline, её root-relative path и
   full-file SHA-256. Verifier не читает workspace, не вызывает tools и отвечает
   ровно одним JSON object protocol v2.
5. Ждать не более 60 секунд суммарно. Этот срок обеспечивает parent supervisor,
   а не текст prompt и не `SubagentStop` hook. Hook не является watchdog. По
   истечении срока прервать агента, не перезапускать его и перейти к
   deterministic main-agent fallback.
6. Сохранить ответ и выполнить
   `verifier-check --file RESULT --capsule CAPSULE --expected-hash HASH`.
   Принимается только `accepted: true`; result обязан
   покрывать все claims и ссылаться только на evidence из указанной capsule.
7. Hook проверяет лишь уже завершившийся ответ. Невалидный JSON немедленно ведёт
   к fallback без correction loop.
8. После результата или interrupt повторить `validate`; validator заново
   проверяет canonical/product hashes, capsule hash, SHA-256 evidence-файлов и
   точные excerpt bytes до возобновления мутаций.

При timeout, `partial`, `blocked`, `stale` или невалидном ответе явно фиксировать,
что независимое подтверждение не получено. Ответ verifier является candidate
evidence, а не решением и не verification record. Главный агент сам принимает
решение, выполняет изменения и регистрирует реально проведённые проверки.

Перед существенным завершением iteration, product release, migration или
утверждением authoritative результата по возможности запускать
`workspace_verifier`. Если custom agents недоступны, выполнить deterministic
проверки главным агентом и явно отметить отсутствие независимой проверки.

## UI contract

Пользователь взаимодействует только сообщениями агенту.

- Не просить его создавать, перемещать или редактировать workspace-файлы.
- Не просить запускать engine, validators или служебные scripts.
- Можно просить решение, подтверждение, credential/access либо недоступный
  агенту источник, но не механическую работу с каталогом.
- Не показывать внутренние CLI-команды и manifests без запроса пользователя.
- В обычном ответе показывать: результат, существенные unknowns и следующий шаг.

## Safety

- Для проверки использовать `$workspace-verify`.
- Для паузы, handoff или закрытия использовать `$workspace-close`.
- Для brownfield-инвентаризации использовать `$workspace-audit`.
- Физическое перемещение путей выполнять только через `$workspace-migrate` с
  отдельным подтверждением точного plan hash.
- Не назначать authoritative, не объявлять проверку passed и не выполнять
  опасные внешние изменения без требуемого evidence или полномочий.
