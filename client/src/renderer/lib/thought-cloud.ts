/**
 * Общая фабрика облачка мысли (веха 2 версии 0.8.2, задача b28ab6d6).
 *
 * Единственное место клиента, где мысль превращается в готовый элемент
 * (ADR «Облачко мысли собирает одна фабрика DOM, различия — именованные
 * профили»): разметка, значок, цвета, начертание, признаки состояния
 * (неактуальная, в корзине, захваченная) и единые жесты. Различия
 * применений задаёт именованный профиль из закрытого перечня
 * `canvas` / `tree` / `chip` / `graph` — новая потребность отображения
 * добавляет профиль сюда, а не параметр в вызов.
 *
 * Канон `resolveCloudStyle` / `applyCloudStyle` / `resolveThoughtIcon` /
 * `applyThoughtIcon` перенесён сюда из `canvas/canvas.ts`; холст реэкспортирует
 * их отсюда, поведение не меняется.
 *
 * Зависимости — только `lib/*`, `state.ts` и типы `@etn/shared`: модуль
 * подключается из `canvas.ts`, поэтому `editor/*` импортировать нельзя
 * (грабли «Цикл импортов canvas.ts ↔ editor-модулей»). Обрезка названия —
 * раскладкой (`text-overflow: ellipsis`) с обязательной `title`-подсказкой;
 * числовые лимиты длины отображаемого текста запрещены (ADR «Обрезка текста
 * в интерфейсе — раскладкой, а не подсчётом символов»).
 *
 * Ширина облачка — опция {@link ThoughtCloudOptions.width}: имя всегда
 * обрезается либо по явно заданному пределу ширины (профиль/модификатор
 * контейнера: `.pinned-chip` 260px, `.history-cloud` 170px, холстовая
 * `--cloud-width`), либо по ширине своего контейнера (`'container'`).
 * Второй случай — не «размазанные» контекстные селекторы в стилях, а
 * класс-модификатор {@link CLOUD_WIDTH_CONTAINER_CLASS} и одно общее правило:
 * место, где предел ширины не задан явно, обязано передать `width: 'container'`
 * (следит сторож `guard-thought-cloud`).
 */

import type { IconKind, ThoughtRef } from '@etn/shared';

import { store } from '../state.js';
import { div, el, renderHighlightedText, setTooltip, span } from './dom.js';
import { svgIcon } from './icons.js';
import { contrastText } from './pure.js';
import { resolveThoughtTypeVisual } from './type-tree.js';
import { logUiEvent } from './ui-log.js';

// ---------------------------------------------------------------------------
// Канон стиля и значка (перенесён из canvas/canvas.ts)
// ---------------------------------------------------------------------------

/** Resolved visual style of a cloud (own values win over type defaults). */
export interface CloudStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

/**
 * Resolves the visual style of a thought: own values win, then the type chain
 * defaults (L21: the type inherits unset fields from its ancestors; a thought
 * without a type resolves the root type «основной тип»).
 */
export function resolveCloudStyle(
  thought: Pick<
    ThoughtRef,
    | 'fg_color'
    | 'bg_color'
    | 'font_bold'
    | 'font_italic'
    | 'font_underline'
    | 'font_strike'
    | 'type_id'
  >,
): CloudStyle {
  const type = resolveThoughtTypeVisual(store.state.thoughtTypes, thought.type_id);
  return {
    fg: thought.fg_color ?? type.fg_color,
    bg: thought.bg_color ?? type.bg_color,
    // font_* use null-coalesce (NOT OR): a manual `false` must override a `true`
    // type default, which `||` would wrongly collapse (02-data-model.md §3.1.1).
    bold: thought.font_bold ?? type.font_bold ?? false,
    italic: thought.font_italic ?? type.font_italic ?? false,
    underline: thought.font_underline ?? type.font_underline ?? false,
    strike: thought.font_strike ?? type.font_strike ?? false,
  };
}

/** Applies a resolved style to a cloud element. */
export function applyCloudStyle(cloud: HTMLElement, style: CloudStyle): void {
  if (style.fg !== null) {
    cloud.style.color = style.fg;
  } else if (style.bg !== null) {
    // Only the background is set — pick a readable text colour for it
    // (L12); an explicit fg always wins.
    cloud.style.color = contrastText(style.bg);
  } else {
    cloud.style.color = '';
  }
  if (style.bg !== null) cloud.style.background = style.bg;
  cloud.classList.toggle('font-bold', style.bold);
  cloud.classList.toggle('font-italic', style.italic);
  cloud.classList.toggle('font-underline', style.underline);
  cloud.classList.toggle('font-strike', style.strike);
}

