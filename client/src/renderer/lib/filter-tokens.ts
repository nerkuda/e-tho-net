/**
 * Каталог токенов контекста редактора отбора (ошибка 50d9bf4e, пункты A3–A6;
 * требование 3697eb65 «Токены отбора разрешаются сервером относительно
 * мысли-контекста», требование 84b52caa «Токены отбора: календарные границы»,
 * ADR 7c1c5bf5 «Токены отбора — закрытое пространство имён»).
 *
 * Модуль — ЕДИНЫЙ чистый источник подсказок токенов для ячейки значения: раньше
 * список жил в диалоге отбора типа (`screens/thought-type/filter-dialog-pure.ts`)
 * и предлагался ТОЛЬКО значениям свойств без учёта природы. Теперь набор
 * выводится из ОПЕРАНДА строки (его природы) и реестра сети:
 *
 *   • A3 — токены доступны всем операндам, где семантика допускает: ссылочным
 *     на мысли/типы, текстовым, булевым, датовым — не только свойствам;
 *   • A4 — набор отсекается по природе значения (свойству-связи не предлагаются
 *     датовые токены и т.п.);
 *   • A5 — дубли убраны, у каждого токена есть человекочитаемое пояснение
 *     (`$thought.title` ищется по подписи, как датовые);
 *   • A6 — `$thought.[Свойство]` предлагаются для ВСЕХ свойств сети (реестра),
 *     а не только свойств подключённого типа.
 *
 * Природа токенов — закрытое пространство имён (ADR 7c1c5bf5): клиент лишь
 * ПРЕДЛАГАЕТ строки, разрешает их сервер. Поэтому состав подсказок — данные, а
 * не второй словарь разрешения.
 *
 * **Фокусные токены (`$thought*`) — по признаку МЕСТА** (требование 3697eb65):
 * их разрешает только серверный исполнитель отбора относительно мысли-контекста
 * (`runViewForThought`, отбор типа мысли), поэтому подсказки выдаются лишь при
 * `FilterTokenData.withFocusThought` (единственное место — диалог отбора типа
 * мысли, `screens/thought-type/filter-dialog.ts`). На сетевых точках профиля
 * `thoughts` (панель «Структур», строка поиска) и прочих экранах фокусных
 * токенов нет — иначе предложенный токен дал бы молча неисполнимый отбор
 * (класс ошибки 23c7d3e9 п. C3). Подписи фокусных токенов называют
 * мысль-контекст словами предметной области, без `id` (требование 9d5e3c4e).
 */

import {
  filterProfileHasTime,
  type EffectiveTypeProperty,
  type FilterProfileId,
  type NetworkProperty,
  type PropertyValueType,
  type StructurePropertyOp,
} from '@etn/shared';

import type { FilterTreeLeaf } from './filter-builder.js';
import { VALUE_TYPE_LABELS } from './property-list.js';

/** Токен, вставляемый в значение условия. */
export interface ViewToken {
  /** Текст, вставляемый в значение (например, `$today`, `$thought.[версия]`). */
  text: string;
  /** Человекочитаемая подпись строки списка (с пояснением — п. A5б). */
  label: string;
  /** Заголовок раздела списка. */
  section?: string;
  /**
   * `true` — токен разрешается в СПИСОК значений (множественное свойство,
   * `$thought.[<multi>]`). Годен только в условиях `in`/`not_in`.
   */
  listOnly?: boolean;
}

/**
 * Природа значения строки — по ней отбирается доступный набор токенов (A4).
 * `context` — природа неизвестна (значение свойства без реестра): предлагается
 * полный набор полей мысли (совместимость с прежним поведением контекста).
 */
export type FilterTokenNature =
  | 'context'
  | 'date'
  | 'thought-id'
  | 'thought-type'
  | 'link-type'
  | 'text'
  | 'bool'
  | 'user'
  | 'number'
  | 'none';

/** Данные для построения подсказок токенов: профиль места и реестр сети. */
export interface FilterTokenData {
  profile: FilterProfileId;
  /** Данные сети каркаса редактора — реестр свойств (все свойства — п. A6). */
  data: { registry: ReadonlyMap<string, NetworkProperty> };
  /**
   * Место применения исполняет отбор ОТНОСИТЕЛЬНО мысли-контекста — тогда ему
   * доступны токены полей мысли (`$thought*`). Признак МЕСТА сборки, а не
   * профиля (требование 3697eb65, дополнение «Где клиент вправе ПРЕДЛАГАТЬ
   * `$thought*`»): единственный исполнитель этих токенов — серверный
   * `runViewForThought` (отбор типа мысли); сетевые отборы токенов мысли не
   * разрешают, и подсказка порождала бы молча неисполнимый отбор (класс ошибки
   * 23c7d3e9 п. C3). По умолчанию `false` — фокусных токенов нет.
   */
  withFocusThought?: boolean;
}

