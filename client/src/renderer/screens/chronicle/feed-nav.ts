/**
 * Клавиатурная навигация ленты «Дневника» — адаптер общего компонента списка
 * `lib/ui/list.ts` к разметке ленты (0.10.1–0.10.2, требования 165323a7;
 * ADR «Списки и таблицы: два компонента над общим ядром навигации» fadf99e0,
 * задача 7893e429).
 *
 * Правил навигации здесь БОЛЬШЕ НЕТ: какие клавиши, границы, Home/End,
 * разворот/сворачивание группы, активация, отсечка полей ввода — в ядре
 * `lib/ui/nav-core.ts`; связывание с DOM и хранение выделения по ключу —
 * в компоненте `lib/ui/list.ts`. Этот модуль — представление: он собирает
 * видимую последовательность из разметки ленты, отдаёт узлы, рисует классы
 * выделения и сообщает экрану о сворачивании/активации. Режим полей записи —
 * расширение ядра (клавиши Tab/Escape в {@link ListNavAdapter.onKey}).
 *
 * Контроллер выделяет «текущую группу дат» и «текущее вхождение записи»,
 * перемещает выделение стрелками вверх/вниз по ВИДИМОМУ порядку (заголовок
 * группы идёт перед своими записями; записи свёрнутой группы пропускаются),
 * сворачивает и разворачивает группы (Enter, «влево»/«вправо»), входит Enter'ом
 * в поля записи и перемещается по ним Tab/Shift+Tab (дата/период → мысли →
 * заголовок → комментарий). Enter на поле выполняет действие поля, Esc/клик вне
 * записи — выход из режима полей.
 *
 * ←/→ сворачивают ТЕЛО записи в двух случаях (0.10.2, задачи 41ed99ab и
 * 9cdede6b): когда запись выделена ЦЕЛИКОМ (режим полей не активен) — рабочий
 * приём «↑/↓ выделить запись, ←/→ свернуть/развернуть, не заходя внутрь»; и,
 * как раньше, когда текущее поле — «заголовок» в просмотре. На прочих полях
 * записи (дата/период, мысли, комментарий) стрелки свёрнутость не трогают.
 *
 * ИДЕНТИЧНОСТЬ ТЕКУЩЕЙ ЗАПИСИ — ПО ВХОЖДЕНИЮ «день + запись» (приёмка №10,
 * задача 197b3b05): длительная запись видна в каждой группе дня, и каждая её
 * копия — отдельная сущность навигации и клика. День вхождения входит в ключ
 * компонента (`tokenOf`); наружу {@link FeedNavHandle.current} отдаёт прежнюю
 * форму `{ kind, key }`.
 *
 * Модуль вынесен отдельно от экрана (`chronicle.ts`) сознательно: он не тянет
 * Electron/сеть и проверяется DOM-тестами на шиме
 * (`tests/chronicle-acceptance-iter9.test.ts`,
 * `tests/chronicle-acceptance-iter10.test.ts`) — интеракционная симуляция
 * keydown/кликов, как требует протокол приёмки.
 */

import { createListNav, type ListNavAdapter } from '../../lib/ui/list.js';
import { RECORD_TITLE_INPUT_CLASS } from './record-groups.js';

/** Класс выделения текущей сущности (группа или запись). */
export const FEED_NAV_CURRENT_CLASS = 'diary-nav-current';
/** Класс выделения текущего элемента внутри записи. */
export const FEED_NAV_ELEMENT_CLASS = 'diary-nav-el';

/** Сущность ленты: заголовок группы дня либо карточка записи. */
export interface FeedEntity {
  kind: 'day' | 'record';
  /** Ключ: локальный день `YYYY-MM-DD` (группа) или id записи. */
  key: string;
}

/** Элемент внутри записи, по которым ходят Tab/Shift+Tab. */
type RecordElementKind = 'date' | 'chips' | 'title' | 'body';

