/**
 * Сворачиваемая группа — единый компонент сворачиваемых секций клиента
 * (задача a57e7998, требование 88a9225a, инвентаризация 3fc7c54d:
 * «Collapsible — эталон group.ts обобщить»).
 *
 * Эталон поведения — `editor/group.ts` (счётчик, ленивое тело, событие,
 * персист свёрнутости): механизм перенесён сюда без изменений, а сам
 * `group.ts` стал тонким потребителем с редакторским персистом. Вторая
 * реализация (`<details>` в icon-dialog, своя стрелка в
 * `filter-form.buildFilterBlock`) упразднена.
 *
 * Почему свой компонент, а не вендорский `wa-accordion`: нужен компактный
 * API эталона (счётчик с ленивой загрузкой, построение тела один раз и его
 * переиспользование при повторных раскрытиях, событие переключения) и
 * тестируемость на DOM-шиме без исполнения custom elements (та же причина,
 * что у `lib/ui/tabs.ts`). API компонента стабилен — вендорскую реализацию
 * можно подставить позже, не трогая потребителей (ADR 03eb2c61).
 *
 * Вид задаётся классами потребителя (`classes`): группа редактора носит
 * `group-*`, блок панели отбора — `st-f-*`, эмодзи-группа — `emoji-*`.
 * Компонент отвечает за состояние и разметку, не за оформление.
 */

import { div, el, span } from '../dom.js';
import { svgIcon } from '../icons.js';

/** Классы разметки: потребитель подставляет своё оформление. */
export interface CollapsibleClasses {
  root?: string;
  header?: string;
  title?: string;
  count?: string;
  caret?: string;
  body?: string;
  actions?: string;
}

/** Спецификация сворачиваемой группы. */
export interface CollapsibleSpec {
  title: string;
  /** Статический текст счётчика. */
  count?: string;
  /** Асинхронный счётчик (показывается, когда нет статического). */
  loadCount?: () => Promise<string | undefined>;
  /**
   * Отложить счётчик до первого раскрытия: бейдж начинается с `…`, а
   * `loadCount` зовётся при первом раскрытии. Тело может опубликовать
   * посчитанное значение событием `etn:set-count`.
   */
  lazyCount?: boolean;
  /** Начальное состояние, когда {@link getCollapsed} не задан (иначе — свёрнута). */
  collapsed?: boolean;
  /** Внешнее состояние свёрнутости (персист потребителя). */
  getCollapsed?: () => boolean;
  /** Уведомление о переключении (запись персиста). */
  onToggle?: (collapsed: boolean) => void;
  /** Компактный вид (подгруппы). */
  compact?: boolean;
  /** Дополнительные кнопки в правой части заголовка. */
  actions?: HTMLElement[];
  /** Дополнительные узлы заголовка между подписью и действиями (маркер, бейдж). */
  headerExtra?: HTMLElement[];
  /** Вид указателя: шеврон (по умолчанию) или текстовый треугольник. */
  caretKind?: 'chevron' | 'triangle';
  /** Сворачивается ли группа кликом по заголовку (по умолчанию да). */
  collapsible?: boolean;
  /** Классы разметки. */
  classes?: CollapsibleClasses;
  /**
   * Строит тело. Зовётся при построении, если группа показана, и при каждом
   * повторном раскрытии (потребитель возвращает тот же узел, если значения
   * формы должны переживать сворачивание). Не задаётся вместе с {@link body}.
   */
  buildBody?(): HTMLElement | Promise<HTMLElement>;
  /**
   * Готовое тело, которым владеет потребитель: компонент только показывает и
   * прячет его (свёрнутая группа снимает узел с экрана, раскрытая возвращает
   * тот же узел). Нужно формам, наполняющим тело заранее (`filter-form`).
   */
  body?: HTMLElement;
  /** Имя события переключения (по умолчанию `etn:toggled`). */
  toggleEventName?: string;
}

/** Дескриптор построенной группы. */
export interface CollapsibleSection {
  root: HTMLElement;
  header: HTMLElement;
  /** Текущее тело (пока группа показана) либо `null`. */
  body: HTMLElement | null;
  collapsed(): boolean;
  setCollapsed(value: boolean): void;
  /** Перечитать асинхронный счётчик (например, после изменения содержимого). */
  refreshCount(): void;
}

/** Текст бейджа `lazyCount`-группы до первого раскрытия. */
const LAZY_COUNT_PLACEHOLDER = '…';

const DEFAULT_CLASSES: Required<CollapsibleClasses> = {
  root: 'ui-collapsible',
  header: 'ui-collapsible-header',
  title: 'ui-collapsible-title',
  count: 'ui-collapsible-count',
  caret: 'ui-collapsible-caret',
  body: 'ui-collapsible-body',
  actions: 'ui-collapsible-actions',
};

/** Разбирает `class="a b"` в список классов. */
function classList(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(/\s+/).filter((token) => token !== '');
}

/**
 * Строит сворачиваемую группу. Тело строится при построении (развёрнутая) или
 * при первом раскрытии (свёрнутая); повторное раскрытие перезапрашивает тело у
 * потребителя. Заголовок с шевроном вращает указатель при сворачивании.
 */
