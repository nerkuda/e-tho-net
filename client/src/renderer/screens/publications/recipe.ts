/**
 * Вкладка «Рецепты» карточки публикации — на едином редакторе отбора (0.13.1,
 * задача a0c071f8; ТП 3e97b648 «Редактор: внедрение во все места», требование
 * 0095daad «Профили контекста всех точек применения отбора описаны», ADR
 * fc23f9c1 «Судьба спец-секций», ADR 2ef3ed7e «рецепт исполняет общий AST»,
 * сценарий b0a50833).
 *
 * Отбор рецепта строится ОБЩИМ редактором (`lib/filter-editor.ts`, профиль
 * `publications` — операнды мыслей, `shared/src/filter-profiles.ts`): бывшие
 * спец-секции растворены в строки дерева (ADR fc23f9c1) — «родительские мысли»
 * и «обход по связям» стали строкой «Родители» с оператором «в иерархии»,
 * «ключевые слова» — строкой «Есть слова» с областями, типы мыслей, условия по
 * свойствам и «дополнительно» — обычными строками. Своих секций и второго
 * конструктора модуль не держит; легаси-конструктор условий (`lib/filter-form.ts`)
 * рецептом больше НЕ используется.
 *
 * Форма хранения — AST-тело профиля «публикации» (`buildFilterAst`): его
 * исполняет общий AST-движок рецепта (`server/src/domain/publication-recipe.ts`).
 * Прежний плоский формат читает тот же конвертер (`readFilterDefinitionDetailed`),
 * а отброшенные при чтении условия видны жёлтой диагностикой футера — битый
 * рецепт не перезаписывается молча.
 *
 * Контракт билдера (`RecipeBuilder`: `root` + `getDefinition`) сохранён — им
 * пользуется карточка публикации (плумбинг автосохранения — `editor/publication-card.ts`).
 */

import type { NetworkProperty, PublicationTitleRecipe } from '@etn/shared';

import {
  buildFilterAst,
  defaultFilterCriteriaState,
  defaultFilterTreeGroup,
  readFilterDefinitionDetailed,
  withReverseLinkPropertySides,
  type FilterCriteriaState,
} from '../../lib/filter-builder.js';
import { lostConditionIssues, type FilterIssue } from '../../lib/filter-diagnostics.js';
import { buildFilterEditor, type FilterEditorHandle } from '../../lib/filter-editor.js';
import type { FilterTreeData } from '../../lib/filter-tree.js';
import {
  linkPropertyEntityOptions,
  type EntityOption,
} from '../../lib/entity-picker.js';
import {
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  linkEndIconSpec,
  type PropertyRegistryRow,
} from '../../lib/property-list.js';
import { etn } from '../../lib/etn.js';
import { store } from '../../state.js';

/** Построитель рецепта заголовков. */
export interface RecipeBuilder {
  /** Корень формы рецепта (единый редактор отбора: дерево + футер). */
  root: HTMLElement;
  /** Текущее определение отбора рецепта — AST-тело профиля «публикации». */
  getDefinition: () => PublicationTitleRecipe;
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

/**
 * Строит форму рецепта заголовков на ЕДИНОМ редакторе отбора (профиль
 * `publications`) по сохранённому определению (или пустую).
 *
 * Футер — по образцу ленты «События» (`screens/activity/activity.ts`): стандартный
 * набор кнопок погашен (`buttons.standard=false`), строки имени и личных
 * сохранённых отборов нет; рецепт автосохраняется в публикацию правкой
 * (`onChange` → отложенное сохранение карточки). Секция сортировки сохранена
 * (паритет с легаси): при непустых ключах её несёт `ast.sort`.
 */
export function buildRecipeBuilder(opts: {
  registry: Map<string, NetworkProperty>;
  /**
   * Сохранённый рецепт: плоский формат «Структур мыслей» либо AST-тело (задача
   * ef37b01e). Читает единый конвертер (`readFilterDefinitionDetailed`); условия,
   * отброшенные при чтении, видны жёлтой диагностикой футера и не перезаписываются
   * молча — перезапись только после осознанной правки пользователем.
   */
  initial: PublicationTitleRecipe | null;
  /**
   * Любая правка формы рецепта (единая точка уведомления — `touch`). Карточка
   * публикации по этому сигналу ставит `title_recipe` в отложенное сохранение.
   */
  onChange?: () => void;
}): RecipeBuilder {
  // Сохранённого рецепта нет — редактор открывается на ЧИСТОМ дереве: у
  // отсутствующего определения нечего читать, а плоский компилятор добавил бы
  // свои дефолты видимости (`trashed eq false`). Сохранённое определение (в т.ч.
  // пустое `{sort,order}` прежнего конструктора) читается единым конвертером.
  const read =
    opts.initial === null || opts.initial === undefined
      ? {
          state: {
            ...defaultFilterCriteriaState(),
            tree: defaultFilterTreeGroup('and'),
          } as FilterCriteriaState,
          lost: [] as readonly string[],
        }
      : readFilterDefinitionDetailed(opts.initial, {
          registry: opts.registry,
          activeMode: 'view',
        });
  const state: FilterCriteriaState = read.state;
  /** Потери при чтении — жёлтая диагностика, снимается первым касанием отбора. */
  let lost = read.lost;

  let editor: FilterEditorHandle | null = null;
  const data: FilterTreeData = {
    registry: opts.registry,
    linkTypes: store.state.linkTypes,
    thoughtTypes: store.state.thoughtTypes,
    // Видимые характеристики места первыми строками списка «Что»: разделы
    // публикации задают «Родители», далее слова и типы (состав операндов — из
    // реестра профиля).
    contextual: ['parents', 'children', 'keywords', 'type'],
  };

  /** Единая точка правки формы: снять диагностику потери, сообщить карточке. */
  const touch = (): void => {
    // Первое касание отбора пользователем: диагностика потери при чтении своё
    // отработала, правка заменяет сохранённое определение — сообщение снимается.
    if (lost.length > 0) lost = [];
    opts.onChange?.();
    editor?.refresh();
  };

  editor = buildFilterEditor({
    profile: 'publications',
    networkId: store.state.networkId ?? '',
    firstDayOfWeek: store.state.network?.first_day_of_week ?? 1,
    data,
    getState: () => state,
    touch,
    // Набор текста в поле значения (ошибка 7d36f439): снять диагностику потери
    // и сообщить карточке — БЕЗ пересборки редактора (поле не теряет фокус).
    touchValue: () => {
      if (lost.length > 0) lost = [];
      opts.onChange?.();
    },
    // Место без сохранённых отборов: свой набор кнопок не нужен, строка имени
    // не рисуется (образец — лента «События»); правки уходят автосохранением.
    buttons: { standard: false },
    host: {
      // Стандартной «Применить» нет (рецепт не запускает запрос — правки
      // автосохраняются); хук оставлен единой точкой сохранения.
      apply: () => touch(),
      // Диагностика строк: потерянные при чтении условия — жёлтым, без адреса
      // строки (видны в тултипе фразы-превью футера; каркас редактора сведёт их
      // с проверками конструктора сам). Записи собирает общий каркас
      // (`lostConditionIssues`) — строки интерфейса места берутся из словаря.
      issues: (): readonly FilterIssue[] => lostConditionIssues(lost),
    },
  });

  return {
    root: editor.root,
    getDefinition: () =>
      buildFilterAst(state, {
        profile: 'publications',
        // Сортировку несёт секция чипов: пустые чипы не воскрешают плоскую пару
        // `sort`/`order` (класс дефектов ca864656, 32fd6125).
        sort: (state.sortKeys ?? []).length > 0,
      }),
  };
}
