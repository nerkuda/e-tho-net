/**
 * Единая выпадашка подсказок под полем ввода — один модуль на все поля
 * значения, строку поиска и пикер сущностей (ADR «одна выпадашка-подсказчик,
 * источник вариантов — её параметр»; элемент интерфейса «Выпадашка подсказок:
 * история и поиск»; задача 9a2e30b1, веха 3 версии 0.8.2).
 *
 * Источник вариантов — параметр компонента, а не повод написать ещё одну
 * выпадашку:
 *
 * | Источник                            | `when`   | Когда показывается                          |
 * |-------------------------------------|----------|---------------------------------------------|
 * | история последних значений (до 10)  | `empty`  | поле пустое, пользователь ещё не печатал    |
 * | результаты живого поиска            | `typed`  | введён хотя бы один символ                  |
 * | закрытый список `config.options`    | `typed`  | при вводе (сужается по фрагменту); полный   |
 * |                                     |          | список — вручную через `handle.open()`; у    |
 * |                                     |          | свойства со списком — сразу при входе в поле |
 * |                                     |          | (`showAllUntilEdited`)                       |
 * | произвольный список                 | `always` | при любом содержимом поля                   |
 *
 * Клавиатура одна на все источники: ↑/↓ — перебор, Enter — выбрать
 * выделенное (без выделения — первую строку), клик — выбрать, Esc —
 * закрыть список, НЕ закрывая диалог, Tab/Shift+Tab — закрыть список
 * и пропустить фокус дальше по порядку полей (нажатие не гасится),
 * потеря фокуса — закрыть.
 *
 * Защита диалога от Esc: capture-слушатель
 * на `window` регистрируется в момент подключения — раньше, чем `showDialog`
 * добавит свой capture-обработчик Esc, — поэтому `stopImmediatePropagation`
 * гасит нажатие до диалога (на одном узле capture-слушатели выполняются в
 * порядке регистрации). Повторы Esc тоже гасятся: зажатый Esc не должен
 * закрыть список и тут же диалог.
 *
 * Модуль не подключает себя к полям — подключение делает веха 4 (задача
 * 77e7cafd). Потолок истории «10 значений» — дело источника
 * (`RECENT_VALUES_MAX` в editor/recent-values.ts), модуль рендерит всё, что
 * вернул `load`. Множественный выбор (галочки, «Готово») остаётся вне
 * контракта: это отдельный режим ввода, а не подсказка.
 *
 * Строка, показывающая мысль, строится фабрикой облачка
 * (`createThoughtCloud`, профиль `chip`, ширина по контейнеру): значок, цвета,
 * начертание, бледность неактуальной и метка корзины приходят из одного
 * представления мысли (стандарт «Клиент: представление мысли — только через
 * общую фабрику облачка»). Голый `label` остаётся для нессылочных подсказок —
 * истории текстовых значений, `config.options`, токенов.
 */

import type { LinkStyle } from '@etn/shared';

import { div, el, positionBodyDropdown, span } from './dom.js';
import { svgIcon } from './ui/icon.js';
import { buildLinkEndIcon, type LinkEndIconSpec } from './property-list.js';
import { createThoughtCloud, type CloudProfile, type ThoughtCloudInput } from './thought-cloud.js';

