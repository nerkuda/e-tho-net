/**
 * Единая фабрика встраивания редактора отбора (задача e5dd10ab ТП 3e97b648
 * «Редактор: внедрение во все места»; требование 84b33a43 «Профиль контекста
 * каждого места подключён к единому редактору»; требования 0095daad
 * «Профили контекста всех точек применения отбора описаны» и ca905fbc «Футер»;
 * ADR 4154811f, ADR 30ff83bb).
 *
 * Роль модуля — СБОРОЧНАЯ ТОЧКА. Место применения (панель, диалог, модальный
 * слой) передаёт профиль контекста и колбэки хоста; фабрика собирает готовый
 * контейнер редактора из уже написанных модулей и ничего своего не рисует:
 *
 *   `lib/filter-tree.ts`        — дерево условий (группы, строки, списки);
 *   `lib/filter-value.ts`       — виджеты ячейки значения;
 *   `lib/filter-subquery.ts`    — переключатель «список ↔ выборка» и модал под-выборки;
 *   `lib/filter-sort.ts`        — секция сортировки (ОТДЕЛЬНОЕ поле, не узел AST);
 *   `lib/filter-phrase.ts`      — фраза-превью;
 *   `lib/filter-footer.ts`      — футер (имя, маркер ●, фраза, кнопки места);
 *   `lib/filter-diagnostics.ts` — проверки конструктора + записи ядра (диагностика строк).
 *
 * **Профиль — данные, а не ветка кода** (требование 84b33a43): ни одна строка
 * модуля не различает места применения; профиль уходит параметром в дерево,
 * виджеты значений, модал под-выборки и композер фразы. Состав операндов,
 * операторов и токенов берётся из общего реестра (`shared/src/filter-profiles.ts`):
 * гранулярность времени (токены `$now`/`$hour*`, единицы `h`/`mi`) включается
 * профилем (`withTime`) — в календарных местах их нет.
 *
 * Единственная модель состояния — `FilterCriteriaState` (ADR 30ff83bb): фабрика
 * читает её через `getState` и никогда не держит второй. Хост получает правки
 * через `touch`, а кнопки места — через колбэки `apply`/`save`/`reset`.
 */

import type { FilterAstSortKey, FilterProfileId } from '@etn/shared';

import { div } from './dom.js';
import type { EntityChipFieldOptions } from './entity-picker.js';
import { buildFilterAst, type FilterCriteriaState, type FilterTreeLeaf } from './filter-builder.js';
import {
  constructorFilterIssues,
  mergeFilterIssues,
  type FilterIssue,
} from './filter-diagnostics.js';
import {
  buildFilterFooter,
  type FilterFooterButtonSpec,
  type FilterFooterHandle,
} from './filter-footer.js';
import { composeFilterPhrase, type FilterPhraseContext } from './filter-phrase.js';
import {
  buildFilterSortSection,
  filterSortKeyOptions,
  type FilterSortSectionHandle,
} from './filter-sort.js';
import {
  createFilterSubqueryValueRenderer,
  type FilterSubqueryConfirm,
} from './filter-subquery.js';
import { buildFilterTree, type FilterTreeData } from './filter-tree.js';
import type { FilterValueContext, FilterValueEnumOption } from './filter-value.js';
import type { SuggestSource } from './suggest-dropdown.js';
import type { ThoughtCloudInput } from './thought-cloud.js';

/** Корень контейнера редактора. */
export const FILTER_EDITOR_CLASS = 'fe';
/** Полоса секции сортировки и футера (низ редактора). */
export const FILTER_EDITOR_FOOT_CLASS = 'fe-foot';

/**
 * Кнопки места применения: стандартный набор футера и/или свои. Модальные места
 * (диалог отбора типа, модал под-выборки) гасят стандартный набор и передают
 * свои кнопки — «Готово»/«Отмена».
 */
export interface FilterEditorButtons {
  /** Показать стандартный набор «Сохранить/Применить/Очистить» (по умолчанию да). */
  standard?: boolean;
  /** Свои кнопки места (идут после стандартных, если те показаны). */
  extra?: readonly FilterFooterButtonSpec[];
}

