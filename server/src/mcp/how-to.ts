/**
 * Общие тексты пошаговых инструкций `etn.how_to_*` (0.9.1, ошибка
 * e05d4688-8180-41c6-bcd9-733d088c8981).
 *
 * Текст «как делать батч-запись» нужен в двух местах: как MCP-промпт
 * `etn.how_to_write_batch` (prompts.ts) и как тема справочника
 * `etn.guide { topic: "how_to_write_batch" }` (tools/ops-catalog.ts). Держим
 * его в одном модуле без зависимостей, чтобы описания инструмента, промпта и
 * гайда не расходились и не дублировали текст.
 */

/** Пошаговая инструкция батч-записи `etn.thoughts.write` для сети `networkId`. */
export function writeBatchHowToText(networkId: string): string {
  return [
    `Как записывать связный фрагмент графа одной транзакцией через \`etn.thoughts.write\` в сети ${networkId}.`,
    ``,
    `1. Зачем: один вызов покрывает сценарии \`etn.thoughts.create\`/\`update\`/\`set_active\`/\`upsert_bundle\`, \`etn.links.create\`, \`etn.properties.set\`, \`etn.comments.upsert\` — эти операции заменены батчем, он их единственная замена.`,
    ``,
    `2. Параметр верхнего уровня: \`thoughts[]\` — массив от 1 до \`MCP_MAX_THOUGHTS_PER_WRITE\` (= 50, живёт в \`@etn/shared\`). Превышение → \`VALIDATION_ERROR\` до транзакции. Контракт строгий: любой ключ верхнего уровня вне \`network_id\`/\`local_refs\`/\`thoughts\` (например, \`links\` прямо в корне вызова) → \`VALIDATION_ERROR\` с \`details.fields\`, а не тихий игнор. Граница элемента: один элемент \`thoughts[]\` описывает ОДНУ мысль целиком — её identity (\`thought\`/\`thought_id\`), \`comment\`, \`chronicle\`, \`properties\`, \`links\`, \`attachments\` вместе в одном элементе; разносить части одной мысли по разным элементам нельзя (\`VALIDATION_ERROR\`) — связи между мыслями батча задаются \`links[].target_ref\`, а не дополнительными элементами. Один слот write-бюджета на ВЕСЬ вызов, одна строка \`audit_log\` (\`thought_count\`/\`link_count\`/\`item_count\` в details), одна транзакция.`,
    ``,
    `3. Локальные \`ref\`: каждая позиция \`thoughts[]\` либо адресует существующую мысль (\`thought_id\`), либо описывает новую (\`thought\` с \`title\`/\`synonyms\`/\`type\`/\`active\`). Ровно одно из двух (XOR) — иначе \`VALIDATION_ERROR\`. Существующую мысль правят item-level полями \`title\`/\`synonyms\`/\`type\`/\`type_id\`/\`active\` прямо в элементе (без вложенного \`thought\`): \`synonyms\` ЗАМЕНЯЮТ весь набор, \`type\`/\`type_id\` меняют тип; item-level поле приоритетнее одноимённого в \`thought\`. Item-level \`title\`/\`synonyms\`/\`type\`/\`type_id\` вместе с блоком \`thought\` отвергаются \`VALIDATION_ERROR\` — для новой мысли задавай их внутри \`thought\`; item-level \`active\` допустим и с \`thought\` и приоритетнее \`thought.active\`. Если задано \`thought\` — обязательно объяви \`ref\`; имя действует ТОЛЬКО внутри батча и должно быть уникальным (повтор → \`VALIDATION_ERROR\`). На этапе \`thought\` сервис сначала ищет дубликаты (\`find_duplicates\`), и \`on_duplicate\` решает исход: \`fail\` (по умолчанию, \`details.candidates\`), \`reuse\` (привязывает остальное к существующей), \`update\` (правит title/synonyms/type/active).`,
    ``,
    `4. \`comment\` — постоянный (create-or-update), \`chronicle[]\` — добавляемые хронологические записи (append-only, никогда не перезаписываются). \`properties\` — карта \`ключ → значение\`; ключ — имя из реестра сети (NOT_FOUND если не зарегистрирован). \`attachments[]\` — обычные url/file вложения.`,
    ``,
    `5. Связи — \`links[]\`: каждая ссылка адресует цель либо \`target_id\` (существующая мысль), либо \`target_ref\` (ref внутри этого же батча). Ровно одно из двух; неизвестный \`target_ref\` → \`VALIDATION_ERROR\` ДО записи (видно в \`details.known_refs\`). Циклы \`A → B → A\` корректны: на фазе 2 все мысли уже созданы, на фазе 3 связи разрешаются в реальные id. \`direction\`: \`parent\` — подвешиваем текущую мысль ПОД цель; \`child\` — текущая мысль становится родителем цели. \`type\` (имя) XOR \`type_id\`.`,
    ``,
    `6. На связи тоже можно писать знание в той же транзакции: \`links[].properties\` (карта свойств связи) и \`links[].comment\` (постоянный комментарий связи). Неудача внутри свойств откатывает всю транзакцию — никаких полузаписанных графов.`,
    ``,
    `7. Активность: на каждой реально изменённой сущности сервер эмитит свой \`thought.created\`/\`thought.updated\`/\`comment.created\`/\`comment.updated\`/\`link.created\`/\`attachment.created\` через тот же \`emitAgentActivityEvent\`, что и раньше — другие участники сети видят их в реальном времени. \`warnings\` агрегированы по всему батчу; каждый элемент несёт \`ref\` или \`thought_id\`.`,
    ``,
    `8. Шаблон вызова:`,
    `   \`\`\``,
    `   {`,
    `     "network_id": "${networkId}",`,
    `     "thoughts": [`,
    `       { "ref": "adr", "thought": { "title": "ADR-001", "type": "ADR", "active": true },`,
    `         "comment": { "body_md": "## Context\\n..." },`,
    `         "chronicle": [ { "body_md": "согласовано", "valid_from": "2026-09-06" } ],`,
    `         "properties": { "статус": "согласовано" },`,
    `         "links": [ { "direction": "child", "target_ref": "context",`,
    `                     "type": "применяется к", "comment": { "body_md": "..." } } ] },`,
    `       { "ref": "context", "thought": { "title": "Контекст" },`,
    `         "links": [ { "direction": "child", "target_ref": "adr" } ] }`,
    `     ]`,
    `   }`,
    `   \`\`\``,
    `   Цикл \`adr → context → adr\` через \`target_ref\` корректен: обе мысли создаются на фазе 2, обе связи — на фазе 3.`,
    ``,
    `9. Миграция со старых инструментов:`,
    `- \`etn.thoughts.create\` → один элемент \`thought\` в \`thoughts[]\`.`,
    `- \`etn.thoughts.update\` → \`thought_id\` + item-level \`title\`/\`synonyms\`/\`type\`/\`type_id\`/\`active\` (вложенный \`thought\` — только для НОВОЙ мысли, XOR с \`thought_id\`). \`active: false\` на HOME → \`VALIDATION_ERROR\`.`,
    `- \`etn.thoughts.set_active\` → \`thought_id\` + item-level \`active: false\` (не вложенный \`thought\`).`,
    `- \`etn.thoughts.upsert_bundle\` → новый бандл: \`ref\` + \`thought\`; правка существующей: \`thought_id\` + item-level поля; \`on_duplicate\` поведёт себя так же.`,
    `- \`etn.links.create\` → один элемент с \`links[0]\`. Свойства/комментарий на связи теперь идут инлайн, а не отдельными вызовами.`,
    `- \`etn.properties.set\` → \`properties\` картой в нужном \`thoughts[]\`-элементе (или \`links[].properties\` для свойств на связи).`,
    `- \`etn.comments.upsert\` (постоянный) → \`comment\`; (хронологический) → \`chronicle[]\`.`,
  ].join('\n');
}