/** Одна выбираемая строка выпадашки. */
export interface SuggestEntry {
  /** Значение, которое подставляется в поле при выборе. */
  value: string;
  /** Подпись строки (может отличаться от значения: id → название). */
  label: string;
  /**
   * Данные мысли: строка рисуется готовым облачком общей фабрики — значок,
   * цвета, начертание, бледность неактуальной, метка корзины и обрезка имени
   * по ширине контейнера. Нет — строка остаётся голым текстом `label`
   * (богатая строка это опция источника, а не обязанность).
   */
  thought?: ThoughtCloudInput;
  /** Заголовок группы строки (секции токен-комбо): строки одной секции подряд. */
  section?: string;
  /** `true` — строка показывается, но не выбирается (недоступный вариант). */
  disabled?: boolean;
  /**
   * Отступ строки в шагах дерева типов (0 — верхний уровень). Строки с
   * заданным отступом выравниваются по общей колонке тоггла: у листа вместо
   * треугольника остаётся пустое место. Нет — строка без отступа и без
   * колонки тоггла.
   */
  indent?: number;
  /** Свотч линии перед строкой — вид линии типа связи (цвет/штрих/толщина). */
  swatch?: { color: string | null; style: LinkStyle | null; width: number | null } | null;
  /**
   * Значок конца связи перед подписью (вертикальная линия со стрелкой: вниз у
   * исходящей стороны, вверх у входящей, задача 88def930). Рисуется общим списком
   * свойств (`buildLinkEndIcon`) — строки выбора стороны свойства-связи выглядят
   * как строки списка свойств (общий комбо-пикер `lib/entity-picker.ts`,
   * четвёртый источник «свойство связи»; требование cdb6b52f).
   */
  linkEnd?: LinkEndIconSpec | null;
  /**
   * Уточнение справа от подписи (серым): сторона и имена пары типа связи
   * («источник · связь (прямое - обратное)»). Нет — строка без уточнения.
   * Рисуется только у «голых» строк (без облачка).
   */
  note?: string;
  /**
   * Подсказка всей строки (`title`). Список найденных диалога добавления несёт
   * здесь полное имя и точность совпадения (точное имя / синоним / частичное) —
   * их показывают подсказкой, а не отдельной пометкой в строке (08-ui-spec.md
   * §4.2). Нет — подсказки строки нет (у «голых» строк остаётся `label`).
   */
  tooltip?: string;
  /**
   * Дополнительная метка справа от облачка/подписи: имя родителя или имя сети
   * (различение одноимённых мыслей; 08-ui-spec.md §4.2, ошибка defcd811).
   * `tone: 'accent'` — акцентный цвет (имя чужой сети), иначе приглушённый.
   */
  trailing?: { text: string; tone?: 'muted' | 'accent'; tooltip?: string };
  /**
   * Узел дерева с раскрытием: слева рисуется треугольник ▾/▸. Клик по
   * треугольнику вызывает `onToggle` (источник меняет своё состояние
   * раскрытия) и перерисовывает список; сама строка остаётся выбираемой.
   */
  toggle?: { expanded: boolean; onToggle(): void };
  /** Строка быстрого создания: акцентный цвет и значок «+» (`type-combo-create`). */
  create?: boolean;
  /**
   * Id найденной дневниковой записи (0.10.1, T7). Строка-запись означает не
   * подстановку текста, а переход: `onPick` вызывающего распознаёт поле и
   * открывает запись вместо записи значения в поле.
   */
  recordId?: string;
}

/** Когда источник участвует в списке. */
export type SuggestWhen =
  /** Пустое поле: фокус на пустом поле или очистка до пустой строки (история). */
  | 'empty'
  /** Введён хотя бы один символ (живой поиск). */
  | 'typed'
  /** При любом содержимом поля. */
  | 'always';

/** Источник вариантов — параметр компонента (ADR: не повод писать выпадашку). */
export interface SuggestSource {
  /** Когда источник участвует в списке. */
  when: SuggestWhen;
  /**
   * Заголовок группы строк (не обязателен); показывается, только когда у
   * источника есть хотя бы одна строка.
   */
  header?: string;
  /**
   * Варианты для текущего текста поля. Можно синхронно или асинхронно
   * (запрос к серверу); ответы устаревших вызовов отбрасываются.
   */
  load(query: string): SuggestEntry[] | Promise<SuggestEntry[]>;
  /**
   * Порционная подгрузка (задача c8fa74ba): следующие варианты начиная с
   * `offset` (число уже показанных строк этого источника). Задана — список
   * догружается при скролле выпадашки вниз, порциями по {@link pageSize}.
   * Источник с `loadMore` обязан возвращать первые `pageSize` строк из `load`.
   */
  loadMore?(query: string, offset: number): Promise<SuggestEntry[]>;
  /**
   * Размер порции источника с {@link SuggestSource.loadMore} (по умолчанию
   * 50). Ответ короче порции считается последним — догрузка прекращается.
   */
  pageSize?: number;
}