/** Кнопки места со СТАНДАРТНЫМ набором (по умолчанию): хост обязан дать save/reset. */
export interface FilterEditorButtonsStandard extends FilterEditorButtons {
  standard?: true;
}

/** Кнопки места со СВОИМИ кнопками (модальные слои): стандартный набор погашен. */
export interface FilterEditorButtonsOwn extends FilterEditorButtons {
  standard: false;
}

/** Запись отбора: имя и признак копии (кнопка «Сохранить» стандартного набора). */
export type FilterEditorSave = (request: { name: string; asCopy: boolean }) => void | Promise<void>;

/**
 * Колбэки хоста: редактор ничего не применяет и не сохраняет сам. Хост —
 * владелец места применения (запрос, сохранённые отборы, состояние экрана).
 *
 * Это МИНИМАЛЬНЫЙ набор для мест со своими кнопками (`buttons.standard: false`);
 * для стандартного набора см. {@link FilterEditorHostStandard} — там `save` и
 * `reset` обязательны: кнопка без обработчика — дефект контракта.
 */
export interface FilterEditorHost {
  /** Применить отбор (запуск запроса). Обязателен — ради него редактор и нужен. */
  apply: () => void;
  /** Записать отбор (кнопка «Сохранить» стандартного набора). */
  save?: FilterEditorSave;
  /** Очистить условия отбора (кнопка «Очистить» стандартного набора). */
  reset?: () => void;
  /** Текущее имя отбора в поле футера (по умолчанию — пустая строка). */
  getName?: () => string;
  /** Запись имени из поля футера в состояние хоста. */
  setName?: (name: string) => void;
  /** Имя применённого сохранённого отбора; `null` — отбор ещё не сохранён. */
  savedName?: () => string | null;
  /** Снимок определения на момент сохранения (для маркера ●). */
  baseline?: () => unknown;
  /**
   * Текущее определение для сравнения со снимком; по умолчанию — wire-AST
   * единого конструктора (`buildFilterAst` с профилем места).
   */
  current?: () => unknown;
  /** Записи диагностики от ядра (сервер, сохранённый отбор). По умолчанию — нет. */
  issues?: () => readonly FilterIssue[];
  /** Хост узнаёт, что пользователь просит исправить строку с этим адресом. */
  onFixPath?: (path: string) => void;
}

/**
 * Хост места со СТАНДАРТНЫМ набором кнопок: `save` и `reset` обязательны —
 * «Сохранить» и «Очистить» рисуются всегда, когда набор показан.
 */
export interface FilterEditorHostStandard extends FilterEditorHost {
  save: FilterEditorSave;
  reset: () => void;
}

/** Общие параметры фабрики (без пары «кнопки × хост» — её различают варианты). */
export interface FilterEditorOptionsBase {
  /** Профиль контекста места применения — данные, а не ветка кода (84b33a43). */
  profile: FilterProfileId;
  /** Сеть: живой поиск значений, пикер, облачка. */
  networkId: string;
  /** Данные сети: реестр свойств, типы связей, типы мыслей, контекстные операнды. */
  data: FilterTreeData;
  /** Живая модель отбора (единственная — `FilterCriteriaState`). */
  getState: () => FilterCriteriaState;
  /**
   * Запись ключей сортировки в модель; по умолчанию фабрика пишет их в
   * `state.sortKeys` (сортировка — отдельное поле модели, не узел AST).
   */
  setSortKeys?: (keys: FilterAstSortKey[]) => void;
  /** Правка модели: хост персистит состояние и ставит маркер «изменён». */
  touch?: () => void;
  /** Заголовок редактора; по умолчанию — профильный «Показать … по условиям:». */
  title?: string;
  /** Каталог перечислений, который знает только хост (типы действий, виды сущностей). */
  enumOptions?: (leaf: FilterTreeLeaf) => readonly FilterValueEnumOption[];
  /** Дополнительные источники подсказок хоста (контекстные токены отбора). */
  extraSuggest?: readonly SuggestSource[];
  /** Диалог «выбрать/создать» для ссылочного операнда (угол «…»). */
  picker?: EntityChipFieldOptions['picker'];
  /** Данные облачка значения-мысли (чипы ссылочных операндов). */
  cloudOf?: (value: string) => ThoughtCloudInput | null;
  /** Подтверждение сброса собранной под-выборки (по умолчанию — общий диалог). */
  confirmSubquery?: FilterSubqueryConfirm;
  /** Заголовок модала под-выборки; по умолчанию «Выборка». */
  subqueryTitle?: string;
  /** Показывать секцию сортировки (по умолчанию да). */
  sort?: boolean;
  /** Показывать футер (по умолчанию да). */
  footer?: boolean;
}

