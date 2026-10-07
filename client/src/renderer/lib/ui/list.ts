/**
 * Общий компонент списка `lib/ui` — клавиатурная навигация обоих списковых
 * представлений клиента (ADR «Списки и таблицы: два компонента над общим ядром
 * навигации» fadf99e0, требование 93115633, задача 7893e429).
 *
 * **Роль.** Список — строка = элемент целиком, допускается группировка (полки,
 * дни). Компонент обслуживает оба нынешних списка клиента — ленту «Дневника»
 * (`screens/chronicle/feed-nav.ts`) и библиотеку «Публикаций»
 * (`screens/publications/library-nav.ts`) — и любой будущий: он не знает ни
 * разметки, ни источников данных. Разметку caller рисует сам инкрементально
 * (`reconcileKeyed`, `keyed-list.ts`) — это и есть keyed-строки; компонент
 * навешивает на неё ПОСЛЕДОВАТЕЛЬНОСТЬ и КЛАВИАТУРУ.
 *
 * **Ядро — `nav-core.ts`.** Все правила (какие клавиши, границы, Home/End,
 * разворот/сворачивание группы, активация, отсечка полей ввода) живут в ядре;
 * компонент связывает их с DOM. Свой обработчик стрелок в экране развёрнутого
 * списка не нужен и запрещён сторожем (`guard-list-nav`).
 *
 * **Адаптер представления** отдаёт компоненту: видимую последовательность
 * сущностей ({@link ListNavAdapter.entries}), их стабильный ключ
 * ({@link ListNavAdapter.tokenOf}, переживает перерисовку), узел и применение
 * выделения; по желанию — прокрутку/фокус и реакции на сворачивание/активацию.
 * Сущность описывается opaque-типом `E`: ядру важен только её ключ.
 *
 * **Устойчивость.** Текущая сущность хранится значением-plus-ключом: после
 * перерисовки {@link ListNavHandle.refresh} ищет её по ключу в новом видимом
 * списке, переприменяет выделение и возвращает фокус, если навигация была
 * активна и пользователь не правит текст. Пропавшая/скрытая сущность снимает
 * выделение (адаптер узнаёт об этом через {@link ListNavAdapter.onSelectionChange}).
 *
 * **Режим полей «Дневника» — расширение ядра.** Клавиши, которых нет в карте
 * ядра (Tab, Escape), представление обрабатывает через
 * {@link ListNavAdapter.onKey}, вызываемый ДО базовых правил: так лента шагает
 * по полям записи и выходит из правки, не заводя второго контроллера.
 *
 * **Пространственный (2D) режим — расширение ядра.** Для сеточных представлений
 * (полки «книжками», задача 432ab7ba п.2) адаптер включает
 * {@link ListNavAdapter.useSpatialNav} и отдаёт прямоугольники сущностей
 * ({@link ListNavAdapter.boxOf}); стрелки ходят по геометрии строк/столбцов
 * (выбор цели — чистое ядро `nav-core.ts::pickSpatialTarget`), Home/End —
 * границы текущей группы, Ctrl+Home/End — первой/последней. Без этого режима
 * поведение не меняется.
 */

import { defineKeyContext, pushKeyContext } from '../keymap.js';
import {
  isEditingTarget as coreIsEditingTarget,
  listTargetIndex,
  nextNavIndex,
  pickSpatialTarget,
  resolveNavAction,
  type NavBox,
} from './nav-core.js';

/** Счётчик списков: у каждого свой контекст сочетаний (замыкание навигации). */
let listContextSeq = 0;

