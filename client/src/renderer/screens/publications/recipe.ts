/**
 * Конструктор рецепта заголовков публикации (0.11.1, задача a3cfc018; элемент
 * интерфейса c3e44cab, требование 1b39206e).
 *
 * Переиспользует ЕДИНЫЙ конструктор условий клиента: модель состояния —
 * `FilterCriteriaState` (`lib/filter-builder.ts`), вид элементов — общий каркас
 * формы (`lib/form.ts`), конвертация в wire — `buildWireFilter`. Своих моделей
 * и элементов отбора модуль не заводит (стандарт S4). Применяется в двух
 * местах: шаг 2 мастера создания и вкладка «Рецепты» карточки публикации.
 *
 * Свойства-источники текстов и «дополнительных материалов» собираются общим
 * пикером сущностей (`buildEntityChipField` + `linkPropertyEntityOptions`) —
 * по образцу остальных полей выбора свойств; порядок значений меняется
 * перетаскиванием чипов (`reorderable`).
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
import {
  filterEntityOptions,
  linkPropertyEntityOptions,
  thoughtTypeEntityOptions,
  type EntityOption,
} from '../../lib/entity-picker.js';
import {
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  type PropertyRegistryRow,
} from '../../lib/property-list.js';
import { etn } from '../../lib/etn.js';
import { t } from '../../lib/i18n.js';
import { store } from '../../state.js';

/** Построитель рецепта заголовков. */
export interface RecipeBuilder {
  /** Корень формы (секции + прокрутка). */
  root: HTMLElement;
  /** Текущее wire-определение отбора (для сохранения в публикацию). */
  getDefinition: () => SavedFilterDefinition;
}

/** Реестр свойств сети в виде строк общего списка (для пикера свойств). */
export async function loadPropertyRows(networkId: string): Promise<PropertyRegistryRow[]> {
  const registry = await etn.propertyRegistry.list(networkId).catch(() => []);
  await ensurePropertyLinkTypes(networkId, registry).catch(() => undefined);
  return registry;
}

/**
 * Загружает реестр свойств сети как карту `id → строка реестра` с обратными
 * сторонами связей — так же, как панель «Структур» (общий конвертер ожидает
 * именно эту форму).
 */
export async function loadPropertyRegistry(
  networkId: string,
): Promise<Map<string, NetworkProperty>> {
  const list = await loadPropertyRows(networkId);
  const base = new Map<string, NetworkProperty>(
    list.map((row): [string, NetworkProperty] => [row.id, row]),
  );
  return withReverseLinkPropertySides(base, store.state.linkTypes);
}

/**
 * Варианты свойств-связей для чип-поля: общий конструктор вариантов
 * (`linkPropertyEntityOptions`), приведённый к id реестрового свойства (сервер
 * адресует источники текстов именно id, а не строкой стороны), плюс системные
 * «Родители»/«Потомки» (они пропускаются общим конструктором как структурные).
 */
export function propertyEntityOptions(rows: readonly PropertyRegistryRow[]): EntityOption[] {
  const listRows = buildPropertyListRows(rows, store.state.linkTypes);
  const options = linkPropertyEntityOptions(listRows).map((option) => ({
    ...option,
    id: option.linkProperty?.propertyId ?? option.id,
  }));
  const seen = new Set(options.map((option) => option.id));
  for (const row of listRows) {
    if (!row.structural || row.valueType !== 'link' || seen.has(row.propertyId)) continue;
    seen.add(row.propertyId);
    options.push({
      id: row.propertyId,
      title: row.name,
      selectable: true,
      linkProperty: { propertyId: row.propertyId, side: row.side ?? 'source', key: row.name },
    });
  }
  return options;
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
    networkId: store.state.networkId ?? '',
    getState: () => state,
    registry: opts.registry,
    touch,
  };

  sections.push(
    buildKeywordsSection(ctx, {
      placeholder: t('publication.recipe.keywordsPlaceholder'),
      tooltip: t('publication.recipe.keywordsTooltip'),
      showScope: true,
    }),
  );
  sections.push(
    buildEntityChipSection(ctx, {
      title: t('publication.recipe.types'),
      getValues: () => state.typeIds,
      setValues: (values) => {
        state.typeIds = values;
      },
      loadOptions: (query) =>
        filterEntityOptions(thoughtTypeEntityOptions(store.state.thoughtTypes), query),
      optionsHeader: t('publication.recipe.types'),
      placeholder: t('publication.recipe.typesPlaceholder'),
    }),
  );
  sections.push(
    buildConditionsSection(ctx, { get: () => propsCollapsed, set: (v) => (propsCollapsed = v) }, {}),
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
