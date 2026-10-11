# fixture-slice — нарезчик фикстур из бэкапа сети `.etnx`

`client/scripts/fixture-slice.mjs` вырезает из экспорта сети `.etnx` минимальные
СНИМКИ реальных данных для юнит-тестов — по указанию (id мысли, имя типа мысли,
вид комментария). Закрывает требование стандарта планки тестов (`cf236d42`):
фикстуры — снимки реального markdown / реального HTML единого рендерера /
реального JSON-контракта API, а не рукодельные мини-сеты.

## Что пишет

На каждую выбранную пару «мысль + комментарий» — три файла в каталоге `--out`:

| Файл | Что это |
| --- | --- |
| `<base>.md`   | `body_md` реального комментария из манифеста, байт-в-байт |
| `<base>.html` | вывод единого рендерера `@etn/markdown` (`renderMarkdown(<base>.md)`) |
| `<base>.json` | снимок мысли в конверте REST `{ "data": <Thought> }` (`GET /thoughts/:id`) |

Вывод детерминирован: стабильная сортировка (заголовок мысли → id комментария),
из JSON вырезаны «плавающие» поля (`created_at`/`updated_at`/`created_by`/…).
Один и тот же `.etnx` всегда даёт побайтово одинаковые файлы — снимки можно
коммитить и сравнивать диффом.

## Откуда взять `.etnx`

Источник — экспорт тестовой сети полигона `etn-dev` («Тест 1», карточка сети
`a29fd66f`, id `790bf625-f9e9-45d4-93f6-b695665311e1`). MCP-действие:

```
etn.ops { action: "export.subgraph", params: {
  network_id: "790bf625-f9e9-45d4-93f6-b695665311e1",
  seed_ids: [ "<HOME сети>" ],
  radius: 20,
  format: "etnx",
  etnx_options: { include_types: true, include_attachments: true,
                  include_chronology: true, include_subtree: true, subtree_depth: 20 }
} }
```

Полный экспорт сети отдаётся base64-строкой в ответе инструмента (поле
`content_b64`) — для большой сети (несколько МБ) результат практичнее сохранять
в файл вне контекста агента (stdio-клиент MCP либо будущий REST-экспорт).
Сохранять архив следует в `.tmp/` (каталог в `.gitignore`).

## Использование

```bash
# обзор кандидатов (для выбора цели), ничего не пишется
node client/scripts/fixture-slice.mjs --etnx .tmp/test1.etnx --list

# один комментарий мысли по id (можно короткий префикс) с заданным именем
node client/scripts/fixture-slice.mjs --etnx .tmp/test1.etnx \
  --thought 8d8187ef --name etn-map-desktop \
  --out client/tests/fixtures/real-markdown

# все комментарии мыслей типа, первые N
node client/scripts/fixture-slice.mjs --etnx .tmp/test1.etnx \
  --type "ключевой раздел" --limit 5 --out client/tests/fixtures/<set>
```

Опции: `--etnx` (обязателен), `--out` (обязателен, кроме `--list`),
`--thought <id|префикс>`, `--type <имя типа>`, `--kind permanent|chronological|all`
(по умолчанию `all`), `--limit <n>`, `--name <base>` (для одиночной нарезки),
`--list`.

Зависимостей не добавляет: только node builtins и workspace-пакет
`@etn/markdown` (нужна собранная `markdown/dist` — `npm run build:shared`).
`.etnx` читается встроенным минимальным zip-reader'ом на `node:zlib`.

## Восстановление сети из бэкапа

Процедура восстановления тестовой сети «Тест 1» из `.etnx` — в постоянном
комментарии карточки сети `a29fd66f` (раздел «Восстановление из бэкапа»).
Кратко: `import.dry_run` (план без побочных эффектов) → `import.subgraph`
(`confirm: true`, целевая сеть ≠ «Тест 1» при проверке) → сверка счётчиков.
