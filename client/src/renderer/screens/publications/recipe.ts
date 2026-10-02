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
  buildParentThoughtsSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import {
  filterEntityOptions,
  linkPropertyEntityOptions,
  pickEntitiesModal,
  thoughtTypeEntityOptions,
  type EntityOption,
} from '../../lib/entity-picker.js';
import { pickedThoughtIds, pickThoughtsDialog } from '../../canvas/add-dialog.js';
import {
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  type PropertyRegistryRow,
} from '../../lib/property-list.js';
import { etn } from '../../lib/etn.js';
import { t } from '../../lib/i18n.js';
import { store } from '../../state.js';
import { dedupePropertyOptions } from './model.js';

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
 * (`linkPropertyEntityOptions`), приведённый к id реестрового свойства и
 * ДЕДУПЛИЦИРОВАННЫЙ по нему (`dedupePropertyOptions` — у связи две стороны,
 * а сервер адресует источники текстов id свойства), плюс системные
 * «Родители»/«Потомки» (они пропускаются общим конструктором как структурные).
 */
export function propertyEntityOptions(rows: readonly PropertyRegistryRow[]): EntityOption[] {
  const listRows = buildPropertyListRows(rows, store.state.linkTypes);
  const options = dedupePropertyOptions(linkPropertyEntityOptions(listRows));
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
  /**
   * Любая правка формы рецепта (единая точка уведомления — `touch`, через неё
   * проходят изменения всех секций). Карточка публикации по этому сигналу
   * ставит `title_recipe` в отложенное сохранение; у мастера создания колбэк
   * не задан — определение забирается вручную на шаге «Создать».
   */
  onChange?: () => void;
}): RecipeBuilder {
  const state: FilterCriteriaState =
    opts.initial !== null ? parseFilterDefinition(opts.initial) : defaultFilterCriteriaState();
  let propsCollapsed = false;
  let extrasCollapsed = true;

  const sections: FilterSection[] = [];
  const touch = (): void => {
    for (const section of sections) section.refresh();
    opts.onChange?.();
  };
  const ctx: FilterFormContext = {
    networkId: store.state.networkId ?? '',
    getState: () => state,
    registry: opts.registry,
    touch,
  };

  sections.push(
    // «Родительские мысли» — ПЕРВЫМ: основное средство структурирования
    // публикации (дополнение C к задаче b02ef1cf). Их поддеревья дают разделы;
    // остальные условия только уточняют состав. Рецепты без `parent_ids`
    // работают как раньше — ограничения нет.
    buildParentThoughtsSection(ctx, {
      tooltip: t('publication.recipe.parentsTooltip'),
      // Явный триггер выбора корней поддерева — тот же фасад, что в «Структурах
      // мыслей» (диалог выбора мыслей с предвыбранными корнями).
      picker: {
        label: t('publication.recipe.pickThoughts'),
        open: async () => {
          const result = await pickThoughtsDialog({
            networkId: store.state.networkId ?? '',
            allowCreate: false,
            allowLinkType: false,
            selectedIds: state.parentIds,
            title: t('publication.recipe.parentsTitle'),
            applyLabel: t('actions.apply'),
          });
          return result === null ? null : pickedThoughtIds(result);
        },
      },
    }),
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
      // Триггер выбора типов — модальный список типов, как в фильтрах «Структур».
      picker: {
        label: t('publication.recipe.pickTypes'),
        open: () =>
          pickEntitiesModal({
            networkId: store.state.networkId ?? '',
            kind: 'thought-types',
            title: t('publication.recipe.types'),
            currentIds: state.typeIds,
          }),
      },
    }),
  );
  sections.push(
    buildConditionsSection(
      ctx,
      { get: () => propsCollapsed, set: (v) => (propsCollapsed = v) },
      { caretKind: 'chevron' },
    ),
  );
  sections.push(
    buildExtrasSection(ctx, { get: () => extrasCollapsed, set: (v) => (extrasCollapsed = v) }, {
      caretKind: 'chevron',
    }),
  );

  const form = buildFilterForm({ sections, className: 'pub-recipe-form' });
  return {
    root: form.root,
    getDefinition: () =>
      buildWireFilter(state, opts.registry, { activeMode: 'view' }) as SavedFilterDefinition,
  };
}
