/**
 * Единый сериализатор проекции списочных ответов — общий для обоих фасадов
 * сервера: MCP (`etn.*`) и REST (`GET /networks/:id/...`). Живёт в домене, а не
 * в `server/src/mcp`, потому что доменные сервисы (например,
 * `instructions-service`) применяют его сами, а домен не имеет права зависеть
 * от MCP-фасада (задача 6ee904ad, тех.проект «Оптимизация MCP-интерфейса ETN»;
 * задача 65cf6074 — распространение норм на REST; требование «Компактная
 * проекция ответов view compact и full»).
 *
 * Зачем отдельный модуль. Оба уже исправленных дефекта утечек (2aacd23a —
 * визуальные поля в списках, 29def270 — дубль тела комментария в resolve)
 * имели одну причину: каждый инструмент собирал ответ по-своему, поэтому
 * новое поле приходилось вычищать в каждом месте отдельно. Здесь собрана
 * единственная точка, через которую проходят записи списочных ответов:
 * MCP — `etn.thoughts.search`, `views.run`, `resolve`, `neighbors`, `subgraph`,
 * `instructions`, `networks.structure`, `types.list`, `find_duplicates`,
 * `trash.list`; REST — перечень `GET /networks/:id/instructions` (через тот же
 * доменный `getNetworkInstructions`). Новый список обязан звать эти функции,
 * а не собирать проекцию руками.
 *
 * Что снимается в compact (по требованию 964aaae2, блок «Актуализация 0.8.3»):
 *   * визуальные поля — `fg_color`, `bg_color`, `font_*`, `icon_kind`,
 *     `icon_attachment_id` (тип {@link CompactVisualFieldKeys} из `@etn/shared`);
 *   * сервисные поля — `version`, `created_by`, `updated_by`,
 *     `marked_for_deletion_at`, `marked_for_deletion_by`, `manual_position`;
 *   * у записей-мыслей дополнительно `is_protected`/`is_root` (они не несут
 *     знания агенту — это признаки HOME/защиты, видны только в полной проекции
 *     точечного `etn.thoughts.get`).
 * `icon` (само значение emoji/ссылки) остаётся — оно семантично.
 *
 * Пустые массивы/объекты (`views`, `synonyms`, `link_types`, `chronological`)
 * не сериализуются вовсе: агент отличает «поля нет» от «поле пусто» по
 * контракту инструмента, а пустой контейнер — только зря жжёт токены.
 *
 * Отдельно {@link stripStructuralLinkProperties} — перечень разделов
 * `etn.networks.structure` не несёт структурные свойства-связи
 * («Родители»/«Потомки»): их числа уже есть в `counters`.
 *
 * Точечный `etn.thoughts.get` сохраняет полную проекцию: он НЕ использует
 * {@link projectThoughtRow}, у него собственная форма (`toCompactThought` в
 * `catalogs.ts`), где сервисные поля и `synonyms` остаются.
 */

import type { CompactVisualFieldKeys } from '@etn/shared';

// ---------------------------------------------------------------------------
// Наборы ключей
// ---------------------------------------------------------------------------

/**
 * Визуальные поля стиля, выносимые из списочных записей MCP. Тот же список,
 * что и ширина {@link CompactVisualFieldKeys} в `@etn/shared`, — одно
 * определение на две проекции.
 */
export const COMPACT_VISUAL_FIELD_KEYS: readonly CompactVisualFieldKeys[] = [
  'fg_color',
  'bg_color',
  'icon_color',
  'font_bold',
  'font_italic',
  'font_underline',
  'font_strike',
  'icon_kind',
  'icon_attachment_id',
];

/** Сервисные поля: ревизия строки, авторство и технические отметки. */
export const COMPACT_SERVICE_FIELD_KEYS: readonly string[] = [
  'version',
  'created_by',
  'updated_by',
  'marked_for_deletion_at',
  'marked_for_deletion_by',
  'manual_position',
];