/**
 * Параметры единой фабрики (профиль места + данные сети + модель + хост).
 *
 * Два варианта, и различает их поле `buttons.standard`:
 *   • СТАНДАРТНЫЙ набор кнопок (по умолчанию) — хост обязан дать `save` и
 *     `reset`: «Сохранить» и «Очистить» рисуются всегда, когда набор показан,
 *     а кнопка без обработчика — дефект контракта ({@link FilterEditorHostStandard});
 *   • СВОИ кнопки места (`buttons: { standard: false }` — модальные слои с
 *     «Готово»/«Отмена») — `save`/`reset` не нужны: этих кнопок в разметке нет
 *     ({@link FilterEditorHost}).
 */
export type FilterEditorOptions =
  | (FilterEditorOptionsBase & {
      buttons?: FilterEditorButtonsStandard;
      host: FilterEditorHostStandard;
    })
  | (FilterEditorOptionsBase & {
      buttons: FilterEditorButtonsOwn;
      host: FilterEditorHost;
    });

/** Рукоятка собранного редактора. */
export interface FilterEditorHandle {
  /** Готовый контейнер: место применения кладёт его в свою разметку. */
  root: HTMLElement;
  /** Профиль, с которым собран редактор (данные места применения). */
  profile: FilterProfileId;
  /** Перечитать вид из модели: дерево, сортировку, футер. */
  refresh: () => void;
}

/**
 * Проверка контракта кнопок на входе (страховка для JS-вызовов и `any`:
 * типы такой вызов уже ловят): стандартный набор без `save`/`reset` — ошибка,
 * а не молчаливо неработающая кнопка.
 */
function assertButtonsContract(opts: FilterEditorOptions): void {
  if (opts.buttons?.standard === false) return;
  if (opts.host.save === undefined) {
    throw new Error(
      'buildFilterEditor: стандартный набор кнопок требует host.save (запись отбора); ' +
        'для мест со своими кнопками передайте buttons: { standard: false }',
    );
  }
  if (opts.host.reset === undefined) {
    throw new Error(
      'buildFilterEditor: стандартный набор кнопок требует host.reset (очистка условий); ' +
        'для мест со своими кнопками передайте buttons: { standard: false }',
    );
  }
}

/**
 * Собрать редактор места применения: дерево + секция сортировки + футер, поверх
 * виджетов значений, модала под-выборки, композера фразы и диагностики.
 *
 * Место применения передаёт профиль контекста и колбэки — сам редактор остаётся
 * общим: второй разметки условий, второго словаря операторов и второй модели в
 * местах не появляется (ADR 4154811f, ADR 30ff83bb).
 */
