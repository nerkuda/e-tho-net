/**
 * Клавиатурная навигация ленты «Дневника» (0.10.1, итерация приёмки №9,
 * требование 165323a7; элемент «Лента дневных записей» e01f383a).
 *
 * Контроллер выделяет «текущую группу дат» и «текущую запись», перемещает
 * выделение стрелками вверх/вниз по ВИДИМОМУ порядку (заголовок группы идёт
 * перед своими записями; записи свёрнутой группы пропускаются), сворачивает и
 * разворачивает группы (Enter, «влево»/«вправо») и шагает Enter'ом по элементам
 * записи (дата/период → мысли → заголовок → комментарий).
 *
 * Модуль вынесен отдельно от экрана (`chronicle.ts`) сознательно: он не тянет
 * Electron/сеть и проверяется DOM-тестами на шиме
 * (`tests/chronicle-acceptance-iter9.test.ts`) — интеракционная симуляция
 * keydown/кликов, как требует протокол приёмки.
 *
 * Режим правки текста: пока фокус в поле ввода/редакторе (заголовок,
 * комментарий), стрелки и Enter работают как редактирование — навигация ленты
 * НЕ срабатывает (прямое требование пользователя). Выход из правки — Esc
 * (обрабатывается здесь для полей ввода) или клик вне; фокус возвращается в
 * навигацию ленты.
 *
 * Выделение хранится КЛЮЧОМ сущности (день или id записи), а не ссылкой на
 * узел: после перерисовки ленты (real-time, дозагрузка «+50», локальная
 * вставка) {@link FeedNavHandle.refresh} переприменяет выделение, если сущность
 * ещё видима, и сбрасывает его, если она пропала/скрыта.
 */

/** Класс выделения текущей сущности (группа или запись). */
export const FEED_NAV_CURRENT_CLASS = 'diary-nav-current';
/** Класс выделения текущего элемента внутри записи. */
export const FEED_NAV_ELEMENT_CLASS = 'diary-nav-el';

/** Сущность ленты: заголовок группы дня либо карточка записи. */
export interface FeedEntity {
  kind: 'day' | 'record';
  /** Ключ: локальный день `YYYY-MM-DD` (для группы) или id записи. */
  key: string;
}

/** Элемент внутри записи, по которым шагает Enter. */
type RecordElementKind = 'date' | 'chips' | 'title' | 'body';

/** Параметры подключения контроллера к ленте. */
export interface FeedNavOptions {
  /** Свернуть (`true`) или развернуть (`false`) группу дня. */
  onSetDayCollapsed: (day: string, collapsed: boolean) => void;
  /** Вход в правку текста записи (Enter на элементе «комментарий»). */
  onEditBody: (recordId: string, card: HTMLElement) => void;
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
 * обязана молчать: стрелки и Enter принадлежат редактору.
 */
function isEditingTarget(target: HTMLElement | null): boolean {
  if (target === null) return false;
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return closestWith(target, isContentEditable) !== null;
}

/** Loose view of `KeyboardEvent` fields used by the handler (test-friendly). */
interface FeedKeyEvent {
  key?: string;
  target?: unknown | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/** Подключить контроллер навигации к контейнеру ленты. */
export function attachFeedNav(root: HTMLElement, opts: FeedNavOptions): FeedNavHandle {
  let current: FeedEntity | null = null;
  /** Индекс текущего элемента внутри записи (-1 — элемент не выбран). */
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
  function visibleEntities(): Array<{ entity: FeedEntity; el: HTMLElement }> {
    const out: Array<{ entity: FeedEntity; el: HTMLElement }> = [];
    for (const section of daySections()) {
      const day = section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '';
      if (day === '') continue;
      const collapsed = section.classList.contains('is-collapsed');
      const head = section.querySelector<HTMLElement>('.diary-day-head');
      if (head !== null) out.push({ entity: { kind: 'day', key: day }, el: head });
      if (collapsed) continue;
      for (const card of recordsOf(section)) {
        const key = card.getAttribute?.('data-row-key') ?? '';
        if (key === '') continue;
        out.push({ entity: { kind: 'record', key }, el: card });
      }
    }
    return out;
  }

  /** Индекс сущности в видимом списке (-1 — не видна). */
  function indexOfEntity(entity: FeedEntity | null): number {
    if (entity === null) return -1;
    return visibleEntities().findIndex(
      (item) => item.entity.kind === entity.kind && item.entity.key === entity.key,
    );
  }

  /** Элемент DOM текущей сущности (null — сущность не видна). */
  function findEntityEl(entity: FeedEntity | null): HTMLElement | null {
    if (entity === null) return null;
    const found = visibleEntities().find(
      (item) => item.entity.kind === entity.kind && item.entity.key === entity.key,
    );
    return found?.el ?? null;
  }

  /** Карточка записи по id. */
  function findCard(id: string): HTMLElement | null {
    return (
      Array.from(root.querySelectorAll<HTMLElement>('.diary-record')).find(
        (card) => (card.getAttribute?.('data-row-key') ?? '') === id,
      ) ?? null
    );
  }

  /** Элементы записи в порядке обхода Enter'ом. */
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
    const el = findEntityEl(current);
    if (el === null) return;
    el.classList.add(FEED_NAV_CURRENT_CLASS);
    if (current?.kind === 'record' && elementCursor >= 0) {
      const elements = recordElements(el);
      const target = elements[elementCursor];
      if (target !== undefined) target.el.classList.add(FEED_NAV_ELEMENT_CLASS);
    }
  }