/** Параметры {@link wireSuggest}. */
export interface WireSuggestOptions {
  /** Источники в порядке отображения; строки всех активных источников — один список. */
  sources: readonly SuggestSource[];
  /**
   * Enter без выделенной строки выбирает первую (история и живой поиск —
   * да). `false` — только явно выделенную: свободный текст обрабатывает
   * обработчик вызывающего (токен-комбо, chip-поле).
   */
  pickFirstOnEnter?: boolean;
  /**
   * Нижняя граница ширины списка, px (по умолчанию нет — список не уже поля и
   * не шире 320px). Поле «Свойство связи» просит список заметно шире узкого
   * поля ввода, иначе имена сторон и пары связи не помещаются (ошибка
   * 5817b009); значение поднимает и потолок ширины, если он ниже.
   */
  minWidth?: number;
  /** Выбрана строка (клик или Enter). Список к этому моменту уже закрыт. */
  onPick(entry: SuggestEntry): void;
}

/** Управление подключённой выпадашкой (для кнопки ▾ и перерисовок редактора). */
export interface SuggestHandle {
  /** Принудительно открывает список со всеми источниками, игнорируя `when`. */
  open(): void;
  /** Закрывает список без выбора. */
  close(): void;
  /** Закрывает список и снимает все слушатели (перерисовка редактора). */
  dispose(): void;
}

/**
 * Открытые списки-подсказчики: слой живёт в `document.body` (позиционируется
 * `positionBodyDropdown`), а не внутри поля. Панели, содержащие такое поле
 * (строка поиска карты), должны узнавать клик по этому слою как «свой» —
 * иначе нажатие закрывает панель, поле теряет фокус, список исчезает и выбор
 * не доезжает до `onPick` (ошибка 72a06e01).
 */
const openLists = new Set<HTMLElement>();

/**
 * Принадлежит ли узел открытой выпадашке подсказок. Общий слой для панелей,
 * которые закрываются кликом вне себя: клик по подсказке — клик «внутри»
 * такого поля (ошибка 72a06e01).
 */
export function isInsideSuggestDropdown(node: Node | null): boolean {
  if (node === null) return false;
  for (const list of openLists) {
    if (list.contains(node)) return true;
  }
  return false;
}

/** Выполняется ли условие показа источника при данном тексте поля. */
function matchesWhen(when: SuggestWhen, query: string): boolean {
  if (when === 'empty') return query === '';
  if (when === 'typed') return query !== '';
  return true;
}

/**
 * Индексная арифметика ↑/↓ по строкам — единственный экземпляр на клиент
 * (сторож `guard-suggest-dropdown` краснеет на копии): из общего поля пустое
 * выделение идёт к первой строке вниз и к последней вверх, дальше — шаг без
 * перехода через край.
 */
function navIndex(cursor: number | null, count: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  const base = cursor === null || cursor >= count ? (delta === 1 ? -1 : count) : cursor;
  return Math.min(count - 1, Math.max(0, base + delta));
}

/** Порог близости к нижней границе списка, px: ближе — догружаем порцию. */
const SUGGEST_SCROLL_THRESHOLD_PX = 48;