export function buildFilterEditor(opts: FilterEditorOptions): FilterEditorHandle {
  // Контракт кнопок проверяем до сборки: место со стандартным набором обязано
  // дать обработчики «Сохранить»/«Очистить» (типы ловят это на компиляции, эта
  // проверка — для JS-вызовов и `any`).
  assertButtonsContract(opts);
  const { profile, data, getState, host } = opts;
  const touch = opts.touch ?? ((): void => undefined);

  // Диагностика строк — один список на редактор: записи ядра (хост) плюс
  // проверки конструктора (пустая группа, условие без значения, противоречие).
  // Тот же список читают дерево (подсветка строк) и футер (фраза + запрет применения).
  const issues = (): readonly FilterIssue[] =>
    mergeFilterIssues(host.issues?.() ?? [], constructorFilterIssues(getState().tree ?? null));

  // Контекст виджетов значения — общий для ячейки строки и модала под-выборки:
  // профиль уходит в оба (гранулярность времени, состав токенов — из реестра).
  const valueContext: FilterValueContext = {
    networkId: opts.networkId,
    profile,
    data,
    touch,
    ...(opts.enumOptions !== undefined ? { enumOptions: opts.enumOptions } : {}),
    ...(opts.extraSuggest !== undefined ? { extraSuggest: opts.extraSuggest } : {}),
    ...(opts.picker !== undefined ? { picker: opts.picker } : {}),
    ...(opts.cloudOf !== undefined ? { cloudOf: opts.cloudOf } : {}),
  };

  const root = div(FILTER_EDITOR_CLASS);

  const tree = buildFilterTree({
    profile,
    getState,
    data,
    touch,
    issues,
    renderValue: createFilterSubqueryValueRenderer(valueContext, {
      data,
      value: valueContext,
      ...(opts.subqueryTitle !== undefined ? { title: opts.subqueryTitle } : {}),
      ...(opts.confirmSubquery !== undefined ? { confirm: opts.confirmSubquery } : {}),
    }),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(host.onFixPath !== undefined ? { onFixPath: host.onFixPath } : {}),
  });
  root.append(tree.root);

  const foot = div(FILTER_EDITOR_FOOT_CLASS);

  // Секция сортировки — отдельное поле модели (`state.sortKeys`), не узел AST.
  let sortSection: FilterSortSectionHandle | null = null;
  if (opts.sort !== false) {
    const setSortKeys =
      opts.setSortKeys ??
      ((keys: FilterAstSortKey[]): void => {
        getState().sortKeys = keys;
        touch();
      });
    sortSection = buildFilterSortSection({
      getKeys: () => getState().sortKeys ?? [],
      setKeys: setSortKeys,
      options: () => filterSortKeyOptions({ registry: data.registry, linkTypes: data.linkTypes }),
      data: { registry: data.registry, linkTypes: data.linkTypes ?? [] },
      issues,
      onChange: touch,
    });
    foot.append(sortSection.root);
  }

  // Футер: имя, маркер ●, фраза-превью из композера с диагностикой, кнопки места.
  const phraseContext: FilterPhraseContext = {
    registry: data.registry,
    linkTypes: data.linkTypes ?? [],
    // Типы мыслей — имена значений-типов во фразе-превью (ошибка 4258e694 п.12б).
    thoughtTypes: data.thoughtTypes ?? [],
  };
  let footer: FilterFooterHandle | null = null;
  if (opts.footer !== false) {
    footer = buildFilterFooter({
      // Место без сохранённых отборов (лента «События») не даёт getName/setName —
      // футер тогда не рисует строку имени и маркер ● (только фраза и кнопки).
      ...(host.getName !== undefined ? { getName: host.getName } : {}),
      ...(host.setName !== undefined ? { setName: host.setName } : {}),
      savedName: host.savedName ?? (() => null),
      baseline: host.baseline ?? (() => null),
      current: host.current ?? (() => buildFilterAst(getState(), { profile })),
      preview: () => {
        const state = getState();
        const text = composeFilterPhrase(
          { tree: state.tree ?? null, sortKeys: state.sortKeys ?? [] },
          phraseContext,
        );
        const list = issues();
        // Ни фразы, ни диагностики — превью не подписывается.
        if (text === '' && list.length === 0) return undefined;
        return { text, issues: list };
      },
      onSave: (request) => host.save?.(request),
      onApply: host.apply,
      onClear: host.reset ?? ((): void => undefined),
      // Переход «исправить» из сообщения о запрете ведёт в ту же строку, что и
      // кнопка строки: каркас дерева знает адрес → фокус (0fd1dc5d, 44d61c8a).
      onFixIssue: (path) => {
        tree.focusIssue(path);
        host.onFixPath?.(path);
      },
      ...(opts.buttons?.extra !== undefined ? { extraButtons: opts.buttons.extra } : {}),
      ...(opts.buttons?.standard !== undefined ? { standardButtons: opts.buttons.standard } : {}),
    });
    foot.append(footer.root);
  }
  if (foot.children.length > 0) root.append(foot);

  const refresh = (): void => {
    tree.rerender();
    sortSection?.rerender();
    footer?.refresh();
  };

  return { root, profile, refresh };
}
