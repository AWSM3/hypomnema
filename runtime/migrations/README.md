# Schema migrations

`registry.json` фиксирует текущую версию canonical schema и упорядоченный список
миграций. Версия 1 является исходным baseline и поэтому не содержит переходов.

Будущая запись migration должна иметь уникальный ID, `from`, `to`, script,
checksum и regression fixture. Engine не должен принимать новую
`schema_version`, пока соответствующая migration не добавлена и не проверена.