export function collapsibleSection(spec: CollapsibleSpec): CollapsibleSection {
  const classes = {
    root: classList(spec.classes?.root, DEFAULT_CLASSES.root),
    header: classList(spec.classes?.header, DEFAULT_CLASSES.header),
    title: classList(spec.classes?.title, DEFAULT_CLASSES.title),
    count: classList(spec.classes?.count, DEFAULT_CLASSES.count),
    caret: classList(spec.classes?.caret, DEFAULT_CLASSES.caret),
    body: classList(spec.classes?.body, DEFAULT_CLASSES.body),
    actions: classList(spec.classes?.actions, DEFAULT_CLASSES.actions),
  };

  const initial = spec.getCollapsed?.() ?? spec.collapsed === true;
  let collapsed = initial;
  let built = !collapsed;

  const root = div();
  root.classList.add(...classes.root);
  if (spec.compact === true) root.classList.add('compact');

  const header = div();
  header.classList.add(...classes.header);

  const caret = span('', classes.caret.join(' '));
  const triangle = spec.caretKind === 'triangle';
  if (triangle) caret.textContent = collapsed ? '▸' : '▾';
  else caret.append(svgIcon('chevron-down', 11));
  caret.classList.toggle('collapsed', collapsed);
  // У несворачиваемого блока каретка не показывается (деталь в header нет).
  if (spec.collapsible !== false) header.append(caret);

  const title = span(spec.title, classes.title.join(' '));
  header.append(title);
  if (spec.headerExtra !== undefined) {
    for (const extra of spec.headerExtra) header.append(extra);
  }

  const lazy = spec.lazyCount === true && spec.count === undefined;
  const withCount = spec.count !== undefined || spec.loadCount !== undefined || lazy;
  const countBadge = span(spec.count ?? (lazy ? LAZY_COUNT_PLACEHOLDER : ''), classes.count.join(' '));
  if (withCount) {
    if (spec.count === undefined && !lazy) countBadge.classList.add('hidden');
    header.append(countBadge);
  }
  if (spec.actions !== undefined && spec.actions.length > 0) {
    const actionsBox = div();
    actionsBox.classList.add(...classes.actions);
    for (const action of spec.actions) actionsBox.append(action);
    header.append(actionsBox);
  }
  root.append(header);

  // Асинхронный счётчик: резолвится независимо от раскрытия и перечитывается,
  // когда тело сообщает об изменении (добавили/убрали элемент).
  let countLoaded = false;
  const updateCount = (): void => {
    if (spec.count !== undefined || spec.loadCount === undefined) return;
    countLoaded = true;
    void Promise.resolve(spec.loadCount()).then((value) => {
      if (value !== undefined && value !== null) {
        countBadge.textContent = value;
        countBadge.classList.remove('hidden');
      }
    });
  };
  if (!lazy) updateCount();
  root.addEventListener('etn:refresh-count', updateCount);
  root.addEventListener('etn:set-count', (event) => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === 'string' && detail !== '') {
      countBadge.textContent = detail;
      countBadge.classList.remove('hidden');
      countLoaded = true;
    }
  });

  let body: HTMLElement | null = null;

  const apply = (): void => {
    caret.classList.toggle('collapsed', collapsed);
    if (triangle) caret.textContent = collapsed ? '▸' : '▾';
    if (body !== null) body.remove();
    body = null;
    if (collapsed || !built) return;
    // Готовое тело потребителя: показываем тот же узел (состояние формы цело).
    if (spec.body !== undefined) {
      root.append(spec.body);
      body = spec.body;
      return;
    }
    if (spec.buildBody === undefined) return;
    // Обёртка тела живёт до перерисовки: в неё монтируется содержимое, и по ней
    // оформление и сплиттеры адресуют тело надёжно.
    const bodyBox = div();
    bodyBox.classList.add(...classes.body);
    bodyBox.append(el('span', 'muted', 'Загрузка…'));
    root.append(bodyBox);
    body = bodyBox;
    void Promise.resolve(spec.buildBody()).then((content) => {
      if (body !== bodyBox) return; // свернули/пересобрали за это время
      bodyBox.replaceChildren(content);
    });
  };

  if (spec.collapsible !== false) {
    header.addEventListener('click', (event) => {
      const actionsClass = classes.actions[0]!;
      if (event.target instanceof HTMLElement && event.target.closest(`.${actionsClass}`) !== null) {
        return;
      }
      collapsed = !collapsed;
      built = true;
      spec.onToggle?.(collapsed);
      if (!collapsed && lazy && !countLoaded) updateCount();
      apply();
      root.dispatchEvent(new CustomEvent(spec.toggleEventName ?? 'etn:toggled', { detail: collapsed }));
    });
  }

  apply();

  return {
    root,
    header,
    get body(): HTMLElement | null {
      return body;
    },
    collapsed: (): boolean => collapsed,
    setCollapsed: (value: boolean): void => {
      if (collapsed === value) return;
      collapsed = value;
      built = true;
      if (!collapsed && lazy && !countLoaded) updateCount();
      apply();
    },
    refreshCount: updateCount,
  };
}
