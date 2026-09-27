/**
 * Клавиатурная навигация ленты «Дневника» (0.10.1, итерации приёмки №9–№10,
 * требование 165323a7; элемент «Лента дневных записей» e01f383a).
 *
 * Контроллер выделяет «текущую группу дат» и «текущее вхождение записи»,
 * перемещает выделение стрелками вверх/вниз по ВИДИМОМУ порядку (заголовок
 * группы идёт перед своими записями; записи свёрнутой группы пропускаются),
 * сворачивает и разворачивает группы (Enter, «влево»/«вправо»), входит Enter'ом
 * в поля записи и перемещается по ним Tab/Shift+Tab (дата/период → мысли →
 * заголовок → комментарий). Enter на поле выполняет действие поля, Esc/клик вне
 * записи — выход из режима полей.
 *
 * ИДЕНТИЧНОСТЬ ТЕКУЩЕЙ ЗАПИСИ — ПО ВХОЖДЕНИЮ «день + запись» (приёмка №10,
 * задача 197b3b05): длительная запись видна в каждой группе дня, и каждая её
 * копия — отдельная сущность навигации и клика. Номер дня хранится рядом с
 * ключом-записью (`currentDay`); наружу {@link FeedNavHandle.current} отдаёт
 * прежнюю форму `{ kind, key }`.
 *
 * Модуль вынесен отдельно от экрана (`chronicle.ts`) сознательно: он не тянет
 * Electron/сеть и проверяется DOM-тестами на шиме
 * (`tests/chronicle-acceptance-iter9.test.ts`,
 * `tests/chronicle-acceptance-iter10.test.ts`) — интеракционная симуляция
 * keydown/кликов, как требует протокол приёмки.
 *
 * Режим правки текста: пока фокус в поле ввода/редакторе (заголовок,
 * комментарий), стрелки, Tab и Enter работают как редактирование — навигация
 * ленты НЕ срабатывает (прямое требование пользователя). Выход из правки — Esc
 * (обрабатывается здесь для полей ввода) или клик вне; фокус возвращается в
 * навигацию ленты, выделение записи и текущего поля сохраняются.
 *
 * Выделение хранится КЛЮЧОМ сущности (день группы либо вхождение «день+запись»),
 * а не ссылкой на узел: после перерисовки ленты (real-time, дозагрузка «+50»,
 * локальная вставка) {@link FeedNavHandle.refresh} переприменяет выделение, если
 * сущность ещё видима, и сбрасывает его, если она пропала/скрыта.
 */

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
 * обязана молчать: стрелки, Tab и Enter принадлежат редактору.
 */
function isEditingTarget(target: HTMLElement | null): boolean {
  if (target === null) return false;
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return closestWith(target, isContentEditable) !== null;
}

/**
 * Может ли узел принять программный фокус. Реальный `div` без `tabindex` — нет
 * (тогда фокус ставится на контейнер ленты), а кнопка/поле — да.
 */
function canReceiveFocus(el: HTMLElement): boolean {
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a') {
    return true;
  }
  const tabIndex = el.tabIndex;
  return typeof tabIndex === 'number' && tabIndex >= 0;
}