/** Опции сборки одной строки списка (см. {@link buildSuggestRow}). */
export interface SuggestRowOptions {
  /**
   * Профиль облачка строки-мысли (по умолчанию `chip` — строка летящей
   * выпадашки). Список найденных диалога добавления просит `tree`: строка
   * лежит в теле диалога и несёт более крупное облачко (§4.2).
   */
  cloudProfile?: CloudProfile;
  /**
   * Строка — самостоятельная цель фокуса: `tabindex=0`, `mousedown` НЕ гасится,
   * поэтому `Tab`/`↑`/`↓` ходят по строкам (список найденных диалога добавления).
   * По умолчанию `false` — фокус остаётся в поле ввода (летящая выпадашка).
   */
  focusable?: boolean;
  /**
   * Выбор строки: `mousedown` гасится (фокус не уходит из поля) и вешается
   * `click`. Недоступная строка (`disabled`) выбора не получает.
   */
  onPick?: (entry: SuggestEntry) => void;
  /** Клик по треугольнику раскрытия — владелец меняет состояние и перерисовывает. */
  onToggle?: (entry: SuggestEntry) => void;
}

/**
 * Собирает одну строку списка подсказок (`type-combo-item`) — единственное
 * место разметки строки: значок раскрытия, свотч линии, значок конца связи,
 * облачко мысли общей фабрики, «голая» подпись и метка-уточнение. Летящая
 * выпадашка ({@link wireSuggest}) и список найденных диалога добавления
 * (`canvas/add-dialog.ts`) строят строки здесь, а не собственными копиями
 * (ADR «одна выпадашка-подсказчик»; сторож `guard-suggest-dropdown`).
 */
export function buildSuggestRow(entry: SuggestEntry, options: SuggestRowOptions = {}): HTMLElement {
  const row = div('type-combo-item');
  if (entry.create === true) row.classList.add('type-combo-create');
  if (entry.disabled === true) row.classList.add('disabled');
  // Отступ дерева типов: строки с отступом получают колонку тоггла,
  // у листа она пустая — подписи соседних уровней не разъезжаются.
  if (entry.indent !== undefined) {
    row.style.paddingLeft = `${8 + Math.max(0, entry.indent) * 16}px`;
  }
  if (entry.toggle !== undefined) {
    const toggle = span(entry.toggle.expanded ? '▾' : '▸', 'type-combo-toggle');
    toggle.addEventListener('mousedown', (event) => event.preventDefault());
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      entry.toggle?.onToggle();
      options.onToggle?.(entry);
    });
    row.append(toggle);
  } else if (entry.indent !== undefined) {
    row.append(span('', 'type-combo-toggle type-combo-toggle-leaf'));
  }
  if (entry.swatch !== undefined && entry.swatch !== null) {
    const swatch = span('', 'type-combo-swatch');
    const style = entry.swatch.style;
    const dash = style === 'dashed' ? 'dashed' : style === 'dotted' ? 'dotted' : 'solid';
    const width = Math.max(1, Math.min(6, entry.swatch.width ?? 1));
    swatch.style.borderTop = `${width}px ${dash} ${entry.swatch.color ?? '#9aa3b2'}`;
    row.append(swatch);
  }
  // Значок конца связи (направление + оформление линии) — тот же, что в
  // общем списке свойств: второй отрисовки линии со стрелкой нет.
  if (entry.linkEnd !== undefined && entry.linkEnd !== null) {
    row.append(buildLinkEndIcon(entry.linkEnd));
  }
  if (entry.thought !== undefined) {
    // Строка-мысль — готовое облачко фабрики: значок, цвета, начертание,
    // бледность неактуальной, метка корзины и обрезка имени по ширине
    // строки. Профиль по умолчанию `chip` — списочная строка выпадашки,
    // метка корзины встроена в пилюлю и не вылезает за край.
    row.append(
      createThoughtCloud(entry.thought, {
        profile: options.cloudProfile ?? 'chip',
        width: 'container',
      }),
    );
  } else if (entry.create === true) {
    const icon = span('', 'type-combo-icon');
    icon.append(svgIcon('plus', 12));
    row.append(icon);
    const label = el('span', 'type-combo-label');
    label.style.flex = '1';
    label.append(entry.label);
    row.append(label);
  } else {
    const label = el('span', 'type-combo-label', entry.label);
    label.title = entry.label;
    label.style.flex = '1';
    row.append(label);
    // Уточнение (сторона и имена пары типа связи) — серым справа от имени.
    if (entry.note !== undefined && entry.note !== '') {
      row.append(span(entry.note, 'type-combo-note'));
    }
  }
  // Метка-уточнение родителя/сети — справа от облачка или подписи, у любого
  // вида строки (у кандидатов-мыслей облачко, у «голой» — подпись).
  if (entry.trailing !== undefined) {
    const tone = entry.trailing.tone === 'accent' ? ' type-combo-note--accent' : '';
    const trailing = span(entry.trailing.text, `type-combo-note${tone}`);
    if (entry.trailing.tooltip !== undefined) trailing.title = entry.trailing.tooltip;
    row.append(trailing);
  }
  if (entry.tooltip !== undefined) row.title = entry.tooltip;
  if (options.focusable === true) row.tabIndex = 0;
  if (options.onPick !== undefined && entry.disabled !== true) {
    // Фокус остаётся в поле — нет blur-коммита во время выбора.
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => options.onPick?.(entry));
  }
  return row;
}

