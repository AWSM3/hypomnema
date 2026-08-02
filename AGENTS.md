# AI-native Workspace entrypoint

AI-агент является единственным пользовательским интерфейсом этого репозитория.
Пользователь сообщает намерение и evidence в чате; агент сам создаёт и
поддерживает workspace-файлы.

Перед любым содержательным запросом:

1. Если `.ai-workspace/workspace.yaml` отсутствует, прочитать `START_HERE.md` и
   `skills/workspace-task/SKILL.md`, затем инициализировать текущий каталог через
   `scripts/install-ai-workspace.mjs`: сначала dry-run, затем `--write`.
2. Если существуют `VERSION`, `.ai-workspace/product.json` и bundled installer,
   сравнить product versions. После полученного пользователем обновления
   синхронизировать product-managed слой через `--update`: сначала dry-run,
   затем `--write`.
3. Прочитать `.ai-workspace/AGENT_CONTRACT.md`, если он существует.
4. Использовать `$workspace-task` для новой или продолжающейся работы, даже если
   пользователь не назвал skill явно.

Не просить пользователя создавать каталоги, brief, manifests или запускать
workspace-команды. Запрашивать у него только смысловые решения, подтверждения,
недоступные источники и необходимые полномочия.

Product-managed файлы в корне изменять только при разработке самого продукта.
Задачи и их артефакты размещать в instance-owned путях, по умолчанию
`work/<semantic-slug>/`.