/**
 * Resolves a thought's icon: its own icon wins, else the default icon resolved
 * along the type chain (L21; a thought without a type resolves the root type),
 * else none (the caller falls back to 💭). Returns the icon value together
 * with its kind (02-data-model.md §3.1.1).
 */
export function resolveThoughtIcon(thought: {
  icon: string | null;
  icon_kind: IconKind;
  type_id: string | null;
}): { icon: string | null; kind: IconKind } {
  if (thought.icon !== null) {
    return { icon: thought.icon, kind: thought.icon_kind };
  }
  const type = resolveThoughtTypeVisual(store.state.thoughtTypes, thought.type_id);
  if (type.icon !== null) {
    return { icon: type.icon, kind: type.icon_kind };
  }
  return { icon: null, kind: 'emoji' };
}

/**
 * Renders a thought's resolved icon into an element: an `<img>` for an
 * `image`-kind icon, otherwise the glyph (own/type default, else 💭). When the
 * icon is backed by an attachment (L16), the `<img>` carries the thought and
 * attachment ids so the Ctrl-hover magnifier shows the attachment's full
 * picture instead of the icon-sized preview.
 */
export function applyThoughtIcon(
  iconBox: HTMLElement,
  thought: {
    icon: string | null;
    icon_kind: IconKind;
    type_id: string | null;
    /** Thought id — required together with {@link icon_attachment_id} for zoom. */
    id?: string;
    icon_attachment_id?: string | null;
  },
): void {
  const ic = resolveThoughtIcon(thought);
  iconBox.replaceChildren();
  if (ic.kind === 'image' && ic.icon !== null) {
    const img = el('img');
    img.src = ic.icon;
    img.alt = '';
    if (thought.id !== undefined && (thought.icon_attachment_id ?? null) !== null) {
      img.dataset['zoomThought'] = thought.id;
      img.dataset['zoomAttachment'] = thought.icon_attachment_id ?? '';
    }
    iconBox.append(img);
  } else {
    iconBox.textContent = ic.icon ?? '💭';
  }
}

// ---------------------------------------------------------------------------
// Единые жесты (эталон — поведение холста)
// ---------------------------------------------------------------------------

/**
 * How long a single click waits for a sibling double-click before it fires its
 * own action. The browser fires two `click` events for every double-click;
 * without this delay the first click would already run the single-click action
 * only for the second click to run the double-click action on top of it.
 * Mirrors the OS-level double-click threshold.
 */
export const SINGLE_CLICK_DELAY_MS = 220;

/**
 * Defers a single-click action until the browser has had a chance to emit a
 * matching `dblclick`. The first click schedules the action; a second click
 * inside {@link SINGLE_CLICK_DELAY_MS} cancels it and the element's `dblclick`
 * handler runs instead.
 */
export function deferSingleClick(action: () => void): { cancel: () => void } {
  let timer: number | null = window.setTimeout(() => {
    timer = null;
    action();
  }, SINGLE_CLICK_DELAY_MS);
  return {
    cancel(): void {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Действия домена, подставляемые вызывающим в единые жесты облачка. */
export interface ThoughtCloudActions {
  /** Одиночный клик — открыть мысль (откладывается на время двойного клика). */
  onClick?: (id: string) => void;
  /** Двойной клик — редактирование/фокус по контексту. */
  onDoubleClick?: (id: string) => void;
  /** Ctrl/Cmd+клик — переход или мультивыбор по контексту. */
  onCtrlClick?: (id: string) => void;
  /** Контекстное меню — общее меню мысли. */
  onContextMenu?: (event: MouseEvent, id: string) => void;
  /** Клик по метке корзины — диалог удаления/восстановления. */
  onTrashBadgeClick?: (id: string) => void;
  /** Кнопка удаления чипа — убрать мысль из значения (только профиль `chip`). */
  onRemove?: (id: string) => void;
}

/**
 * Монтирует единые жесты облачка на готовый элемент: одиночный клик
 * (отложенный — двойной клик успевает отменить его), двойной клик
 * (игнорируется с модификаторами), Ctrl/Cmd+клик и контекстное меню.
 * Вызывающий подставляет только действия своей области.
 */
export function wireCloudGestures(
  root: HTMLElement,
  id: string,
  actions: ThoughtCloudActions,
): void {
  let pendingClick: { cancel: () => void } | null = null;
  root.addEventListener('click', (event) => {
    logUiEvent('ui.cloud.click', { id });
    if (event.ctrlKey || event.metaKey) {
      pendingClick?.cancel();
      pendingClick = null;
      actions.onCtrlClick?.(id);
      return;
    }
    pendingClick?.cancel();
    pendingClick = deferSingleClick(() => {
      pendingClick = null;
      actions.onClick?.(id);
    });
  });
  root.addEventListener('dblclick', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    pendingClick?.cancel();
    pendingClick = null;
    actions.onDoubleClick?.(id);
  });
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onContextMenu?.(event, id);
  });
}