/** Loose view of `KeyboardEvent` fields used by the controller (test-friendly). */
export interface ListNavKeyEvent {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: unknown | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/** Loose view of a click event (real DOM and DOM shim). */
export interface ListNavClickEvent {
  target?: unknown | null;
}

/** Адаптер представления: что ядро видит и чем управляет. */
export interface ListNavAdapter<E> {
  /** Видимая последовательность сущностей в порядке ↑/↓ (свёрнутые группы исключены). */
  entries(): readonly E[];
  /** Стабильный ключ сущности — переживает перерисовку (составной: группа+ключ). */
  tokenOf(entry: E): string;
  /** DOM-узел сущности (для прокрутки/фокуса); `null`, если узел сейчас не в DOM. */
  elementOf(entry: E): HTMLElement | null;
  /** Перерисовать выделение под текущую сущность (снять прежнее, подсветить новую). */
  applyHighlight(entry: E | null): void;
  /**
   * Текущая сущность изменилась (перемещение, клик, сброс после перерисовки).
   * Адаптер синхронизирует свои производные состояния (напр. курсор полей).
   */
  onSelectionChange?(entry: E | null): void;
  /** Подвести узел к видимой области; по умолчанию — `scrollIntoView({block:'nearest'})`. */
  reveal?(entry: E, el: HTMLElement | null): void;
  /** Дать фокус узлу (по умолчанию — сам узел, если фокусируем, иначе корень). */
  focus?(entry: E, el: HTMLElement | null): void;
  /** Отсечка полей ввода (по умолчанию — {@link coreIsEditingTarget}). */
  isEditingTarget?(target: unknown | null): boolean;
  /** ←/→: свернуть (`collapsed: true`) или развернуть текущую группу/сущность. */
  onCollapse?(entry: E, collapsed: boolean): void;
  /** Enter — активация текущей сущности. */
  onActivate?(entry: E): void;
  /**
   * Расширение ядра: обработка клавиши ДО базовых правил (режим полей ленты).
   * Вернула `true` — клавиша обработана, базовые правила не применяются.
   */
  onKey?(key: string, event: ListNavKeyEvent): boolean;
  /** Клик внутри корня; адаптер сам решает, что сделать текущим. */
  onClick?(target: HTMLElement): void;
  /** Клик вне корня (навигация гаснет — перерисовка не тянет фокус назад). */
  onOutsideClick?(): void;
  /**
   * Включена ли ПРОСТРАНСТВЕННАЯ (2D) навигация стрелками. Для сеточных
   * представлений (полки «книжками»): ←/→/↑/↓ перемещают по геометрии
   * (столбцами/строками, как на карте), Home/End — границы текущей группы,
   * Ctrl+Home/End — границы первой/последней группы. Без неё — обычный
   * последовательный ход ↑/↓. Требует {@link ListNavAdapter.boxOf}.
   */
  useSpatialNav?(): boolean;
  /** Прямоугольник сущности в координатах окна — вход 2D-навигации. */
  boxOf?(entry: E): NavBox | null;
  /** Сущность — заголовок группы: на ней ←/→ сворачивают, а не двигают вбок. */
  isGroupHead?(entry: E): boolean;
  /** Ключ группы сущности (полка) — для Home/End «границы группы». */
  groupOf?(entry: E): string | null;
}

/** Настройки компонента списка. */
export interface ListNavOptions<E> {
  /** Смена текущей сущности (для вызывающего, если нужно). */
  onCurrentChange?(entry: E | null): void;
}

/** Настройки установки текущей сущности вне клавиатурного хода. */
export interface ListNavSetOptions {
  /**
   * Взвести навигацию (`navActive = true`) БЕЗ немедленного фокуса: тогда
   * ближайший {@link ListNavHandle.refresh} вернёт фокус (лечение регрессии
   * фокуса после перехода к записи, которой ещё нет в DOM, — ошибка ab78e7b5).
   */
  activate?: boolean;
  /** Подвести узел к видимой области (если он уже в DOM). */
  reveal?: boolean;
  /** Сразу дать фокус узлу (иначе фокус вернёт `refresh`, если навигация взведена). */
  focus?: boolean;
}

/** Публичный дескриптор навигации списка. */
export interface ListNavHandle<E> {
  /** Переприменить выделение/фокус после перерисовки списков. */
  refresh(): void;
  /** Вернуть фокус в навигацию. */
  focusNavigation(): void;
  /** Текущая сущность или `null`. */
  current(): E | null;
  /** Сделать сущность текущей (без прокрутки; узел может быть ещё не в DOM). */
  setCurrent(entry: E | null, options?: ListNavSetOptions): void;
  /** Ключ текущей сущности или `null`. */
  token(): string | null;
  /** Снять слушатели (размонтирование вида). */
  destroy(): void;
}

/** Может ли узел принять программный фокус (иначе фокус ставится на корень). */
function canReceiveFocus(el: HTMLElement): boolean {
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a') {
    return true;
  }
  const tabIndex = el.tabIndex;
  return typeof tabIndex === 'number' && tabIndex >= 0;
}

