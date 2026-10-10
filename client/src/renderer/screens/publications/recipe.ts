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
  linkEndIconSpec,
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

/**
 * Состояние свёрнутости групп «Свойства»/«Дополнительно» рецепта. Карточка
 * публикации держит его МЕЖДУ пересборками билдера (ошибка 4773b34f): правка
 * отбора шлёт сохранение, серверное эхо пересобирает панель — без переноса
 * состояния группы молча вернулись бы к умолчаниям (сворачивание/разворот
 * «сами»). См. {@link buildRecipeBuilder} `collapse`.
 */
export interface RecipeCollapseState {
  /** Группа «Свойства» свёрнута. */
  props: boolean;
  /** Группа «Дополнительно» свёрнута. */
  extras: boolean;
}

/** Умолчания свёрнутости групп рецепта: «Свойства» развёрнуты, прочее свёрнуто. */
export function createRecipeCollapseState(): RecipeCollapseState {
  return { props: false, extras: true };
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
 * Варианты свойств-связей для чип-поля — по ОДНОЙ строке на КАЖДУЮ СТОРОНУ
 * (`linkPropertyEntityOptions`): пользователь видит имя стороны и значок её
 * направления, как в поле «Свойство связи» диалога добавления мысли (задача
 * 7cfaba7c, п.3). Плюс системные «Родители»/«Потомки» (общий конструктор
 * пропускает их как структурные).
 *
 * Значение варианта — id РЕЕСТРОВОГО свойства (`linkProperty.propertyId`), а не
 * строка стороны: источники текстов и доп. материалы адресуются id свойства,
 * поэтому обе стороны одной связи дают один и тот же id значения. Отображаемое
 * имя чипа держит {@link propertyChipTitles} (каноническая — прямая — сторона).
 */
export function propertyEntityOptions(rows: readonly PropertyRegistryRow[]): EntityOption[] {
  const listRows = buildPropertyListRows(rows, store.state.linkTypes);
  const options: EntityOption[] = linkPropertyEntityOptions(listRows).map((option) => ({
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
      linkEnd: linkEndIconSpec(row.side ?? 'source', row.visual),
      linkProperty: { propertyId: row.propertyId, side: row.side ?? 'source', key: row.name },
    });
  }
  return options;
}

/**
 * Каноническое (прямое) имя свойства для облачка чипа: `propertyId → имя`.
 * У связи две стороны-варианта с общим id значения, и без этой карты чип
 * показывал бы имя стороны, оказавшейся в каталоге последней (задача 7cfaba7c,
 * п.3). Чистая — юнит-тест.
 */
export function propertyChipTitles(options: readonly EntityOption[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const option of options) {
    const id = option.linkProperty?.propertyId ?? option.id;
    if (option.linkProperty?.side === 'source' || !map.has(id)) map.set(id, option.title);
  }
  return map;
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
  /**
   * Внешний держатель свёрнутости групп (ошибка 4773b34f): карточка публикации
   * передаёт его, чтобы состояние переживало пересборку билдера на серверном
   * эхе. Не задан — создаётся своё ({@link createRecipeCollapseState}).
   */
  collapse?: RecipeCollapseState;
}): RecipeBuilder {
  const state: FilterCriteriaState =
    opts.initial !== null ? parseFilterDefinition(opts.initial) : defaultFilterCriteriaState();
  const collapse = opts.collapse ?? createRecipeCollapseState();

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
      { get: () => collapse.props, set: (v) => (collapse.props = v) },
      { caretKind: 'chevron' },
    ),
  );
  sections.push(
    buildExtrasSection(ctx, { get: () => collapse.extras, set: (v) => (collapse.extras = v) }, {
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