// ---------------------------------------------------------------------------
// Фабрика облачка
// ---------------------------------------------------------------------------

/**
 * Именованный профиль отображения облачка. Закрытый перечень: новая
 * потребность отображения добавляет профиль сюда, а не параметр в вызов.
 *
 * | Профиль | Где применяется |
 * |---|---|
 * | `canvas` | облачко на холсте — полный размер, эллипсы связей, перетаскивание |
 * | `tree`   | строка дерева и списка — компактно, одна строка, без эллипсов |
 * | `chip`   | чип в поле ввода значения — с кнопкой удаления |
 * | `graph`  | узел мини-графа — минимальный, поверх SVG |
 */
export type CloudProfile = 'canvas' | 'tree' | 'chip' | 'graph';

/** Закрытый перечень профилей (для проверок и переборов). */
export const CLOUD_PROFILES: readonly CloudProfile[] = ['canvas', 'tree', 'chip', 'graph'];

/**
 * Откуда облачко берёт ширину — принцип «имя всегда обрезано»:
 *
 * | Ширина | Что задаёт предел имени |
 * |---|---|
 * | `fixed` (дефолт) | явный предел ширины: модификатор контейнера (`chip`-профиль в полосе закреплённых — `.pinned-chip` 260px, в полосе истории — `.history-cloud` 170px) или холстовая `--cloud-width` |
 * | `container` | ширину контейнера: облачко тянется по нему и обрезает имя многоточием по нему |
 *
 * Дефолт `fixed` — текущее поведение всех прочих мест. Место, где явного
 * предела нет (строка списка, поле ввода), обязано указать `container`.
 */
export type CloudWidth = 'fixed' | 'container';

/** Закрытый перечень ширин (для проверок и переборов). */
export const CLOUD_WIDTHS: readonly CloudWidth[] = ['fixed', 'container'];

/**
 * Класс-модификатор ширины «по контейнеру»: снимает заданный предел ширины
 * (`--cloud-width` у `.cloud`, пилюлю у `.prop-ref-cloud`) и растягивает
 * облачко по контейнеру. Единственный способ задать такую ширину — этот
 * класс и одно общее правило в `styles.css`; контекстные селекторы
 * (`.link-endpoint .cloud`, `.search-hit .cloud`) закрыты.
 */
export const CLOUD_WIDTH_CONTAINER_CLASS = 'cloud-width-container';

/**
 * Данные мысли, из которых облачко строится. Визуальные поля опциональны:
 * непришедшие значения резолвятся по цепочке типа как «не заданы».
 * Структурно совместимо с `ThoughtRef` — можно передавать напрямую.
 */
export interface ThoughtCloudInput {
  /** Идентификатор мысли (`dataset.id` элемента). */
  id: string;
  /** Полное название — подпись и обязательная подсказка. */
  title: string;
  icon?: string | null;
  icon_kind?: IconKind;
  icon_attachment_id?: string | null;
  type_id?: string | null;
  fg_color?: string | null;
  bg_color?: string | null;
  // `boolean | null`: поля `font_*` в DTO мысли (`ThoughtRef`/`Thought`)
  // приходят именно так (`null` = «не задано»), и фабрика обещает принимать
  // их напрямую; внутри `null` сворачивается в `?? false`.
  font_bold?: boolean | null;
  font_italic?: boolean | null;
  font_underline?: boolean | null;
  font_strike?: boolean | null;
  /** Актуальна ли мысль; `false` → бледность. */
  active?: boolean;
  /** Помечена на удаление → бледность + метка корзины. */
  marked_for_deletion?: boolean;
}

/** Признак захвата (блокировки) мысли для индикации на облачке. */
export interface ThoughtCloudLock {
  /** Имя держателя блокировки; `null` — захват собственным клиентом. */
  holder: string | null;
  /** Захват своим клиентом (мягкая индикация). */
  bySelf: boolean;
}