  /** Сделать сущность текущей. */
  function setCurrent(entity: FeedEntity | null): void {
    current = entity;
    elementCursor = -1;
    applyHighlight();
  }

  /** Фокус на элементе навигации (если он умеет фокус). */
  function focusNav(): void {
    const el = findEntityEl(current);
    (el ?? root).focus?.();
  }

  /** Переместить выделение на `delta` видимых сущностей. */
  function move(delta: number): void {
    const list = visibleEntities();
    if (list.length === 0) {
      setCurrent(null);
      return;
    }
    const index = indexOfEntity(current);
    let next: number;
    if (index < 0) next = delta > 0 ? 0 : list.length - 1;
    else next = index + delta;
    if (next < 0 || next >= list.length) return; // граница ленты — ничего не меняем
    const item = list[next]!;
    setCurrent(item.entity);
    item.el.scrollIntoView?.({ block: 'nearest' });
  }

  /** Свернуть/развернуть группу относительно её текущего состояния. */
  function setDayCollapsed(day: string, collapsed: boolean): void {
    if (findSection(day) === null) return;
    opts.onSetDayCollapsed(day, collapsed);
  }

  /** Enter на текущей сущности: группа — свернуть/развернуть; запись — шаг по элементам. */
  function handleEnter(): void {
    if (current === null) return;
    if (current.kind === 'day') {
      const section = findSection(current.key);
      const collapsed = section?.classList.contains('is-collapsed') ?? false;
      opts.onSetDayCollapsed(current.key, !collapsed);
      return;
    }
    const card = findCard(current.key);
    if (card === null) return;
    const elements = recordElements(card);
    if (elements.length === 0) return;
    elementCursor = (elementCursor + 1) % elements.length;
    applyHighlight();
    const target = elements[elementCursor]!;
    if (target.kind === 'title') {
      // Заголовок — поле ввода: вход в правку (дальше стрелки/Enter ведёт редактор).
      target.el.focus?.();
    } else if (target.kind === 'body') {
      // Комментарий: вход в правку текста записи.
      opts.onEditBody(current.key, card);
    }
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
      // Правка текста: стрелки/Enter — редактору; Esc — выход и возврат фокуса.
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
      case 'Enter':
        event.preventDefault?.();
        handleEnter();
        break;
      default:
        break;
    }
  }

  function onClick(event: { target?: unknown | null }): void {
    const target = (event.target ?? null) as HTMLElement | null;
    if (target === null) return;
    const card = closestWithClass(target, 'diary-record');
    if (card !== null && (card.getAttribute?.('data-row-key') ?? '') !== '') {
      if (target.classList?.contains('diary-slot')) return;
      setCurrent({ kind: 'record', key: card.getAttribute('data-row-key') ?? '' });
      return;
    }
    const section = closestWithClass(target, 'diary-day');
    if (section !== null) {
      const day = section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '';
      if (day !== '') setCurrent({ kind: 'day', key: day });
    }
  }

  root.addEventListener('keydown', onKeyDown as EventListener);
  root.addEventListener('click', onClick as EventListener);

  return {
    refresh(): void {
      if (current !== null && indexOfEntity(current) < 0) {
        current = null;
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