/**
 * Подключить навигацию списка к корню. `root` — общий контейнер вида
 * (`.chron-feed-wrap`, `.publications` и т. п.).
 */
export function createListNav<E>(
  root: HTMLElement,
  adapter: ListNavAdapter<E>,
  options: ListNavOptions<E> = {},
): ListNavHandle<E> {
  let current: E | null = null;
  /**
   * Навигация «активна»: пользователь уже ходил стрелками либо кликал по
   * списку и не уводил фокус наружу. Нужна, чтобы после перерисовки вернуть
   * фокус, но не украсть его у правки текста или другой панели.
   */
  let navActive = false;
  const ownerDocument = (globalThis as { document?: Document }).document;
  const isEditing = adapter.isEditingTarget ?? coreIsEditingTarget;

  const list = (): readonly E[] => adapter.entries();

  const indexOf = (entries: readonly E[], entry: E | null): number => {
    if (entry === null) return -1;
    const token = adapter.tokenOf(entry);
    return entries.findIndex((candidate) => adapter.tokenOf(candidate) === token);
  };

  /** Фокус на сущности (по умолчанию — узел, если фокусируем, иначе корень). */
  const focusEntry = (entry: E | null, el: HTMLElement | null): void => {
    if (adapter.focus !== undefined) {
      adapter.focus(entry as E, el);
      return;
    }
    if (el !== null && canReceiveFocus(el)) el.focus?.();
    else root.focus?.();
  };

  const revealEntry = (entry: E, el: HTMLElement | null): void => {
    if (adapter.reveal !== undefined) adapter.reveal(entry, el);
    else el?.scrollIntoView?.({ block: 'nearest' });
  };

  const setCurrent = (entry: E | null, opts: ListNavSetOptions = {}): void => {
    current = entry;
    if (opts.activate === true) navActive = true;
    adapter.onSelectionChange?.(entry);
    adapter.applyHighlight(entry);
    if (entry !== null && (opts.reveal === true || opts.focus === true)) {
      const el = adapter.elementOf(entry);
      if (opts.reveal === true) revealEntry(entry, el);
      if (opts.focus === true) focusEntry(entry, el);
    }
    options.onCurrentChange?.(entry);
  };

  const focusNav = (): void => {
    navActive = true;
    const el = current === null ? null : adapter.elementOf(current);
    focusEntry(current, el);
  };

  /** Переместить выделение на `delta` видимых сущностей (границы — без движения). */
  const move = (delta: number): void => {
    const entries = list();
    if (entries.length === 0) {
      setCurrent(null);
      return;
    }
    const target = listTargetIndex(indexOf(entries, current), entries.length, delta);
    if (target < 0) return;
    setCurrent(entries[target] as E, { reveal: true });
  };

  /** Home/End — к первой/последней видимой сущности (расчёт края — в ядре). */
  const moveToEdge = (last: boolean): void => {
    const entries = list();
    const target = nextNavIndex(last ? 'end' : 'home', indexOf(entries, current), entries.length);
    if (target < 0) {
      setCurrent(null);
      return;
    }
    setCurrent(entries[target] as E, { reveal: true });
  };

  /** Пространственный режим включён и адаптер умеет отдавать прямоугольники. */
  const spatial = (): boolean =>
    adapter.boxOf !== undefined && adapter.useSpatialNav?.() === true;

  /** Прямоугольник сущности (null — сущность не видна / нет геометрии). */
  const boxOfEntry = (entry: E): NavBox | null => adapter.boxOf?.(entry) ?? null;

  /**
   * Пространственный шаг: из текущей сущности — ближайшая в направлении
   * `(dx, dy)` по геометрии (выбор — в ядре `pickSpatialTarget`). Без текущей
   * сущности: «вперёд» (вниз/вправо) — первая сущность, «назад» — последняя.
   *
   * Боковое смещение считается ПО ПЕРЕКРЫТИЮ интервалов (`lateral: 'overlap'`,
   * задача e80da89f п.1): заголовок группы во всю ширину не штрафуется боком за
   * колонку, поэтому вертикальный маршрут получается сам —
   * «заголовок → ряд 1 → … → ряд N → заголовок следующей группы»; ↑ с верхнего
   * ряда естественно ведёт на заголовок СВОЕЙ группы.
   *
   * Единственный негеометрический переход — ↑ С ЗАГОЛОВКА: он ведёт к заголовку
   * ПРЕДЫДУЩЕЙ группы (требование e80da89f п.1: заголовки — «столбец» границ
   * групп, и с заголовка вверх ожидается предыдущий заголовок, а не последний
   * ряд предыдущей группы). Вниз с заголовка геометрия сама даёт первую книжку
   * своей группы.
   */
  const moveSpatial = (dx: -1 | 0 | 1, dy: -1 | 0 | 1): void => {
    const entries = list();
    if (entries.length === 0) {
      setCurrent(null);
      return;
    }
    if (current === null) {
      const first = entries[0] as E;
      setCurrent(dy > 0 || dx > 0 ? first : (entries[entries.length - 1] as E), { reveal: true });
      return;
    }
    const isHead = (entry: E): boolean => adapter.isGroupHead?.(entry) === true;
    if (dy < 0 && isHead(current)) {
      const prevHead = previousGroupHead(current);
      if (prevHead !== null) {
        setCurrent(prevHead, { reveal: true });
        return;
      }
    }
    const currentBox = boxOfEntry(current);
    if (currentBox === null) return;
    const boxes = entries
      .map((entry) => ({ entry, box: boxOfEntry(entry) }))
      .filter((item): item is { entry: E; box: NavBox } => item.box !== null);
    const next = pickSpatialTarget(
      boxes.map((item) => ({ ...item.box, entry: item.entry })),
      currentBox,
      dx,
      dy,
      (item) => adapter.tokenOf(item.entry),
      adapter.tokenOf(current),
      { lateral: 'overlap' },
    );
    if (next !== null) setCurrent(next.entry, { reveal: true });
  };

  /**
   * Заголовок ПРЕДЫДУЩЕЙ группы (в порядке видимых групп) — цель ↑ с заголовка.
   * `null` у первой группы (выше заголовков нет).
   */
  const previousGroupHead = (head: E): E | null => {
    const groupOf = (entry: E): string | null => adapter.groupOf?.(entry) ?? null;
    const isHead = (entry: E): boolean => adapter.isGroupHead?.(entry) === true;
    const currentGroup = groupOf(head);
    if (currentGroup === null) return null;
    const groups: string[] = [];
    const all = list();
    for (const entry of all) {
      const key = groupOf(entry);
      if (key !== null && !groups.includes(key)) groups.push(key);
    }
    const index = groups.indexOf(currentGroup);
    if (index <= 0) return null;
    const previous = groups[index - 1]!;
    return all.find((entry) => isHead(entry) && groupOf(entry) === previous) ?? null;
  };

  /**
   * Home/End в пространственном режиме: первая/последняя ПУБЛИКАЦИЯ группы
   * (полки) текущей сущности; `global` (Ctrl+Home/End) — первой/последней
   * группы. Пустая группа отдаёт свой заголовок.
   */
  const moveGroupEdge = (last: boolean, global: boolean): void => {
    const entries = list();
    if (entries.length === 0) {
      setCurrent(null);
      return;
    }
    const groupOf = (entry: E): string | null => adapter.groupOf?.(entry) ?? null;
    const isHead = (entry: E): boolean => adapter.isGroupHead?.(entry) === true;
    const groups: string[] = [];
    for (const entry of entries) {
      const key = groupOf(entry);
      if (key !== null && !groups.includes(key)) groups.push(key);
    }
    if (groups.length === 0) {
      moveToEdge(last);
      return;
    }
    const currentGroup = current === null ? groups[0]! : groupOf(current);
    // Ctrl+Home/Ctrl+End (global) — к первой/последней ГРУППЕ, ГДЕ ЕСТЬ
    // элементы: пустые крайние полки пропускаются (замечание 432ab7ba п.2).
    // Если элементов нет ни в одной группе — прежнее поведение (крайняя
    // группа, т.е. её заголовок).
    let groupKey: string;
    if (global) {
      const withItems = groups.filter((key) =>
        entries.some((entry) => groupOf(entry) === key && !isHead(entry)),
      );
      const pool = withItems.length > 0 ? withItems : groups;
      groupKey = last ? pool[pool.length - 1]! : pool[0]!;
    } else {
      groupKey = currentGroup ?? groups[0]!;
    }
    const inGroup = entries.filter((entry) => groupOf(entry) === groupKey);
    const items = inGroup.filter((entry) => !isHead(entry));
    const target =
      items.length === 0
        ? (inGroup[0] ?? null)
        : (last ? items[items.length - 1]! : items[0]!);
    if (target !== null) setCurrent(target, { reveal: true });
  };

  /** Клавиатурная команда списка; `true` — событие обработано (см. диспетчер). */
  const handleKeyDown = (event: KeyboardEvent): boolean => {
    const key = event.key ?? '';
    const target = (event.target ?? null) as HTMLElement | null;
    // Расширение ядра (режим полей «Дневника»): Tab/Escape и правка текста.
    if (adapter.onKey?.(key, event as unknown as ListNavKeyEvent) === true) {
      navActive = true;
      return true;
    }
    // Поле правки текста: стрелки/Tab/Enter принадлежат редактору.
    if (isEditing(target)) return false;
    // Alt+↑/↓ — сдвиг порядка; навигацию курсора ведёт базовый разбор без Alt.
    const action = resolveNavAction(key, { altKey: event.altKey === true });
    if (action === null) return false;
    navActive = true;
    const useSpatial = spatial();
    const onGroupHead = current !== null && adapter.isGroupHead?.(current) === true;
    switch (action) {
      case 'up':
        if (useSpatial) moveSpatial(0, -1);
        else move(-1);
        return true;
      case 'down':
        if (useSpatial) moveSpatial(0, 1);
        else move(1);
        return true;
      case 'home':
        if (useSpatial) moveGroupEdge(false, event.ctrlKey === true);
        else moveToEdge(false);
        return true;
      case 'end':
        if (useSpatial) moveGroupEdge(true, event.ctrlKey === true);
        else moveToEdge(true);
        return true;
      case 'collapse':
      case 'expand': {
        // В пространственном режиме на КНИЖКЕ ←/→ — перемещение по горизонтали,
        // а сворачивание — только на заголовке группы (спека 1eecd988).
        if (useSpatial && !onGroupHead) {
          moveSpatial(action === 'collapse' ? -1 : 1, 0);
          return true;
        }
        if (current !== null && adapter.onCollapse !== undefined) {
          adapter.onCollapse(current, action === 'collapse');
          return true;
        }
        return false;
      }
      case 'activate':
        if (current !== null && adapter.onActivate !== undefined) {
          adapter.onActivate(current);
          return true;
        }
        return false;
      default:
        // PgUp/PgDn списком не используются.
        return false;
    }
  };

  const onClick = (event: ListNavClickEvent): void => {
    const target = (event.target ?? null) as HTMLElement | null;
    if (target === null) return;
    navActive = true;
    adapter.onClick?.(target);
  };

  /** Клик вне списка гасит навигацию: перерисовка не должна тянуть фокус назад. */
  const onDocumentClick = (event: ListNavClickEvent): void => {
    const target = (event.target ?? null) as HTMLElement | null;
    if (target !== null && root.contains?.(target as never) === true) return;
    navActive = false;
    adapter.onOutsideClick?.();
  };

  // Клавиатура списка — через общеклиентский диспетчер: пока фокус внутри
  // списка, его контекст на вершине стека (ADR b420b08c, задача fd3d84f4).
  const contextId = `ui-list-${(listContextSeq += 1)}`;
  defineKeyContext({
    id: contextId,
    bindings: [
      { command: 'list.up', chord: 'ArrowUp', run: handleKeyDown },
      { command: 'list.down', chord: 'ArrowDown', run: handleKeyDown },
      { command: 'list.left', chord: 'ArrowLeft', run: handleKeyDown },
      { command: 'list.right', chord: 'ArrowRight', run: handleKeyDown },
      { command: 'list.home', chord: 'Home', run: handleKeyDown },
      { command: 'list.end', chord: 'End', run: handleKeyDown },
      { command: 'list.home.global', chord: 'Ctrl+Home', run: handleKeyDown },
      { command: 'list.end.global', chord: 'Ctrl+End', run: handleKeyDown },
      { command: 'list.activate', chord: 'Enter', run: handleKeyDown },
      { command: 'list.activate.ctrl', chord: 'Ctrl+Enter', run: handleKeyDown },
      // Tab/Shift+Tab/Escape — расширение ядра (`adapter.onKey`, режим полей
      // «Дневника» и Ctrl+Enter-Ctrl-расширения потребителей).
      { command: 'list.tab', chord: 'Tab', run: handleKeyDown },
      { command: 'list.tab.prev', chord: 'Shift+Tab', run: handleKeyDown },
      { command: 'list.escape', chord: 'Escape', run: handleKeyDown },
      // Alt+↑/↓ — сдвиг порядка (разбор в адаптере/ядре); гасим без обработки.
      { command: 'list.moveUp', chord: 'Alt+ArrowUp', run: handleKeyDown },
      { command: 'list.moveDown', chord: 'Alt+ArrowDown', run: handleKeyDown },
    ],
  });
  let releaseContext: (() => void) | null = null;
  const onFocusIn = (): void => {
    releaseContext ??= pushKeyContext(contextId);
  };
  const onFocusOut = (): void => {
    releaseContext?.();
    releaseContext = null;
  };
  root.addEventListener('focusin', onFocusIn as EventListener);
  root.addEventListener('focusout', onFocusOut as EventListener);
  root.addEventListener('click', onClick as EventListener);
  ownerDocument?.addEventListener('click', onDocumentClick as EventListener, true);

  return {
    refresh(): void {
      const entries = list();
      if (current !== null && indexOf(entries, current) < 0) {
        setCurrent(null);
      } else {
        adapter.applyHighlight(current);
      }
      const active = (ownerDocument?.activeElement ?? null) as HTMLElement | null;
      if (current !== null && navActive && !isEditing(active)) focusNav();
    },
    focusNavigation(): void {
      focusNav();
    },
    current(): E | null {
      return current;
    },
    setCurrent(entry: E | null, setOptions?: ListNavSetOptions): void {
      setCurrent(entry, setOptions);
    },
    token(): string | null {
      return current === null ? null : adapter.tokenOf(current);
    },
    destroy(): void {
      root.removeEventListener('focusin', onFocusIn as EventListener);
      root.removeEventListener('focusout', onFocusOut as EventListener);
      releaseContext?.();
      releaseContext = null;
      root.removeEventListener('click', onClick as EventListener);
      ownerDocument?.removeEventListener('click', onDocumentClick as EventListener, true);
    },
  };
}