/** Loose view of `KeyboardEvent` fields used by the handler (test-friendly). */
interface FeedKeyEvent {
  key?: string;
  shiftKey?: boolean;
  target?: unknown | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/** Запись видимого списка: сущность, её DOM-узел и группа дня. */
interface VisibleEntity {
  entity: FeedEntity;
  el: HTMLElement;
  /** Локальный день группы (для вхождения записи — ключ вхождения). */
  day: string;
}

/** Подключить контроллер навигации к контейнеру ленты. */
export function attachFeedNav(root: HTMLElement, opts: FeedNavOptions): FeedNavHandle {
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
  function visibleEntities(): VisibleEntity[] {
    const out: VisibleEntity[] = [];
    for (const section of daySections()) {
      const day = section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '';
      if (day === '') continue;
      const collapsed = section.classList.contains('is-collapsed');
      const head = section.querySelector<HTMLElement>('.diary-day-head');
      if (head !== null) out.push({ entity: { kind: 'day', key: day }, el: head, day });
      if (collapsed) continue;
      for (const card of recordsOf(section)) {
        const key = card.getAttribute?.('data-row-key') ?? '';
        if (key === '') continue;
        out.push({ entity: { kind: 'record', key }, el: card, day });
      }
    }
    return out;
  }

  /**
   * Совпадает ли сущность списка с искомой. Для записи дополнительно сверяется
   * день-вхождение: копии одной записи в разных днях неразличимы по id.
   */
  function matches(entity: FeedEntity, day: string | null, item: VisibleEntity): boolean {
    if (item.entity.kind !== entity.kind || item.entity.key !== entity.key) return false;
    if (entity.kind === 'record') return day === item.day;
    return true;
  }

  /** Индекс сущности в видимом списке (-1 — не видна). */
  function indexOfEntity(entity: FeedEntity | null, day: string | null): number {
    if (entity === null) return -1;
    return visibleEntities().findIndex((item) => matches(entity, day, item));
  }

  /** Элемент DOM текущей сущности (null — сущность не видна). */
  function findEntityEl(entity: FeedEntity | null, day: string | null): HTMLElement | null {
    if (entity === null) return null;
    const found = visibleEntities().find((item) => matches(entity, day, item));
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
    const chips = card.querySelector<HTMLElement>('.diary-record-chips');
    const title = card.querySelector<HTMLElement>('.diary-record-title');
    const body = card.querySelector<HTMLElement>('.diary-record-body');
    const out: Array<{ kind: RecordElementKind; el: HTMLElement }> = [];
    if (date !== null) out.push({ kind: 'date', el: date });
    if (chips !== null) out.push({ kind: 'chips', el: chips });
    if (title !== null) out.push({ kind: 'title', el: title });
    if (body !== null) out.push({ kind: 'body', el: body });
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
  function applyHighlight(): void {
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

  /** Сделать сущность текущей; `day` — день-вхождение записи. */
  function setCurrent(entity: FeedEntity | null, day: string | null = null): void {
    current = entity;
    currentDay = entity !== null && entity.kind === 'record' ? day : null;
    elementCursor = -1;
    applyHighlight();
  }

  /** Фокус на элементе навигации (иначе — на контейнере ленты). */
  function focusNav(): void {
    const el = findEntityEl(current, currentDay);
    const candidate = el !== null && canReceiveFocus(el) ? el : root;
    candidate.focus?.();
  }

  /** Переместить выделение на `delta` видимых сущностей. */
  function move(delta: number): void {
    const list = visibleEntities();
    if (list.length === 0) {
      setCurrent(null);
      return;
    }
    const index = indexOfEntity(current, currentDay);
    let next: number;
    if (index < 0) next = delta > 0 ? 0 : list.length - 1;
    else next = index + delta;
    if (next < 0 || next >= list.length) return; // граница ленты — ничего не меняем
    const item = list[next]!;
    setCurrent(item.entity, item.day);
    item.el.scrollIntoView?.({ block: 'nearest' });
  }

  /** Свернуть/развернуть группу относительно её текущего состояния. */
  function setDayCollapsed(day: string, collapsed: boolean): void {
    if (findSection(day) === null) return;
    opts.onSetDayCollapsed(day, collapsed);
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
    applyHighlight();
  }

  /** Выход из режима полей: запись снова «единая строка», выделение записи цело. */
  function exitFieldMode(): void {
    if (current?.kind !== 'record' || elementCursor < 0) return;
    elementCursor = -1;
    applyHighlight();
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
        const title = field.card.querySelector<HTMLElement>('.diary-record-title');
        title?.focus?.();
        break;
      }
      case 'body':
        opts.onEditBody(current.key, field.card);
        break;
    }
  }

  /** Enter на текущей сущности: группа — свернуть/развернуть; запись — поля. */
  function handleEnter(): void {
    if (current === null) return;
    if (current.kind === 'day') {
      const section = findSection(current.key);
      const collapsed = section?.classList.contains('is-collapsed') ?? false;
      opts.onSetDayCollapsed(current.key, !collapsed);
      return;
    }
    const card = findCardIn(currentDay, current.key);
    if (card === null) return;
    if (elementCursor < 0) {
      // Вход в режим полей: первое поле — дата/период.
      elementCursor = 0;
      applyHighlight();
      return;
    }
    activateField();
  }

  /** Выход из правки по Esc: снять фокус и вернуть его в навигацию. */
  function exitEditing(target: HTMLElement): void {
    (target as unknown as { blur?: () => void }).blur?.();
    focusNav();
  }

  function onKeyDown(event: FeedKeyEvent): void {
    const key = event.key ?? '';
    const target = (event.target ?? null) as HTMLElement | null;
    if (isEditingTarget(target)) {
      // Правка текста: стрелки/Tab/Enter — редактору; Esc — выход и возврат фокуса.
      if (key === 'Escape' && target !== null) exitEditing(target);
      return;
    }
    switch (key) {
      case 'ArrowDown':
        event.preventDefault?.();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault?.();
        move(-1);
        break;
      case 'ArrowLeft':
        if (current?.kind === 'day') {
          event.preventDefault?.();
          setDayCollapsed(current.key, true);
        }
        break;
      case 'ArrowRight':
        if (current?.kind === 'day') {
          event.preventDefault?.();
          setDayCollapsed(current.key, false);
        }
        break;
      case 'Tab':
        // Tab/Shift+Tab ходят по полям только в режиме полей: вне его — обычная
        // навигация фокуса браузера.
        if (current?.kind === 'record' && elementCursor >= 0) {
          event.preventDefault?.();
          moveField(event.shiftKey === true ? -1 : 1);
        }
        break;
      case 'Enter':
        event.preventDefault?.();
        handleEnter();
        break;
      case 'Escape':
        if (current?.kind === 'record' && elementCursor >= 0) {
          event.preventDefault?.();
          exitFieldMode();
        }
        break;
      default:
        break;
    }
  }

  function onClick(event: { target?: unknown | null }): void {
    const target = (event.target ?? null) as HTMLElement | null;
    if (target === null) return;
    const card = closestWithClass(target, 'diary-record');
    const section = closestWithClass(target, 'diary-day');
    const day =
      section === null
        ? ''
        : (section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '');
    if (card !== null && (card.getAttribute?.('data-row-key') ?? '') !== '' && day !== '') {
      if (target.classList?.contains('diary-slot')) return;
      setCurrent({ kind: 'record', key: card.getAttribute('data-row-key') ?? '' }, day);
      return;
    }
    if (section !== null && day !== '') {
      setCurrent({ kind: 'day', key: day });
      return;
    }
    // Клик вне записи/группы — выход из режима полей.
    exitFieldMode();
  }

  root.addEventListener('keydown', onKeyDown as EventListener);
  root.addEventListener('click', onClick as EventListener);

  return {
    refresh(): void {
      if (current !== null && indexOfEntity(current, currentDay) < 0) {
        current = null;
        currentDay = null;
        elementCursor = -1;
      }
      applyHighlight();
    },
    focusNavigation(): void {
      focusNav();
    },
    current(): FeedEntity | null {
      return current;
    },
    destroy(): void {
      root.removeEventListener('keydown', onKeyDown as EventListener);
      root.removeEventListener('click', onClick as EventListener);
    },
  };
}