/**
 * Пустые контейнеры, которые не сериализуются: имя ключа → признак пустоты.
 * `chronological` — объект со списком `entries`; он считается пустым, когда
 * записей нет (`entries: []`).
 */
export const COMPACT_EMPTY_CONTAINER_KEYS: readonly string[] = [
  'views',
  'synonyms',
  'link_types',
  'chronological',
];

/** Стилевые оверрайды ребра — снимаются только у связей (`trash.list`). */
const LINK_STYLE_FIELD_KEYS: readonly string[] = ['color', 'style', 'width'];

const SERVICE = new Set<string>(COMPACT_SERVICE_FIELD_KEYS);
const VISUAL = new Set<string>(COMPACT_VISUAL_FIELD_KEYS);
const EMPTY_CONTAINERS = new Set<string>(COMPACT_EMPTY_CONTAINER_KEYS);

const THOUGHT_DROP = new Set<string>([
  ...VISUAL,
  ...SERVICE,
  // Признаки HOME/защиты — не знание агента, только полная проекция get.
  'is_protected',
  'is_root',
]);
/** Типы и прочие справочные записи сохраняют `is_root` — это признак иерархии L21. */
const TYPE_DROP = new Set<string>([...VISUAL, ...SERVICE]);
const LINK_DROP = new Set<string>([...VISUAL, ...SERVICE, ...LINK_STYLE_FIELD_KEYS]);

// ---------------------------------------------------------------------------
// Ядро
// ---------------------------------------------------------------------------

/**
 * Пустой ли контейнер: массив без элементов или объект без ключей. Значения
 * `null`/`undefined` пустыми контейнерами не считаются — `comment_preview:
 * null`/`permanent: null` несут смысл «комментария нет». `chronological`
 * в `subgraph` — это объект метаданных (`entries`/`total`/`returned`/
 * `truncated`), он не пуст и сохраняется; правило сработает только на
 * буквально пустом `[]`/`{}`.
 */
