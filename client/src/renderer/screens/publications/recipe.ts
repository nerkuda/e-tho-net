/**
 * Конструктор рецепта заголовков публикации (0.11.1, задача a3cfc018; элемент
 * интерфейса c3e44cab, требование 1b39206e).
 *
 * Переиспользует ЕДИНЫЙ конструктор условий клиента: модель состояния —
 * `FilterCriteriaState` (`lib/filter-builder.ts`), вид элементов — общий каркас
 * формы (`lib/filter-form.ts`), конвертация в wire — `buildWireFilter`. Своих
 * моделей и элементов отбора модуль не заводит (стандарт S4). Применяется в
 * двух местах: шаг 2 мастера создания и вкладка «Рецепты» карточки публикации.
 */

import type { NetworkProperty, SavedFilterDefinition } from '@etn/shared';

import {
  buildWireFilter,
  defaultFilterCriteriaState,
  parseFilterDefinition,
  withReverseLinkPropertySides,
  type FilterCriteriaState,
} from '../../lib/filter-builder.js';
import {
  buildConditionsSection,
  buildEntityChipSection,
  buildExtrasSection,
  buildFilterForm,
  buildKeywordsSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import { filterEntityOptions, thoughtTypeEntityOptions } from '../../lib/entity-picker.js';
import { etn } from '../../lib/etn.js';
import { store } from '../../state.js';

/** Построитель рецепта заголовков. */
export interface RecipeBuilder {
  /** Корень формы (секции + прокрутка). */
  root: HTMLElement;
  /** Текущее wire-определение отбора (для сохранения в публикацию). */
  getDefinition: () => SavedFilterDefinition;
}

/**
 * Загружает реестр свойств сети как карту `id → строка реестра` с обратными
 * сторонами связей — так же, как панель «Структур» (общий конвертер ожидает
 * именно эту форму).
 */
export async function loadPropertyRegistry(
  networkId: string,
): Promise<Map<string, NetworkProperty>> {
  const list = await etn.propertyRegistry.list(networkId).catch(() => []);
  const base = new Map<string, NetworkProperty>(
    list.map((row): [string, NetworkProperty] => [row.id, row]),
  );
  return withReverseLinkPropertySides(base, store.state.linkTypes);
}

/** Строит форму рецепта заголовков по сохранённому определению (или пустую). */
export function buildRecipeBuilder(opts: {
  registry: Map<string, NetworkProperty>;
  initial: SavedFilterDefinition | null;
}): RecipeBuilder {
  const state: FilterCriteriaState =
    opts.initial !== null ? parseFilterDefinition(opts.initial) : defaultFilterCriteriaState();
  let propsCollapsed = false;
  let extrasCollapsed = true;

  const sections: FilterSection[] = [];
  const touch = (): void => {
    for (const section of sections) section.refresh();
  };
  const ctx: FilterFormContext = {
    // networkId в секциях не используется для сети (только для подсказок), но
    // тип требует строку — берём открытую сеть.
    networkId: store.state.networkId ?? '',
    getState: () => state,
    registry: opts.registry,
    touch,
  };

  sections.push(
    buildKeywordsSection(ctx, {
      placeholder: 'счет* -вод*',
      tooltip: 'Слова через пробел, все обязательны; * — любые символы; -слово — исключение.',
      showScope: true,
    }),
  );
  sections.push(
    buildEntityChipSection(ctx, {
      title: 'Типы мыслей',
      getValues: () => state.typeIds,
      setValues: (values) => {
        state.typeIds = values;
      },
      loadOptions: (query) =>
        filterEntityOptions(thoughtTypeEntityOptions(store.state.thoughtTypes), query),
      optionsHeader: 'Типы мыслей',
      placeholder: 'Название типа…',
    }),
  );
  sections.push(
    buildConditionsSection(
      ctx,
      { get: () => propsCollapsed, set: (v) => (propsCollapsed = v) },
      {},
    ),
  );
  sections.push(
    buildExtrasSection(ctx, { get: () => extrasCollapsed, set: (v) => (extrasCollapsed = v) }),
  );

  const form = buildFilterForm({ sections, className: 'pub-recipe-form' });
  return {
    root: form.root,
    getDefinition: () =>
      buildWireFilter(state, opts.registry, { activeMode: 'view' }) as SavedFilterDefinition,
  };
}

/** Пара «id → подпись» свойства-связи для чип-листов источников текстов. */
export interface PropertyChoice {
  id: string;
  name: string;
}

/**
 * Свойства-связи реестра (в том числе структурные «Родители»/«Потомки») —
 * кандидаты для рецепта текстов и блока «дополнительные материалы».
 */
export function linkPropertyChoices(
  registry: ReadonlyMap<string, NetworkProperty>,
): PropertyChoice[] {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seen = new Set<string>();
  const out: PropertyChoice[] = [];
  for (const row of registry.values()) {
    if (row.value_type !== 'link') continue;
    // Обратные стороны связей в карте — псевдо-id (имя свойства), не id
    // реестра; сервер адресует источники текстов реальными id.
    if (!UUID_RE.test(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, name: row.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