/** Параметры подключения контроллера к ленте. */
export interface FeedNavOptions {
  /** Свернуть (`true`) или развернуть (`false`) группу дня. */
  onSetDayCollapsed: (day: string, collapsed: boolean) => void;
  /**
   * Свернуть/развернуть ТЕЛО записи (0.10.2, задача 41ed99ab). Единица — вхождение
   * «день + id»; `day` — день текущей копии записи.
   */
  onSetRecordCollapsed?: (day: string, id: string, collapsed: boolean) => void;
  /**
   * Вход в правку ЗАГОЛОВКА записи (Enter на поле «заголовок», 0.10.2, задача
   * 41ed99ab). Раньше Enter на заголовке просто фокусировал поле ввода.
   */
  onEditTitle?: (recordId: string, card: HTMLElement) => void;
  /** Вход в правку текста записи (Enter на поле «комментарий»). */
  onEditBody: (recordId: string, card: HTMLElement) => void;
  /** Открыть диалог «Дата/период» (Enter на поле «дата/период»). */
  onEditDates?: (recordId: string, card: HTMLElement) => void;
  /** Открыть выбор мысли для привязки (Enter на поле «мысли»). */
  onAddThought?: (recordId: string, card: HTMLElement) => void;
}

/** Публичный дескриптор контроллера. */
export interface FeedNavHandle {
  /** Переприменить выделение после перерисовки ленты. */
  refresh(): void;
  /** Вернуть фокус в навигацию ленты (после выхода из правки). */
  focusNavigation(): void;
  /** Текущая сущность или `null`, если выделения нет. */
  current(): FeedEntity | null;
  /**
   * Сделать запись текущей (выбранной) по её дню-вхождению и вернуть фокус в
   * ленту. Используется переходом к записи (0.10.1, задача 46057359): запись,
   * найденная строкой поиска, становится «текущей» лентой.
   */
  selectRecord(id: string, day: string): void;
  /** Снять слушатели (размонтирование вида). */
  destroy(): void;
}

/** Родительский узел: реальный DOM (`parentElement`) или DOM-шим (`parent`). */
function parentOf(node: HTMLElement): HTMLElement | null {
  const carrier = node as unknown as {
    parentElement?: HTMLElement | null;
    parent?: HTMLElement | null;
  };
  return carrier.parentElement ?? carrier.parent ?? null;
}

/** Ближайший предок (включая сам узел) с классом `className`. */
function closestWithClass(node: HTMLElement | null, className: string): HTMLElement | null {
  let current = node;
  while (current !== null) {
    if (current.classList?.contains(className) === true) return current;
    current = parentOf(current);
  }
  return null;
}

/** Ближайший предок (включая сам узел), удовлетворяющий предикату. */
function closestWith(
  node: HTMLElement | null,
  predicate: (el: HTMLElement) => boolean,
): HTMLElement | null {
  let current = node;
  while (current !== null) {
    if (predicate(current)) return current;
    current = parentOf(current);
  }
  return null;
}

/** Текст/значение атрибута `contenteditable` (реальный DOM и шим). */
function isContentEditable(el: HTMLElement): boolean {
  const carrier = el as unknown as { isContentEditable?: boolean };
  if (carrier.isContentEditable === true) return true;
  if (el.getAttribute?.('contenteditable') !== null && el.getAttribute?.('contenteditable') !== undefined) {
    return true;
  }
  return el.classList?.contains('cm-content') === true || el.classList?.contains('cm-editor') === true;
}

/**
 * Фокус в поле правки текста (заголовок/комментарий)? Тогда навигация ленты
 * обязана молчать: стрелки, Tab и Enter принадлежат редактору. Расширяет
 * общее правило ядра (`nav-core.isEditingTarget`) классами CM6-редактора.
 */
function isEditingTarget(target: HTMLElement | null): boolean {
  if (target === null) return false;
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return closestWith(target, isContentEditable) !== null;
}