/**
 * Подключает выпадашку подсказок к полю ввода.
 *
 * Список открывается сам: фокус на поле (для `empty`/`always`) и каждый ввод
 * (`typed`/`always`; очистка до пустой строки возвращает `empty`-источники).
 * Пока поле печатается, список остаётся на экране и перерисовывается новыми
 * вариантами; строк без вариантов нет — пустой ответ закрывает список.
 *
 * Классы строк — `type-combo-list`/`type-combo-item`/`type-combo-label`, та же
 * механика и внешний вид, что у существующих пикеров (выбор строки не
 * забирает фокус из поля: mousedown по строке предотвращается).
 */
export function wireSuggest(input: HTMLInputElement, opts: WireSuggestOptions): SuggestHandle {
  let list: HTMLDivElement | null = null;
  /** Строки в порядке отображения (заголовки групп не считаются). */
  let rows: HTMLElement[] = [];
  /** Вариант каждой строки — параллельно {@link rows}. */
  let rowEntries: SuggestEntry[] = [];
  /** Выделенная строка: null — без выделения, Enter берёт первую. */
  let cursor: number | null = null;
  /** Фокус в поле: асинхронная загрузка, устаревшая после blur, не открывается. */
  let focused = false;
  /** Порядковый номер запроса: побеждает только последний. */
  let seq = 0;
  /** Последние сгруппированные строки списка — база для догрузки порций. */
  let lastGroups: Array<{ source: SuggestSource; entries: SuggestEntry[] }> = [];
  /** Состояние порций источника с `loadMore`: сколько показано и всё ли. */
  const pageState = new Map<SuggestSource, { offset: number; done: boolean }>();
  /** Идёт ли запрос следующей порции прямо сейчас. */
  let loadingMore = false;

  /** Размер порции источника (по умолчанию 50). */
  const pageSizeOf = (source: SuggestSource): number => source.pageSize ?? 50;

  /** Догружает следующую порцию источника при скролле выпадашки к низу. */
  const loadMoreNext = async (): Promise<void> => {
    if (loadingMore) return;
    const query = input.value;
    for (const group of lastGroups) {
      const source = group.source;
      const state = pageState.get(source);
      if (source.loadMore === undefined || state === undefined || state.done) continue;
      loadingMore = true;
      try {
        const more = await source.loadMore(query, state.offset);
        // Инвалидация: поле ушло, текст изменился или список пересобран.
        if (!input.isConnected || input.value !== query || !lastGroups.includes(group)) return;
        group.entries.push(...more);
        state.offset += more.length;
        if (more.length < pageSizeOf(source)) state.done = true;
        render(lastGroups);
      } catch {
        // Проброс не должен крутить бесконечную догрузку — повторит скролл.
        state.done = true;
      } finally {
        loadingMore = false;
      }
      return;
    }
  };

  /** Скролл списка: у нижней границы — догружаем порцию. */
  const onListScroll = (): void => {
    if (list === null) return;
    const remaining = list.scrollHeight - (list.scrollTop + list.clientHeight);
    if (remaining <= SUGGEST_SCROLL_THRESHOLD_PX) void loadMoreNext();
  };

  const close = (): void => {
    if (list !== null) {
      openLists.delete(list);
      list.remove();
      list = null;
    }
    rows = [];
    rowEntries = [];
    cursor = null;
    lastGroups = [];
    pageState.clear();
    loadingMore = false;
  };

  const paint = (): void => {
    rows.forEach((row, i) => row.classList.toggle('active', i === cursor));
    if (cursor !== null) rows[cursor]?.scrollIntoView({ block: 'nearest' });
  };

  /** Первая выбираемая (не `disabled`) строка; нет такой — `null`. */
  const firstSelectable = (): number | null => {
    for (let i = 0; i < rowEntries.length; i++) {
      if (rowEntries[i]?.disabled !== true) return i;
    }
    return null;
  };

  /** Индекс следующей выбираемой строки в направлении ↑/↓ (без перехода через край). */
  const moveCursor = (delta: 1 | -1): number | null => {
    if (rowEntries.length === 0) return null;
    let cur = cursor;
    for (let guard = 0; guard <= rowEntries.length; guard++) {
      const next = navIndex(cur, rowEntries.length, delta);
      if (next === null) return null;
      if (rowEntries[next]?.disabled !== true) return next;
      if (next === cur) return null; // упёрлись в край, выбираемых дальше нет
      cur = next;
    }
    return null;
  };

  /** Рисует (или перерисовывает) список; пустой результат закрывает его. */
  function render(groups: Array<{ source: SuggestSource; entries: SuggestEntry[] }>): void {
    const nonEmpty = groups.filter((group) => group.entries.length > 0);
    if (nonEmpty.length === 0) {
      close();
      return;
    }
    const fresh = list === null;
    // `replaceChildren` сбрасывает прокрутку — сохраняем позицию, чтобы
    // догрузка порции не уводила список вверх (задача c8fa74ba).
    const prevScroll = list?.scrollTop ?? 0;
    let box: HTMLDivElement;
    if (list === null) {
      box = div('type-combo-list');
      list = box;
      cursor = null;
      box.addEventListener('scroll', onListScroll);
    } else {
      box = list;
      box.replaceChildren();
    }
    rows = [];
    rowEntries = [];
    for (const group of nonEmpty) {
      if (group.source.header !== undefined) {
        box.append(el('p', 'muted type-combo-empty', group.source.header));
      }
      let lastSection: string | undefined;
      for (const entry of group.entries) {
        if (entry.section !== undefined && entry.section !== lastSection) {
          box.append(el('p', 'muted type-combo-empty', entry.section));
        }
        lastSection = entry.section;
        // Разметку строки собирает общий модуль — второго места нет.
        const row = buildSuggestRow(entry, {
          onToggle: () => refresh(false),
          onPick: (picked) => {
            close();
            opts.onPick(picked);
          },
        });
        box.append(row);
        rows.push(row);
        rowEntries.push(entry);
      }
    }
    if (fresh) {
      openLists.add(box);
      document.body.append(box);
      positionBodyDropdown(box, input, 320, opts.minWidth ?? 0);
    } else {
      box.scrollTop = prevScroll;
    }
    if (cursor !== null) cursor = Math.min(cursor, rowEntries.length - 1);
    paint();
  }

  /**
   * Пересчитывает список по текущему состоянию поля. `force` — ручное
   * открытие (`handle.open`): участвуют все источники независимо от `when`.
   * Порядковый номер растёт при каждом вызове — в том числе когда источников
   * не осталось и список закрывается: устаревший асинхронный ответ,
   * пришедший после ввода, открыть список не должен.
   */
  function refresh(force: boolean): void {
    const query = input.value;
    const run = ++seq;
    const sources = force
      ? [...opts.sources]
      : opts.sources.filter((source) => matchesWhen(source.when, query));
    if (sources.length === 0) {
      close();
      return;
    }
    void Promise.all(
      sources.map((source) =>
        Promise.resolve()
          .then(() => source.load(query))
          .catch(() => [])
          .then((entries: SuggestEntry[]) => ({ source, entries })),
      ),
    ).then((groups) => {
      if (run !== seq || (!force && !focused) || !input.isConnected) return;
      // Новый набор строк: сбрасываем состояние порций и запоминаем группы
      // как базу для догрузки (задача c8fa74ba).
      lastGroups = groups;
      pageState.clear();
      loadingMore = false;
      for (const group of groups) {
        if (group.source.loadMore === undefined) continue;
        const size = pageSizeOf(group.source);
        pageState.set(group.source, {
          offset: group.entries.length,
          done: group.entries.length === 0 || group.entries.length < size,
        });
      }
      render(groups);
    });
  }

  /**
   * Оконные capture-слушатели снимаются и возвращаются отдельно от слушателей
   * самого поля. Поле может ВРЕМЕННО выпасть из документа — вкладка редактора
   * кэшируется и при показе другой вкладки отключает свою панель
   * (`paneHostEl.replaceChildren`), возвращая тот же узел обратно (ошибка
   * 0a49c206). Полное `dispose()` по `!input.isConnected` убивало живой поиск
   * навсегда: первое же оконное событие после отключения (клик/клавиша в
   * «Комментарии») снимало и слушатели поля, а у возвращённого из кэша узла их
   * уже никто не вешал. Поэтому на отключении снимаем только оконные слушатели
   * (защита от утечки — как для закрытого диалога), а слушатель `focus` самого
   * поля, переживший отключение, возвращает их при повторном фокусе.
   */
  let windowWired = true;
  const wireWindow = (): void => {
    if (windowWired) return;
    windowWired = true;
    window.addEventListener('mousedown', onWinDown, true);
    window.addEventListener('keydown', onWinKey, true);
  };
  const unwireWindow = (): void => {
    if (!windowWired) return;
    windowWired = false;
    window.removeEventListener('mousedown', onWinDown, true);
    window.removeEventListener('keydown', onWinKey, true);
  };

  /** Клик мимо (вне поля и списка) закрывает список. */
  const onWinDown = (event: MouseEvent): void => {
    // Поле выпало из документа (перерисованный редактор, закрытый диалог,
    // отключённая панель кэшированной вкладки) — оконные capture-слушатели
    // снимаем, чтобы они не жили дольше виджета. Слушатели поля остаются: при
    // возврате в документ повторный фокус вернёт оконные (wireWindow).
    if (!input.isConnected) {
      unwireWindow();
      close();
      return;
    }
    if (list === null) return;
    if (event.target === input) return;
    if (event.target !== null && list.contains(event.target as Node)) return;
    close();
  };

  /** Esc: пока список открыт, нажатие принадлежит списку, не диалогу. */
  const onWinKey = (event: KeyboardEvent): void => {
    if (!input.isConnected) {
      unwireWindow();
      close();
      return;
    }
    if (event.key !== 'Escape') return;
    if (list !== null || event.repeat) {
      // Регистрация при подключении ставит этот capture-слушатель раньше
      // диалогового — диалог до события не дойдёт.
      event.stopImmediatePropagation();
      event.preventDefault();
      if (list !== null) close();
    }
  };

  const onFocus = (): void => {
    focused = true;
    // Поле вернулось в документ (панель кэшированной вкладки подключена
    // обратно) — оконные слушатели, снятые при отключении, ставятся снова.
    wireWindow();
    refresh(false);
  };
  const onInput = (): void => {
    refresh(false);
  };
  const onBlur = (): void => {
    focused = false;
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (list === null) return;
    if (event.key === 'Tab') {
      // Tab — не клавиша списка: подсказка закрывается, а фокус уходит дальше
      // обычным порядком диалога. Нажатие НЕ гасим (`preventDefault` отменил бы
      // перемещение фокуса) — именно проглоченный Tab превращал диалог в
      // «молчащий» после выбора из списка (ошибка 797d0485).
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rowEntries.length === 0) return;
      event.preventDefault();
      const next = moveCursor(event.key === 'ArrowDown' ? 1 : -1);
      if (next === null) return;
      cursor = next;
      paint();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey) {
      // Enter (и Ctrl+Enter) выбирает выделенную строку — как и остальные
      // выпадашки клиента; без выделения побеждает первая выбираемая.
      if (rowEntries.length === 0) return;
      const index = cursor ?? (opts.pickFirstOnEnter === false ? null : firstSelectable());
      if (index === null) return;
      const entry = rowEntries[index];
      if (entry === undefined || entry.disabled === true) return;
      event.preventDefault();
      close();
      opts.onPick(entry);
    }
  };

  input.addEventListener('focus', onFocus);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
  window.addEventListener('mousedown', onWinDown, true);
  window.addEventListener('keydown', onWinKey, true);

  const dispose = (): void => {
    close();
    input.removeEventListener('focus', onFocus);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
    unwireWindow();
  };

  return { open: () => refresh(true), close, dispose };
}

