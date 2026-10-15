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
import {
  buildFilterAst,
  defaultFilterTreeGroup,
  type FilterCriteriaState,
  type FilterTreeLeaf,
} from './filter-builder.js';
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
import { composeFilterPhrase, filterPhraseThoughtIds, type FilterPhraseContext } from './filter-phrase.js';
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
// Имя пользователя по id для фразы-превью (ошибка 23c7d3e9 п. A1) — кэш
// участников сети; читается без сети (`resolveUserName`), а на наполнение кэша
// фраза ПОДПИСЫВАЕТСЯ (ошибка части 6, п.7): при холодном кэше фраза показывала
// обрезанный id и не перерисовывалась, когда ростер приходил.
import { resolveUserName, subscribe as subscribeUsers } from './users.js';
// Имя МЫСЛИ по id для фразы-превью (ошибка d17a8bfd) — кэш имён мыслей; фраза
// читает его синхронно (`resolveThoughtName`), а на наполнение подписывается
// (иначе имена ссылок на мысли «застыли» бы в плейсхолдере до пересборки).
import {
  requestThoughtNames,
  resolveThoughtName,
  subscribe as subscribeThoughtNames,
} from './thought-names.js';

/**
 * Рефрешеры фразы живых редакторов. Фраза-превью показывает ИМЕНА сущностей по
 * id, а кэши наполняются асинхронно (best-effort ростер участников, батч имён
 * мыслей): пока кэш холодный, фраза показывает плейсхолдер/обрезанный id и
 * обновляется, когда данные придут. Подписка — ОДНА на источник (не по
 * редактору: пересборки панели копили бы слушателей); отключённые корни
 * вычищаются при очередном уведомлении.
 */
const phraseRefreshers = new Set<{ root: HTMLElement; refresh: () => void }>();
let phraseSourcesSubscribed = false;