/** Класс корня прокрутки ленты «Дневника» (`chronicle.ts` → `feedWrap`). */
const FEED_WRAP_CLASS = 'chron-feed-wrap';
/** Классы редактора записи: обёртка поля комментария и её CM6-редактор. */
const FEED_EDITOR_CLASSES = ['md-field', 'cm-editor'] as const;

/**
 * Клавиша адресована редактору ЗАПИСИ внутри ленты? Глобальный шорткат
 * применения отбора (Ctrl+Enter, `filter-panel.ts`) в этом случае обязан
 * молчать: комбинацию уже обработал внутренний редактор записи (коммит правки,
 * M10) — ошибка f5809943. Панель отбора (`.chron-filter-area`) под этот гард НЕ
 * подпадает: Ctrl+Enter в её полях по-прежнему применяет отбор (спека «Горячие
 * клавиши», 50bb672a).
 */
export function isFeedRecordEditorTarget(target: HTMLElement | null): boolean {
  if (target === null) return false;
  // Редактор комментария записи (`.md-field` и вложенный CM6 `.cm-editor`).
  for (const cls of FEED_EDITOR_CLASSES) {
    if (closestWithClass(target, cls) !== null) return true;
  }
  // Любое поле правки ВНУТРИ ленты (поле заголовка записи).
  if (closestWithClass(target, FEED_WRAP_CLASS) === null) return false;
  return isEditingTarget(target);
}

/** Сущность видимого списка: сама сущность, её DOM-узел и группа дня. */
interface FeedEntry {
  entity: FeedEntity;
  /** День группы (для вхождения записи — часть ключа; для группы — её день). */
  day: string;
  /** DOM-узел сущности; `null`, если узел сейчас не в ленте. */
  el: HTMLElement | null;
}