/**
 * Стандартный источник «история последних значений»: активен на пустом поле
 * (фокус или очистка), заголовок «Последние значения». Ограничение истории —
 * у переданного `load` (RECENT_VALUES_MAX = 10).
 */
export function historySuggestSource(opts: {
  load: () => SuggestEntry[] | Promise<SuggestEntry[]>;
  header?: string;
}): SuggestSource {
  return {
    when: 'empty',
    header: opts.header ?? 'Последние значения',
    load: () => opts.load(),
  };
}

/** Стандартный источник «живой поиск»: активен после первого символа. */
export function searchSuggestSource(opts: {
  load: (query: string) => SuggestEntry[] | Promise<SuggestEntry[]>;
  header?: string;
}): SuggestSource {
  return { when: 'typed', header: opts.header, load: opts.load };
}

/**
 * Стандартный источник «закрытый список config.options»: активен при вводе,
 * сужается по фрагменту без учёта регистра (то же правило, что у прежнего
 * пикера вариантов); полный список — через `handle.open()` (кнопка ▾).
 *
 * `showAllUntilEdited` (карточка ошибки 4a96d07a) переводит источник в режим
 * свойства с выбором из списка: список открывается сразу при входе в поле
 * (`when: 'always'`) и до первой правки показывается ЦЕЛИКОМ — содержимое
 * поля (текущее значение) запросом не считается. Как только пользователь
 * меняет хотя бы один символ (предикат вернул `false`), источник ведёт себя
 * как обычно — фильтрует список по введённому фрагменту.
 */
export function optionsSuggestSource(
  options: readonly string[],
  opts: { header?: string; showAllUntilEdited?: () => boolean } = {},
): SuggestSource {
  const showAllUntilEdited = opts.showAllUntilEdited;
  return {
    // Поле со списком вариантов открывает его сразу при входе, а не только
    // после первого символа; без предиката поведение прежнее — `typed`.
    when: showAllUntilEdited === undefined ? 'typed' : 'always',
    header: opts.header,
    load: (query) => {
      const fragment = showAllUntilEdited?.() === true ? '' : query.trim().toLowerCase();
      const visible =
        fragment === '' ? options : options.filter((o) => o.toLowerCase().includes(fragment));
      return visible.map((o) => ({ value: o, label: o }));
    },
  };
}