/** Пояснения полей мысли — чтобы токены искались по подписи (п. A5б). */
const THOUGHT_FIELD_TOKENS: Readonly<Record<string, string>> = {
  $thought: 'мысль-контекст отбора',
  '$thought.title': 'название мысли-контекста',
  '$thought.synonyms': 'синонимы мысли одной строкой',
  '$thought.type': 'тип мысли-контекста',
  '$thought.active': 'актуальность мысли-контекста',
  '$thought.author': 'автор мысли-контекста',
  '$thought.editor': 'последний редактор мысли',
  '$thought.created': 'дата создания мысли',
  '$thought.updated': 'дата изменения мысли',
};

/** Токен поля мысли с подписью-пояснением. */
function thoughtToken(text: string, section: string): ViewToken {
  const hint = THOUGHT_FIELD_TOKENS[text];
  return { text, label: hint === undefined ? text : `${text} — ${hint}`, section };
}

/**
 * Природа значения свойства по `value_type` — словарём (не `switch`: диспетчер
 * по виду значения для ПОСТРОЕНИЯ поля ввода живёт только в
 * `editor/value-editor.ts`, стандарт S2, сторож `guard-value-editor`). Здесь
 * словарь лишь сопоставляет природу токенов, поле не строится.
 */
const NATURE_BY_VALUE_TYPE: Readonly<Record<PropertyValueType, FilterTokenNature>> = {
  text: 'text',
  url: 'text',
  date: 'date',
  number: 'number',
  bool: 'bool',
  link: 'thought-id',
  thought_ref: 'thought-id',
  cross_network_ref: 'none',
  publication: 'none',
};

/**
 * Природа значения свойства по `value_type`. Множественность не меняет природу
 * (она лишь делает токен списочным): `multiple` учитывается при пометке
 * `listOnly` построением токенов свойства.
 */
function natureFromValueType(valueType: PropertyValueType | null | undefined): FilterTokenNature {
  if (valueType === undefined || valueType === null) return 'context';
  return NATURE_BY_VALUE_TYPE[valueType] ?? 'none';
}

/** Природа значения ОПЕРАНДА (не свойства) по виду AST. */
const OPERAND_NATURE: Readonly<Record<string, FilterTokenNature>> = {
  created_at: 'date',
  updated_at: 'date',
  record_time: 'date',
  occurred_at: 'date',
  // Ссылочные на мысли: значение — id мысли, поэтому естественный токен `$thought`.
  id: 'thought-id',
  parents: 'thought-id',
  children: 'thought-id',
  targets: 'thought-id',
  owner: 'thought-id',
  entity_id: 'thought-id',
  type: 'thought-type',
  link_type: 'link-type',
  author: 'user',
  editor: 'user',
  record_author: 'user',
  record_editor: 'user',
  user: 'user',
  name: 'text',
  entity_title: 'text',
  record_title: 'text',
  record_body: 'text',
  kind: 'text',
  mime_type: 'text',
  size: 'number',
};

/** Совместимые `value_type` свойств для природы значения (A4). */
const NATURE_PROPERTY_TYPES: Readonly<Record<FilterTokenNature, readonly PropertyValueType[]>> = {
  context: [],
  date: ['date'],
  'thought-id': ['link', 'thought_ref'],
  'thought-type': [],
  'link-type': [],
  text: ['text', 'url'],
  bool: ['bool'],
  user: [],
  number: ['number'],
  none: [],
};

/**
 * Виды ОПЕРАНДОВ, значение которых — ПОЛЬЗОВАТЕЛЬ (id участника сети):
 * «Автор»/«Редактор» мыслей, «Автор/Редактор записи» дневника, «Автор события».
 * Выводятся из {@link OPERAND_NATURE} (природа `user`) — не второй словарь.
 * По ним ячейка значения выбирает виджет пользователя (`lib/filter-value.ts`),
 * а композер фразы показывает имя вместо id (`lib/filter-phrase.ts`).
 */
export const FILTER_USER_OPERAND_KINDS: ReadonlySet<string> = new Set(
  Object.keys(OPERAND_NATURE).filter((kind) => OPERAND_NATURE[kind] === 'user'),
);

/** Описание свойства для токена `$thought.[…]`. */
interface TokenProperty {
  name: string;
  value_type: PropertyValueType;
  multiple: boolean;
}

/** Свойство подходит природе значения строки? (A4) */
function propertyFitsNature(prop: TokenProperty, nature: FilterTokenNature): boolean {
  // Природа неизвестна (контекст) — предлагаются все свойства; иначе — по типу.
  if (nature === 'context') return true;
  return NATURE_PROPERTY_TYPES[nature].includes(prop.value_type);
}