/** Подключить контроллер навигации к контейнеру ленты. */
export function attachFeedNav(root: HTMLElement, opts: FeedNavOptions): FeedNavHandle {
  /** Текущая сущность (зеркало состояния компонента списка). */
  let current: FeedEntity | null = null;
  /** День текущего вхождения записи (для группы — `null`). */
  let currentDay: string | null = null;
  /** Индекс текущего поля внутри записи (-1 — режим полей не активен). */
  let elementCursor = -1;

  /** Секции дней ленты в DOM-порядке. */
  function daySections(): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('.diary-day'));
  }

  /** Секция дня по ключу (`null` — дня нет в ленте). */
  function findSection(day: string): HTMLElement | null {
    return (
      daySections().find(
        (section) => (section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '') === day,
      ) ?? null
    );
  }

  /** Карточки записей секции (только настоящие записи — со своим `data-row-key`). */
  function recordsOf(section: HTMLElement): HTMLElement[] {
    return Array.from(section.querySelectorAll<HTMLElement>('.diary-record')).filter(
      (card) => (card.getAttribute?.('data-row-key') ?? '') !== '',
    );
  }

  /** Видимые сущности в порядке: заголовок дня, затем его несвёрнутые записи. */
  function visibleEntities(): FeedEntry[] {
    const out: FeedEntry[] = [];
    for (const section of daySections()) {
      const day = section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '';
      if (day === '') continue;
      const collapsed = section.classList.contains('is-collapsed');
      const head = section.querySelector<HTMLElement>('.diary-day-head');
      if (head !== null) out.push({ entity: { kind: 'day', key: day }, day, el: head });
      if (collapsed) continue;
      for (const card of recordsOf(section)) {
        const key = card.getAttribute?.('data-row-key') ?? '';
        if (key === '') continue;
        out.push({ entity: { kind: 'record', key }, day, el: card });
      }
    }
    return out;
  }

  /** Ключ сущности: вхождение «день + запись» различимо, группы — по дню. */
  function tokenOf(entry: FeedEntry): string {
    const dayPart = entry.entity.kind === 'record' ? entry.day : '';
    return `${entry.entity.kind}\u0000${dayPart}\u0000${entry.entity.key}`;
  }

  /** Элемент DOM текущей сущности (null — сущность не видна). */
  function findEntityEl(entity: FeedEntity | null, day: string | null): HTMLElement | null {
    if (entity === null) return null;
    const wanted = tokenOf({ entity, day: day ?? '', el: null });
    const found = visibleEntities().find((item) => tokenOf(item) === wanted);
    return found?.el ?? null;
  }

  /** Карточка конкретного вхождения записи (день + id). */
  function findCardIn(day: string | null, id: string): HTMLElement | null {
    if (day !== null) {
      const section = findSection(day);
      if (section === null) return null;
      return (
        recordsOf(section).find(
          (card) => (card.getAttribute?.('data-row-key') ?? '') === id,
        ) ?? null
      );
    }
    // Резерв без дня-вхождения: первая карточка с таким id.
    return (
      Array.from(root.querySelectorAll<HTMLElement>('.diary-record')).find(
        (card) => (card.getAttribute?.('data-row-key') ?? '') === id,
      ) ?? null
    );
  }

  /** Элементы записи в порядке обхода Tab'ом. */
  function recordElements(card: HTMLElement): Array<{ kind: RecordElementKind; el: HTMLElement }> {
    const date = card.querySelector<HTMLElement>('.diary-record-date');
    // Фокусируемый узел поля «мысли» — сама кнопка «+ мысль» (требование
    // 165323a7; ошибка 02b4d513: Tab выделял пустую область-контейнер перед
    // кнопкой). Контейнер `.diary-record-chips` оставлен запасным путём.
    const chips =
      card.querySelector<HTMLElement>('.diary-chip-add') ??
      card.querySelector<HTMLElement>('.diary-record-chips');
    const title = card.querySelector<HTMLElement>('.diary-record-title');
    const body = card.querySelector<HTMLElement>('.diary-record-body');
    const out: Array<{ kind: RecordElementKind; el: HTMLElement }> = [];
    if (date !== null) out.push({ kind: 'date', el: date });
    if (chips !== null) out.push({ kind: 'chips', el: chips });
    if (title !== null) out.push({ kind: 'title', el: title });
    // Поле «комментарий» доступно ТОЛЬКО при развёрнутой группе заголовка
    // (0.10.2, задача 41ed99ab): в свёрнутой записи тело скрыто и Tab с
    // заголовка уходит на «дата/период».
    if (body !== null && !card.classList.contains('is-collapsed')) {
      out.push({ kind: 'body', el: body });
    }
    return out;
  }

  /** Снять выделение со всех сущностей и элементов записи. */
  function clearHighlight(): void {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${FEED_NAV_CURRENT_CLASS}`))) {
      el.classList.remove(FEED_NAV_CURRENT_CLASS);
    }
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${FEED_NAV_ELEMENT_CLASS}`))) {
      el.classList.remove(FEED_NAV_ELEMENT_CLASS);
    }
  }

  /** Перерисовать выделение по текущему состоянию. */
  function renderHighlight(): void {
    clearHighlight();
    const el = findEntityEl(current, currentDay);
    if (el === null) return;
    el.classList.add(FEED_NAV_CURRENT_CLASS);
    if (current?.kind === 'record' && elementCursor >= 0) {
      const elements = recordElements(el);
      const target = elements[elementCursor];
      if (target !== undefined) target.el.classList.add(FEED_NAV_ELEMENT_CLASS);
    }
  }

  /** Свернуть/развернуть группу относительно её текущего состояния. */
  function setDayCollapsed(day: string, collapsed: boolean): void {
    if (findSection(day) === null) return;
    opts.onSetDayCollapsed(day, collapsed);
  }

  /**
   * Свернуть/развернуть ТЕЛО текущей записи (0.10.2, задача 41ed99ab).
   * Переключение — на месте: экран скрывает тело, не пересобирая ленту, поэтому
   * фокус и выделение остаются на заголовке — после переключения возвращаем
   * фокус туда (требование «свёрнутая запись снова разворачивается»).
   */
  function toggleRecordCollapsed(collapsed: boolean): void {
    if (current?.kind !== 'record' || currentDay === null) return;
    const id = current.key;
    opts.onSetRecordCollapsed?.(currentDay, id, collapsed);
    renderHighlight();
    const card = findCardIn(currentDay, id);
    const title = card?.querySelector<HTMLElement>('.diary-record-title') ?? null;
    (title ?? card)?.focus?.();
  }

  /** Текущее поле записи (null — режим полей не активен или поле исчезло). */
  function currentField(): { card: HTMLElement; kind: RecordElementKind } | null {
    if (current === null || current.kind !== 'record' || elementCursor < 0) return null;
    const card = findCardIn(currentDay, current.key);
    if (card === null) return null;
    const target = recordElements(card)[elementCursor];
    if (target === undefined) return null;
    return { card, kind: target.kind };
  }

  /** Переместить выделение по полям записи (Tab вперёд, Shift+Tab назад). */
  function moveField(delta: number): void {
    if (current === null || current.kind !== 'record') return;
    const card = findCardIn(currentDay, current.key);
    if (card === null) return;
    const elements = recordElements(card);
    if (elements.length === 0) return;
    if (elementCursor < 0) elementCursor = delta > 0 ? 0 : elements.length - 1;
    else elementCursor = (elementCursor + delta + elements.length) % elements.length;
    renderHighlight();
  }

  /** Выход из режима полей: запись снова «единая строка», выделение записи цело. */
  function exitFieldMode(): void {
    if (current?.kind !== 'record' || elementCursor < 0) return;
    elementCursor = -1;
    renderHighlight();
  }

  /** Enter на текущем поле — действие поля. */
  function activateField(): void {
    const field = currentField();
    if (field === null || current === null) return;
    switch (field.kind) {
      case 'date':
        opts.onEditDates?.(current.key, field.card);
        break;
      case 'chips':
        opts.onAddThought?.(current.key, field.card);
        break;
      case 'title': {
        opts.onEditTitle?.(current.key, field.card);
        break;
      }
      case 'body':
        opts.onEditBody(current.key, field.card);
        break;
    }
  }

  /**
   * Реагируют ли ←/→ на текущую ЗАПИСЬ (0.10.2, задача 9cdede6b)? Сворачивание
   * тела доступно, когда режим полей НЕ активен — запись выделена целиком
   * (`field === null`), — а также, по прежней редакции (задача 41ed99ab), когда
   * текущее поле — «заголовок» в просмотре. На прочих полях записи
   * (дата/период, мысли, комментарий) стрелки свёрнутость не трогают.
   */
  function arrowsToggleRecord(field: { kind: RecordElementKind } | null): boolean {
    if (current?.kind !== 'record' || currentDay === null) return false;
    return field === null || field.kind === 'title';
  }

  /** Выход из правки по Esc: снять фокус и вернуть его в навигацию. */
  function exitEditing(target: HTMLElement): void {
    (target as unknown as { blur?: () => void }).blur?.();
    handle.focusNavigation();
  }

  const nav = createListNav<FeedEntry>(root, {
    entries: () => visibleEntities(),
    tokenOf,
    elementOf: (entry) => findEntityEl(entry.entity, entry.entity.kind === 'record' ? entry.day : null),
    applyHighlight: () => renderHighlight(),
    onSelectionChange: (entry) => {
      current = entry?.entity ?? null;
      currentDay = entry !== null && entry.entity.kind === 'record' ? entry.day : null;
      elementCursor = -1;
    },
    isEditingTarget: (target) => isEditingTarget(target as HTMLElement | null),
    onCollapse: (entry, collapsed) => {
      if (entry.entity.kind === 'day') {
        setDayCollapsed(entry.entity.key, collapsed);
        return;
      }
      const field = currentField();
      if (arrowsToggleRecord(field)) toggleRecordCollapsed(collapsed);
    },
    onActivate: (entry) => {
      if (entry.entity.kind === 'day') {
        const section = findSection(entry.entity.key);
        const collapsed = section?.classList.contains('is-collapsed') ?? false;
        opts.onSetDayCollapsed(entry.entity.key, !collapsed);
        return;
      }
      const card = findCardIn(entry.day, entry.entity.key);
      if (card === null) return;
      if (elementCursor < 0) {
        // Вход в режим полей: первое поле — дата/период.
        elementCursor = 0;
        renderHighlight();
        return;
      }
      activateField();
    },
    onKey: (key, event) => {
      const target = (event.target ?? null) as HTMLElement | null;
      if (isEditingTarget(target)) {
        // Правка текста: стрелки/Tab/Enter — редактору; Esc — выход и возврат фокуса.
        if (key === 'Escape' && target !== null) {
          // Поле заголовка единой правки записи: Esc принадлежит её диспетчеру
          // (откат ЗАГОЛОВКА и ТЕЛА). Не перехватываем — пропускаем событие к
          // контексту заголовка ниже по стеку (иначе Esc лишь снимал бы фокус и
          // правка не откатывалась, дефект c0cd113a).
          if (closestWithClass(target, RECORD_TITLE_INPUT_CLASS) !== null) return false;
          exitEditing(target);
          return true;
        }
        return false;
      }
      // Tab/Shift+Tab ходят по полям только в режиме полей: вне его — обычная
      // навигация фокуса браузера.
      if (key === 'Tab' && current?.kind === 'record' && elementCursor >= 0) {
        event.preventDefault?.();
        moveField(event.shiftKey === true ? -1 : 1);
        return true;
      }
      if (key === 'Escape' && current?.kind === 'record' && elementCursor >= 0) {
        event.preventDefault?.();
        exitFieldMode();
        return true;
      }
      return false;
    },
    onClick: (target) => {
      const card = closestWithClass(target, 'diary-record');
      const section = closestWithClass(target, 'diary-day');
      const day =
        section === null
          ? ''
          : (section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '');
      if (card !== null && (card.getAttribute?.('data-row-key') ?? '') !== '' && day !== '') {
        const key = card.getAttribute('data-row-key') ?? '';
        // Клик внутри ТЕКУЩЕЙ записи (по её полям, чипсам, кнопкам) режим полей не
        // сбрасывает: выделение записи и текущего поля сохраняются.
        if (current?.kind === 'record' && current.key === key && currentDay === day) return;
        nav.setCurrent({ entity: { kind: 'record', key }, day, el: card });
        return;
      }
      if (section !== null && day !== '') {
        nav.setCurrent({ entity: { kind: 'day', key: day }, day, el: null });
        return;
      }
      // Клик внутри ленты, но вне записи/группы — выход из режима полей.
      exitFieldMode();
    },
    onOutsideClick: () => {
      // Клик вне ленты (календарь, панель отбора) — выход из режима полей.
      exitFieldMode();
    },
  } satisfies ListNavAdapter<FeedEntry>);

  // `handle` объявлен после `nav` (нужен для взаимной ссылки в `exitEditing`).
  const handle: FeedNavHandle = {
    refresh(): void {
      nav.refresh();
    },
    focusNavigation(): void {
      nav.focusNavigation();
    },
    current(): FeedEntity | null {
      return current;
    },
    selectRecord(id: string, day: string): void {
      // Навигацию ВЗВОДИМ БЕЗ немедленного фокуса (`activate`): если карточка ещё
      // не в DOM (переход догружает страницы), ближайший `refresh` вернёт фокус —
      // иначе клавиатура после перехода «отваливается» (ошибка ab78e7b5).
      nav.setCurrent(
        { entity: { kind: 'record', key: id }, day, el: findCardIn(day, id) },
        { activate: true },
      );
      if (findCardIn(day, id) !== null) nav.focusNavigation();
    },
    destroy(): void {
      nav.destroy();
    },
  };
  return handle;
}