/** Параметры сборки облачка. */
export interface ThoughtCloudOptions {
  /** Профиль отображения (закрытый перечень {@link CLOUD_PROFILES}). */
  profile: CloudProfile;
  /**
   * Откуда берётся ширина облачка (закрытый перечень {@link CLOUD_WIDTHS});
   * по умолчанию `fixed` — явный предел ширины задаёт место/контейнер.
   * {@link CloudWidth} — `'container'` для строк списка и полей ввода.
   */
  width?: CloudWidth;
  /**
   * Действия домена. Без них жесты не монтируются, а кнопка удаления чипа
   * не рисуется; элемент остаётся чисто визуальным.
   */
  actions?: ThoughtCloudActions;
  /** Признак захвата — индикация блокировки; `null`/не задано — индикации нет. */
  lock?: ThoughtCloudLock | null;
  /**
   * Термы подсветки совпадений в названии (задача a1766c7d): каждое вхождение
   * терма без учёта регистра оборачивается в `<mark>` — тем же видом, что
   * серверные сниппеты. Термы даёт {@link searchHighlightTerms}
   * (`lib/pure.ts`) из запроса строки поиска. Не задано/пусто — название как
   * есть. Профиль тут ни при чём: подсветка — украшение содержимого названия,
   * применимое в любом профиле.
   */
  highlightTerms?: readonly string[];
}

/** Подсказка метки корзины (S13). */
const TRASH_BADGE_TOOLTIP = 'Мысль находится в корзине. Нажмите для удаления/восстановления';

/** Классы корня и внутренних частей по профилю (один набор на профиль). */
const PROFILE_DOM: Record<CloudProfile, { root: string; icon: string; title: string; titleTag: 'div' | 'span' }> = {
  canvas: { root: 'cloud', icon: 'cloud-icon', title: 'cloud-title', titleTag: 'div' },
  tree: { root: 'cloud', icon: 'cloud-icon', title: 'cloud-title', titleTag: 'div' },
  chip: { root: 'prop-ref-cloud', icon: 'mini-icon', title: 'prc-title', titleTag: 'span' },
  graph: { root: 'cloud', icon: 'cloud-icon', title: 'cloud-title', titleTag: 'div' },
};

/** Профили с одной строкой названия: обрезка раскладкой (nowrap + ellipsis). */
const SINGLE_LINE_PROFILES: ReadonlySet<CloudProfile> = new Set(['tree', 'chip', 'graph']);

/**
 * Название облачка. Полное имя — обязательной `title`-подсказкой; длина
 * видимого текста ограничивается раскладкой, а не подсчётом символов:
 * на холсте — CSS-кламп по строкам, в однострочных профилях — `nowrap` +
 * `text-overflow: ellipsis` (ADR «Обрезка текста в интерфейсе…»).
 */
function buildTitle(
  profile: CloudProfile,
  title: string,
  highlightTerms: readonly string[],
): HTMLElement {
  const spec = PROFILE_DOM[profile];
  const node = el(spec.titleTag, spec.title);
  // Термы подсветки (поиск по карте, задача a1766c7d): совпадения запроса
  // оборачиваются в `<mark>` внутри названия. Это не раскладка, а украшение
  // содержимого — потому опция, а не отдельный профиль.
  renderHighlightedText(node, title, highlightTerms);
  setTooltip(node, title);
  if (SINGLE_LINE_PROFILES.has(profile)) {
    // Перебиваем `-webkit-box` из `.cloud-title`, чтобы ellipsis работал
    // в одну строку (инлайн-стиль сильнее таблицы).
    node.style.display = 'block';
    node.style.whiteSpace = 'nowrap';
    node.style.overflow = 'hidden';
    node.style.textOverflow = 'ellipsis';
    // Как flex-элемент пилюли/облачка имя без `min-width: 0` не сжимается
    // ниже min-content и многоточие не срабатывает: строка либо клипается
    // родителем, либо раздувает контейнер. Нужно для строк выпадашки и
    // чипов в узких колонках (`width: 'container'`).
    node.style.minWidth = '0';
  }
  return node;
}

/**
 * Метка корзины (S13). В профиле `chip` — компактная красная метка внутри
 * пилюли; в остальных — большой кликабельный бейдж в углу, открывающий
 * диалог удаления/восстановления через действие вызывающего.
 */
function buildTrashMark(
  profile: CloudProfile,
  id: string,
  actions: ThoughtCloudActions | undefined,
): HTMLElement {
  if (profile === 'chip') {
    const mark = span('', 'list-trash-mark');
    mark.append(svgIcon('trash', 10));
    setTooltip(mark, TRASH_BADGE_TOOLTIP);
    mark.addEventListener('click', (event) => {
      event.stopPropagation();
      actions?.onTrashBadgeClick?.(id);
    });
    return mark;
  }
  const badge = span('', 'cloud-trash-badge');
  badge.append(svgIcon('trash', 17));
  setTooltip(badge, TRASH_BADGE_TOOLTIP);
  badge.addEventListener('click', (event) => {
    event.stopPropagation();
    actions?.onTrashBadgeClick?.(id);
  });
  return badge;
}