/** Подписать фразу редактора на наполнение кэшей подписей (один раз на модуль). */
function subscribePhraseRefresh(entry: { root: HTMLElement; refresh: () => void }): void {
  phraseRefreshers.add(entry);
  if (phraseSourcesSubscribed) return;
  phraseSourcesSubscribed = true;
  const notify = (): void => {
    for (const item of [...phraseRefreshers]) {
      if (!item.root.isConnected) {
        phraseRefreshers.delete(item);
        continue;
      }
      item.refresh();
    }
  };
  subscribeUsers(notify);
  subscribeThoughtNames(notify);
}

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
  /**
   * Правка ЗНАЧЕНИЯ условия — набор текста в поле значения (ошибка 7d36f439):
   * хост персистит состояние и снимает серверную диагностику прежнего запроса,
   * но НЕ пересобирает редактор. Фразу-превью футера обновляет сама фабрика
   * (`footer.refresh`), дерево остаётся на месте — поле ввода сохраняет фокус и
   * каретку между нажатиями. Структурные правки (смена операнда/оператора,
   * добавление-удаление строки/группы, свёртка, пресет) идут прежним путём
   * `touch`. Не задан — правка значения идёт общим путём `touch`.
   */
  touchValue?: () => void;
  /**
   * Место исполняет отбор ОТНОСИТЕЛЬНО мысли-контекста — тогда значениям
   * доступны токены полей мысли (`$thought*`), см. `lib/filter-tokens.ts`.
   * Признак МЕСТА сборки, а не профиля (требование 3697eb65): единственное
   * фокусное место — диалог отбора типа мысли; сетевые отборы (панель
   * «Структур», строка поиска, хроника, события, публикации) токенов мысли не
   * предлагают. По умолчанию `false`.
   */
  withFocusThought?: boolean;
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
  /**
   * Лист НЕУДАЛЯЕМ (ошибка 609deba0 п.2): крестик строки не рисуется. Хост
   * помечает обязательные условия места (например, «Период записи» панели
   * «Дневника», которым управляет календарь). Прокидывается в дерево.
   */
  isLeafLocked?: (leaf: FilterTreeLeaf) => boolean;
  /** Заголовок модала под-выборки; по умолчанию «Выборка». */
  subqueryTitle?: string;
  /** Показывать секцию сортировки (по умолчанию да). */
  sort?: boolean;
  /** Показывать футер (по умолчанию да). */
  footer?: boolean;
  /**
   * Управление места, стоящее НАД футером — непосредственно над фразой-превью
   * (ошибка 609deba0 п.3): например, переключатель направления ленты «Дневника»
   * («Сначала старые/Сначала новые»). Кладётся первым в непрокручиваемый низ
   * редактора (`.fe-foot`), поэтому отбор не «уезжает» вместе с деревом.
   */
  aboveFooter?: HTMLElement;
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
  /**
   * Строка имени отбора из футера — `null`, если место не дало getName
   * (например, лента «События» без сохранённых отборов). Хост может ПЕРЕМЕСТИТЬ
   * строку в своей разметке (диалог отбора типа ставит имя первым полем — ошибка
   * 50d9bf4e п. A1); сама строка строится один раз футером.
   */
  nameRow: HTMLElement | null;
  /** Перечитать вид из модели: дерево, сортировку, футер. */
  refresh: () => void;
  /**
   * Очистить условия отбора: основная (корневая) группа обнуляется до пустой
   * `И` — все её группы и условия снимаются, пустая основная группа остаётся
   * (`defaultFilterTreeGroup`). Модель — единственный источник состояния
   * (ADR 30ff83bb), поэтому сброс идёт полем `state.tree`; другие поля хоста
   * (сортировка, имя отбора, сохранённые отборы) НЕ трогаются — их сбрасывает
   * сам хост. Редактор перерисовывается; правка проводится через `touch`, чтобы
   * хост сохранил состояние и применил отбор.
   */
  clear: () => void;
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

  /** Футер собирается ниже; правка значения обновляет его фразу (ошибка 7d36f439). */
  let footer: FilterFooterHandle | null = null;

  /**
   * Правка значения условия (ошибка 7d36f439): хост персистит и снимает
   * серверную диагностику, фразу-превью перечитывает футер — дерево НЕ
   * пересобирается, поэтому поле ввода не теряет фокус и каретку. Хост не дал
   * `touchValue` (не различает правку значения и структуры) — прежний путь.
   */
  const onValueEdit = (): void => {
    if (opts.touchValue === undefined) {
      touch();
      return;
    }
    opts.touchValue();
    footer?.refresh();
  };

  // Контекст виджетов значения — общий для ячейки строки и модала под-выборки:
  // профиль уходит в оба (гранулярность времени, состав токенов — из реестра).
  const valueContext: FilterValueContext = {
    networkId: opts.networkId,
    profile,
    data,
    touch,
    ...(opts.withFocusThought !== undefined ? { withFocusThought: opts.withFocusThought } : {}),
    ...(opts.enumOptions !== undefined ? { enumOptions: opts.enumOptions } : {}),
    ...(opts.extraSuggest !== undefined ? { extraSuggest: opts.extraSuggest } : {}),
    ...(opts.picker !== undefined ? { picker: opts.picker } : {}),
    ...(opts.cloudOf !== undefined ? { cloudOf: opts.cloudOf } : {}),
  };

  const root = div(FILTER_EDITOR_CLASS);

  /**
   * Резолверы имён подписей — ОДИН набор на редактор: фразы-превью футера и
   * подписи чипа под-выборки читают имена одинаково (ошибка 1ee81c35).
   *
   * Пользователи — именами, а не id (ошибка 23c7d3e9 п. A1): кэш участников сети
   * (`lib/users.ts`) отдаёт имя по id; для «Автора»/«Редактора» и операндов
   * записи подпись показывает имя; кэш не полон (не админ) — значение остаётся
   * id, как раньше.
   *
   * Мысли — именами, а не id (ошибка d17a8bfd): кэш имён мыслей
   * (`lib/thought-names.ts`) отдаёт название по id; пока имя не догружено,
   * подпись показывает плейсхолдер без ID (требование 9d5e3c4e), а подписки ниже
   * перерисовывают подпись, когда имя приходит.
   */
  const labelNames = {
    userName: (id: string): string | null => resolveUserName(id),
    thoughtName: (id: string): string | null => resolveThoughtName(id),
  };

  const tree = buildFilterTree({
    profile,
    getState,
    data,
    touch,
    onValueEdit,
    issues,
    renderValue: createFilterSubqueryValueRenderer(valueContext, {
      data,
      value: valueContext,
      names: labelNames,
      ...(opts.subqueryTitle !== undefined ? { title: opts.subqueryTitle } : {}),
      ...(opts.confirmSubquery !== undefined ? { confirm: opts.confirmSubquery } : {}),
    }),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.isLeafLocked !== undefined ? { isLeafLocked: opts.isLeafLocked } : {}),
    ...(host.onFixPath !== undefined ? { onFixPath: host.onFixPath } : {}),
  });
  root.append(tree.root);

  const foot = div(FILTER_EDITOR_FOOT_CLASS);
  // Управление места НАД футером (над фразой-превью) — первым в непрокручиваемом
  // низу редактора (ошибка 609deba0 п.3).
  if (opts.aboveFooter !== undefined) foot.append(opts.aboveFooter);

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
    // Имена участников и мыслей — общий набор резолверов редактора (labelNames).
    userName: labelNames.userName,
    thoughtName: labelNames.thoughtName,
  };
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
        const phraseState = { tree: state.tree ?? null, sortKeys: state.sortKeys ?? [] };
        // Имена мыслей для фразы догружаем ВНЕ композера (модуль чистый):
        // собираем id ссылок и просим кэш имён; когда батч вернётся, подписка
        // перерисует фразу с именами (ошибка d17a8bfd).
        requestThoughtNames(opts.networkId, filterPhraseThoughtIds(phraseState, data.registry));
        const text = composeFilterPhrase(phraseState, phraseContext);
        const list = issues();
        // Ни фразы, ни диагностики — превью не подписывается.
        if (text === '' && list.length === 0) return undefined;
        return { text, issues: list };
      },
      onSave: (request) => host.save?.(request),
      onApply: host.apply,
      onClear: host.reset ?? ((): void => undefined),
      // Переход к проблемной строке из сообщения о запрете (клик по тексту
      // фразы в футере или по тексту причины в строке) ведёт по одному адресу:
      // каркас дерева знает адрес → фокус (0fd1dc5d, 44d61c8a).
      onFixIssue: (path) => {
        tree.focusIssue(path);
        host.onFixPath?.(path);
      },
      ...(opts.buttons?.extra !== undefined ? { extraButtons: opts.buttons.extra } : {}),
      ...(opts.buttons?.standard !== undefined ? { standardButtons: opts.buttons.standard } : {}),
    });
    foot.append(footer.root);
    // Фраза-превью — имена сущностей по id: при наполнении кэшей (участники,
    // имена мыслей) перерисовываем фразу, чтобы id не «застыл» (ошибка части 6,
    // п.7; ошибка d17a8bfd).
    subscribePhraseRefresh({ root, refresh: () => footer?.refresh() });
  }
  if (foot.children.length > 0) root.append(foot);

  const refresh = (): void => {
    tree.rerender();
    sortSection?.rerender();
    footer?.refresh();
  };

  /**
   * Очистка условий места (кнопка «Очистить» зоны настроек строки поиска,
   * задача 4b1cc3d4): корневая группа модели становится пустой `И` — все
   * группы и условия основной группы сняты, сама группа остаётся. Далее
   * обычный путь правки модели: перерисовка + `touch` (хост персистит и
   * применяет), чтобы очистка не разошлась с состоянием места.
   */
  const clear = (): void => {
    getState().tree = defaultFilterTreeGroup('and');
    refresh();
    touch();
  };

  return { root, profile, nameRow: footer?.nameRow ?? null, refresh, clear };
}