/** Токены свойств `$thought.[…]`, подходящих природе значения. */
function propertyTokens(
  props: readonly TokenProperty[],
  nature: FilterTokenNature,
  op: string | null,
  includeAllMultiple: boolean,
): ViewToken[] {
  const allowed = NATURE_PROPERTY_TYPES[nature];
  if (nature !== 'context' && allowed.length === 0) return [];
  const out: ViewToken[] = [];
  for (const prop of props) {
    const fits = propertyFitsNature(prop, nature) || (includeAllMultiple && prop.multiple);
    if (!fits) continue;
    const text = `$thought.[${prop.name}]`;
    const listOnly = (prop.value_type === 'url' || prop.value_type === 'text') && prop.multiple;
    const suffix = isListOp(op) ? ' […]' : '';
    out.push({
      text,
      label: `${text}${suffix} — значение свойства «${prop.name}», ${VALUE_TYPE_LABELS[prop.value_type]}`,
      section: 'Свойства сети',
      ...(listOnly ? { listOnly: true } : {}),
    });
  }
  return out;
}

/** Токены по природе значения (без свойств); `withTime` — из профиля места. */
function natureTokens(
  nature: FilterTokenNature,
  withTime: boolean,
  includeDateAnchors: boolean,
): ViewToken[] {
  const out: ViewToken[] = [];
  switch (nature) {
    case 'date':
      // В ячейке даты опоры периода (`$today` и пр.) даёт отдельный источник
      // «Опоры», поэтому там они не дублируются (п. A5а). Легаси-контракт
      // диалога (`buildTokensForField`) опоры включает — прежние хосты и тесты.
      if (includeDateAnchors) {
        out.push({ text: '$today', label: '$today — сегодня', section: 'Глобальные' });
        if (withTime) out.push({ text: '$now', label: '$now — текущий момент' });
      }
      out.push(thoughtToken('$thought.created', 'Поля мысли'), thoughtToken('$thought.updated', 'Поля мысли'));
      break;
    case 'thought-id':
      out.push(thoughtToken('$thought', 'Поля мысли'));
      break;
    case 'thought-type':
      out.push(thoughtToken('$thought.type', 'Поля мысли'));
      break;
    case 'text':
      out.push(thoughtToken('$thought.title', 'Поля мысли'), thoughtToken('$thought.synonyms', 'Поля мысли'));
      out.push({ text: '$user', label: '$user — текущий пользователь', section: 'Глобальные' });
      break;
    case 'bool':
      out.push(thoughtToken('$thought.active', 'Поля мысли'));
      break;
    case 'user':
      out.push({ text: '$user', label: '$user — текущий пользователь', section: 'Глобальные' });
      break;
    case 'context':
      out.push({ text: '$today', label: '$today — сегодня', section: 'Глобальные' });
      if (withTime) out.push({ text: '$now', label: '$now — текущий момент' });
      out.push({ text: '$user', label: '$user — текущий пользователь' });
      out.push(
        thoughtToken('$thought', 'Поля мысли'),
        thoughtToken('$thought.title', 'Поля мысли'),
        thoughtToken('$thought.synonyms', 'Поля мысли'),
        thoughtToken('$thought.type', 'Поля мысли'),
        thoughtToken('$thought.active', 'Поля мысли'),
        thoughtToken('$thought.author', 'Поля мысли'),
        thoughtToken('$thought.editor', 'Поля мысли'),
        thoughtToken('$thought.created', 'Поля мысли'),
        thoughtToken('$thought.updated', 'Поля мысли'),
      );
      break;
    default:
      break;
  }
  return out;
}

/** Убрать дубли токенов по тексту, сохранив порядок (п. A5а). */
function dedupeTokens(tokens: readonly ViewToken[]): ViewToken[] {
  const seen = new Set<string>();
  const out: ViewToken[] = [];
  for (const token of tokens) {
    if (seen.has(token.text)) continue;
    seen.add(token.text);
    out.push(token);
  }
  return out;
}

/** Оператор со списком значений («в списке»/«не в списке»). */
function isListOp(op: string | null): boolean {
  return op === 'in' || op === 'not_in';
}

/**
 * Полный список токенов для природы значения: поля мысли/глобальные плюс
 * свойства (типа — из цепочки, A6 — из реестра сети через `extraProps`).
 * Дедуплицирован по тексту.
 *
 * `withFocusThought` — гейт фокусных токенов мысли (требование 3697eb65): без
 * него подсказки `$thought*` (и поля, и `$thought.[Свойство]`) не отдаются —
 * их разрешает только исполнитель отбора относительно мысли-контекста.
 */