export function isEmptyContainer(_key: string, value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Снять с одной записи служебные/визуальные ключи и пустые контейнеры.
 * Проекция неглубокая: вложенные справочники (`properties`, `type`, `meta`)
 * остаются как есть — у них своя форма, а ключи вроде `created_by` внутри
 * записи хронологии семантичны (автор записи) и исчезать не должны.
 */
function strip<T>(row: T, drop: ReadonlySet<string>): T {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...(row as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (drop.has(key)) {
      delete out[key];
      continue;
    }
    if (EMPTY_CONTAINERS.has(key) && isEmptyContainer(key, out[key])) delete out[key];
  }
  return out as T;
}

/**
 * Проекция записи-мысли (мысль, ссылка на мысль, карточка resolve, хит
 * поиска/дублей, строка корзины): визуальные + сервисные поля + признаки
 * HOME/защиты + пустые контейнеры.
 */
export function projectThoughtRow<T>(row: T): T {
  return strip(row, THOUGHT_DROP);
}

/**
 * Проекция записи-типа/справочной записи (тип мысли/связи, запись каталога,
 * `node_section_type`, строка раздела `networks.structure`): визуальные +
 * сервисные поля + пустые контейнеры. `is_root` сохраняется — это признак
 * иерархии типов.
 */
export function projectTypeRow<T>(row: T): T {
  return strip(row, TYPE_DROP);
}

/**
 * Проекция записи-ребра (`etn.trash.list`): как запись-мысль, плюс стилевые
 * оверрайды `color`/`style`/`width` — агент читает топологию, а не
 * перерисовывает граф.
 */
export function projectLinkRow<T>(row: T): T {
  return strip(row, LINK_DROP);
}

/** {@link projectThoughtRow} для массива записей. */
export function projectThoughtRows<T>(rows: readonly T[]): T[] {
  return rows.map((row) => projectThoughtRow(row));
}

/** {@link projectTypeRow} для массива записей. */
export function projectTypeRows<T>(rows: readonly T[]): T[] {
  return rows.map((row) => projectTypeRow(row));
}

/**
 * Снять пустые контейнеры с произвольного ответа, не трогая поля записей:
 * нужно там, где пустой справочник собирается на уровне конверта
 * (например, `link_types: {}` в `subgraph`/`neighbors` без типизированных
 * рёбер). Обход конверта неглубокий — сами записи уже прошли
 * {@link projectThoughtRow}/{@link projectTypeRow}.
 */
export function omitEmptyContainers<T>(payload: T): T {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = { ...(payload as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (EMPTY_CONTAINERS.has(key) && isEmptyContainer(key, out[key])) delete out[key];
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Перечень разделов `etn.networks.structure`
// ---------------------------------------------------------------------------

/**
 * Снять со строки-раздела `etn.networks.structure` структурные свойства-связи
 * («Родители»/«Потомки») из блока `properties`. Требование «networks.structure
 * отдаёт худой перечень разделов»: разделу достаточно счётчиков `counters`
 * (в них те же числа), дубль в `properties` недопустим. Скалярные и
 * типизированные свойства-связи сохраняются — их агент не может получить
 * иначе.
 */
export function stripStructuralLinkProperties<T extends { properties?: unknown }>(row: T): T {
  const props = row.properties;
  if (!Array.isArray(props)) return row;
  const filtered = props.filter(
    (p) =>
      !(
        p !== null &&
        typeof p === 'object' &&
        (p as { structural?: unknown }).structural === true
      ),
  );
  if (filtered.length === props.length) return row;
  return { ...row, properties: filtered as T['properties'] };
}

// ---------------------------------------------------------------------------
// Каталог `etn.types.list`
// ---------------------------------------------------------------------------

/**
 * Строка-константа каталога `etn.types.list` о структурных свойствах-связях
 * (0.8.3). Структурные «Родители»/«Потомки» объявлены на корневом типе L21 и
 * наследуются **всеми** типами мыслей: их повтор в `properties[]` каждого типа
 * — это ~30 КБ одинаковых записей на каталог (замер 23.09). Достаточно одного
 * пояснения на ответ, числа структурных связей агент видит в `meta.link_stats`
 * карточки и в `counters` разделов структуры.
 */
export const STRUCTURAL_PROPERTIES_NOTE =
  'Структурные свойства-связи «Родители»/«Потомки» объявлены на корневом типе ' +
  'и наследуются всеми типами мыслей — в properties[] каждого типа они не ' +
  'повторяются.';

/**
 * Сервисные поля привязки свойства в записи `properties[]` каталога
 * `etn.types.list` (0.8.3): адресация владельца, место объявления и флаги
 * переопределения. Агенту они не нужны — эффективный набор описывают
 * `inherited`/`config`/`required`/`default_value`, а место объявления видно по
 * самой записи каталога. Тот же список импортирует сторож проекции.
 */
export const PROPERTY_BINDING_SERVICE_FIELDS: readonly string[] = [
  'owner_type',
  'owner_id',
  'defined_on',
  'defined_on_name',
  'overridden_here',
  'description_overridden',
];

/**
 * Снять сервисные поля привязки с одной записи `properties[]`
 * ({@link PROPERTY_BINDING_SERVICE_FIELDS}); прочие поля (`key`, `value_type`,
 * `config`, `required`, `inherited`, `default_value`, `description`, …)
 * сохраняются. Неглубокая — `config` не трогается.
 */
export function stripPropertyBindingServiceFields<T>(prop: T): T {
  if (prop === null || typeof prop !== 'object' || Array.isArray(prop)) return prop;
  const out = { ...(prop as Record<string, unknown>) };
  for (const key of PROPERTY_BINDING_SERVICE_FIELDS) delete out[key];
  return out as T;
}