/**
 * Индикация захвата: класс рамки на облачке (`locked-by-other` /
 * `locked-by-self`) и бейдж 🔒 с подсказкой «Редактирует <имя>» /
 * «Вы редактируете эту мысль.». Бейдж только читаемый: клики подавляются,
 * чтобы облачко сохраняло свои обычные жесты.
 */
function applyLockIndicator(root: HTMLElement, lock: ThoughtCloudLock): void {
  root.classList.toggle('locked-by-other', !lock.bySelf);
  root.classList.toggle('locked-by-self', lock.bySelf);
  const badge = span('🔒', 'cloud-lock-badge' + (lock.bySelf ? ' own' : ''));
  setTooltip(
    badge,
    lock.bySelf ? 'Вы редактируете эту мысль.' : `Редактирует ${lock.holder ?? '?'}`,
  );
  for (const evt of ['click', 'dblclick', 'contextmenu'] as const) {
    badge.addEventListener(evt, (e) => {
      e.stopPropagation();
    });
  }
  root.append(badge);
}

/** Кнопка удаления чипа: «✕» убирает мысль из значения, не открывая её. */
function buildRemoveButton(id: string, actions: ThoughtCloudActions): HTMLButtonElement {
  const btn = el('button', 'st-f-clear-inline', '✕');
  btn.type = 'button';
  btn.title = 'Убрать из значения';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.onRemove?.(id);
  });
  return btn;
}

/**
 * Собирает готовый элемент облачка мысли по профилю: разметку, значок
 * (с наследованием от типа), цвета и начертание, признаки состояния,
 * бейджи и единые жесты. Возвращает узел, который можно вставить в DOM.
 *
 * Профиль `chip` резервирует место под значок и кнопку удаления: иначе
 * многоточие съедает кнопку и чип становится неудаляемым.
 *
 * Ширина — опция {@link ThoughtCloudOptions.width}: при `'container'` на
 * корень вешается {@link CLOUD_WIDTH_CONTAINER_CLASS}, и имя обрезается
 * многоточием по ширине контейнера, а не по холстовому пределу.
 */
export function createThoughtCloud(
  input: ThoughtCloudInput,
  options: ThoughtCloudOptions,
): HTMLElement {
  const { profile } = options;
  const spec = PROFILE_DOM[profile];
  const root = div(spec.root);
  root.classList.add(`cloud-profile-${profile}`);
  if ((options.width ?? 'fixed') === 'container') {
    root.classList.add(CLOUD_WIDTH_CONTAINER_CLASS);
  }
  root.dataset['id'] = input.id;
  root.tabIndex = 0;

  // Состояние: неактуальная и помеченная на удаление читаются как «блёклая»
  // (08-ui-spec.md §2.2) — метка корзины поверх отличает вторую.
  const inactive = input.active === false;
  const marked = input.marked_for_deletion === true;
  if (inactive || marked) root.classList.add('dim');

  const style = resolveCloudStyle({
    fg_color: input.fg_color ?? null,
    bg_color: input.bg_color ?? null,
    font_bold: input.font_bold ?? false,
    font_italic: input.font_italic ?? false,
    font_underline: input.font_underline ?? false,
    font_strike: input.font_strike ?? false,
    type_id: input.type_id ?? null,
  });
  applyCloudStyle(root, style);

  const iconBox = div(spec.icon);
  applyThoughtIcon(iconBox, {
    icon: input.icon ?? null,
    icon_kind: input.icon_kind ?? 'emoji',
    type_id: input.type_id ?? null,
    id: input.id,
    icon_attachment_id: input.icon_attachment_id ?? null,
  });

  const titleEl = buildTitle(profile, input.title, options.highlightTerms ?? []);

  if (profile === 'canvas' || profile === 'tree') {
    const main = div('cloud-main');
    main.append(titleEl);
    root.append(iconBox, main);
  } else {
    // chip — значок, подпись, метки и кнопка в ряд; graph — минимальный набор.
    root.append(iconBox, titleEl);
  }
  if (marked) {
    root.append(buildTrashMark(profile, input.id, options.actions));
  }
  if (options.lock !== undefined && options.lock !== null) {
    applyLockIndicator(root, options.lock);
  }
  if (profile === 'chip' && options.actions?.onRemove !== undefined) {
    root.append(buildRemoveButton(input.id, options.actions));
  }
  if (options.actions !== undefined) {
    wireCloudGestures(root, input.id, options.actions);
  }
  return root;
}
