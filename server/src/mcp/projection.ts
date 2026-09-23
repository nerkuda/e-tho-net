/**
 * Единый сериализатор compact-проекции списочных ответов MCP
 * (задача 6ee904ad, тех.проект «Оптимизация MCP-интерфейса ETN»; требование
 * «Компактная проекция ответов view compact и full»).
 *
 * Зачем отдельный модуль. Оба уже исправленных дефекта утечек (2aacd23a —
 * визуальные поля в списках, 29def270 — дубль тела комментария в resolve)
 * имели одну причину: каждый инструмент собирал ответ по-своему, поэтому
 * новое поле приходилось вычищать в каждом месте отдельно. Здесь собрана
 * единственная точка, через которую проходят записи всех списочных ответов
 * (`etn.thoughts.search`, `views.run`, `resolve`, `neighbors`, `subgraph`,
 * `instructions`, `networks.structure`, `types.list`, а также `find_duplicates`
 * и `trash.list`). Новый инструмент списка обязан звать эти функции, а не
 * собирать проекцию руками.
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