function buildTokens(
  nature: FilterTokenNature,
  props: readonly TokenProperty[],
  op: string | null,
  withTime: boolean,
  includeDateAnchors: boolean,
  includeAllMultiple: boolean,
  withFocusThought: boolean,
): ViewToken[] {
  const tokens = dedupeTokens([
    ...natureTokens(nature, withTime, includeDateAnchors),
    ...propertyTokens(props, nature, op, includeAllMultiple),
  ]);
  if (withFocusThought) return tokens;
  return tokens.filter((token) => !token.text.startsWith('$thought'));
}

/**
 * Токены значения поля свойства (прежний публичный контракт диалога отбора типа,
 * сохранён ради существующих тестов и хостов): `propertyValueType` задаёт природу,
 * `chainProps` — свойства типа (движок A6 — реестр — передаётся через `extraProps`).
 */
export function buildTokensForField(
  chainProps: readonly { type: unknown; props: readonly EffectiveTypeProperty[] }[],
  propertyValueType: PropertyValueType | null,
  op: StructurePropertyOp | null,
  extraProps: readonly TokenProperty[] = [],
): ViewToken[] {
  const props: TokenProperty[] = [];
  for (const level of chainProps) {
    for (const def of level.props) {
      props.push({ name: def.key, value_type: def.value_type, multiple: def.config?.multiple === true });
    }
  }
  props.push(...extraProps);
  // Легаси-контракт диалога отбора типа мысли — фокусное место: токены мысли
  // доступны (требование 3697eb65).
  return buildTokens(natureFromValueType(propertyValueType), props, op, true, true, true, true);
}

/**
 * Живой поиск: подстрока без регистра по подписи ИЛИ значению токена (часть
 * `$today` или часть «сегодня» — обе находят токен). Пустой запрос — весь список.
 */
export function filterTokenOptions<T extends { label: string; text: string }>(
  options: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return options;
  return options.filter(
    (o) => o.label.toLowerCase().includes(needle) || o.text.toLowerCase().includes(needle),
  );
}

/** Природа значения листа строки (для отбора токенов — A3/A4). */
export function filterTokenNature(
  leaf: FilterTreeLeaf,
  data: Pick<FilterTokenData, 'data'>,
): FilterTokenNature {
  const entity = leaf.entity;
  if (entity.kind === 'property') {
    const ref = entity.property_id ?? entity.property ?? '';
    const direct = data.data.registry.get(ref);
    if (direct !== undefined) return natureFromValueType(direct.value_type);
    for (const entry of data.data.registry.values()) {
      if (entry.name === ref) return natureFromValueType(entry.value_type);
    }
    return 'context';
  }
  return OPERAND_NATURE[entity.kind] ?? 'none';
}

/** Свойства реестра сети как токены `$thought.[…]` (A6 — все свойства). */
function registryTokenProps(registry: ReadonlyMap<string, NetworkProperty>): TokenProperty[] {
  const out: TokenProperty[] = [];
  for (const entry of registry.values()) {
    out.push({
      name: entry.name,
      value_type: entry.value_type,
      multiple: entry.config?.multiple === true,
    });
  }
  return out;
}

/**
 * Токены для листа строки: природа — из операнда/свойства (A3/A4), свойства —
 * из РЕЕСТРА сети (A6), дубли убраны (A5). Фокусные токены мысли (`$thought*`)
 * выдаются ТОЛЬКО при `ctx.withFocusThought` — признаке места, исполняющего
 * отбор относительно мысли-контекста (требование 3697eb65). Чистая функция —
 * юнит-тест без GUI.
 */
export function filterLeafTokens(leaf: FilterTreeLeaf, ctx: FilterTokenData): ViewToken[] {
  const nature = filterTokenNature(leaf, ctx);
  const props = registryTokenProps(ctx.data.registry);
  return buildTokens(
    nature,
    props,
    leaf.operator,
    filterProfileHasTime(ctx.profile),
    false,
    false,
    ctx.withFocusThought === true,
  );
}

/** Источник подсказок токенов строки для общего диалога подсказок (`SuggestSource`). */
export function filterLeafTokenSource(
  leaf: FilterTreeLeaf,
  ctx: FilterTokenData,
): {
  when: 'always';
  header: string;
  load: (query: string) => { value: string; label: string; section?: string }[];
} {
  return {
    when: 'always',
    header: 'Токены контекста',
    load: (query) =>
      filterLeafTokens(leaf, ctx)
        .filter((token) => {
          const needle = query.trim().toLowerCase();
          return needle === '' || token.label.toLowerCase().includes(needle) || token.text.includes(needle);
        })
        .map((token) => ({
          value: token.text,
          label: token.label,
          ...(token.section !== undefined ? { section: token.section } : {}),
        })),
  };
}
