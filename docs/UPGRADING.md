# Обновление Hypomnema

Hypomnema обновляет продуктовый слой отдельно от состояния конкретной работы.
Перед записью installer показывает точный список изменений.

## Ownership

| Слой | Примеры | Поведение при update |
|---|---|---|
| Product-managed | runtime, schemas, policies, bundled skills, templates, managed custom agents | заменяется содержимым новой версии после dry-run |
| Instance-owned | `workspace.yaml`, manifests, audit trail, `work/**`, пользовательские файлы | сохраняется |
| Derived | generated index, registry, SQLite projection | пересобирается из manifests |

В `.codex/agents/` installer управляет только именами, перечисленными в
product state. Custom agents под другими именами не меняются. Корневой
`AGENTS.md` после первоначальной установки также считается instance-owned.

## Protocol

1. Агент сравнивает `VERSION` bundle с `.ai-workspace/product.json` instance.
2. Installer запускается с `--update` без `--write` и показывает changes.
3. После проверки применяется тот же update с `--write`.
4. Engine выполняет `rebuild` и `validate`.

Для maintainer-диагностики:

```powershell
node scripts/install-ai-workspace.mjs --target D:\path\to\workspace --update
node scripts/install-ai-workspace.mjs --target D:\path\to\workspace --update --write
```

## Что сохраняется

- stable IDs существующих work items, sources, decisions и artifacts;
- имена task directories и локального checkout;
- `workspace.yaml` и canonical manifests;
- audit history и содержимое `work/**`;
- custom agents вне product-managed names.

Ребрендинг 0.4.0 не переименовывает старые stable IDs, локальные каталоги или
Git repository. Это позволяет обновиться без физической migration.

## Важное ограничение

Локальные изменения в product-managed файле будут заменены bundled версией.
Если изменение должно сохраниться, перенесите его в instance-owned extension
или включите в сам продукт до update.
