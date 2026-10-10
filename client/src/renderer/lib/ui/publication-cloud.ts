/**
 * Облачко ПУБЛИКАЦИИ — компонент `lib/ui` (замечание Б2 приёмки b02ef1cf).
 *
 * Публикация — не мысль: у неё нет типа, поэтому её облачко не наследует
 * оформление типа и всегда несёт один значок — раскрытую книгу
 * (`value-publication`). Углы ПРЯМЫЕ (в отличие от скруглённых пилюль-мыслей),
 * чтобы публикация отличалась с первого взгляда. Компонент — единственное
 * место показа облачка публикации; контекстное меню (Открыть/Читать/Найти на
 * полке) и крестик снятия владельца монтируются только при переданных
 * действиях.
 *
 * Строки-литералы в `lib/ui/*` запрещены (сторож `guard-ui-i18n`): все тексты и
 * подписи меню приходят параметрами владельца.
 */

import { div, span, el, setTooltip } from '../dom.js';
import { svgIcon } from './icon.js';
import { menuAction, showMenuAt, type MenuItem } from '../menu.js';

/** Базовый класс корня облачка публикации. */
export const PUBLICATION_CLOUD_CLASS = 'ui-pub-cloud';
/** Класс значка-книги. */
export const PUBLICATION_CLOUD_ICON_CLASS = 'ui-pub-cloud-icon';
/** Класс подписи-названия. */
export const PUBLICATION_CLOUD_TITLE_CLASS = 'ui-pub-cloud-title';
/** Класс кнопки снятия владельца (крестик). */
export const PUBLICATION_CLOUD_REMOVE_CLASS = 'ui-pub-cloud-remove';
/** Класс-модификатор ширины «по контейнеру» (имя обрезается многоточием). */
export const PUBLICATION_CLOUD_CONTAINER_CLASS = 'ui-pub-cloud-container';

/** Подписи меню и крестика; пустая подпись — соответствующий пункт не рисуется. */
export interface PublicationCloudLabels {
  open?: string;
  read?: string;
  findOnShelf?: string;
  remove?: string;
}

/** Действия домена, подставляемые вызывающим. */
export interface PublicationCloudActions {
  /** Открыть карточку публикации в панели редактора. */
  onOpen?: (id: string) => void;
  /** Открыть документ публикации (режим чтения). */
  onRead?: (id: string) => void;
  /** Показать публикацию в библиотеке («Найти на полке»). */
  onFindOnShelf?: (id: string) => void;
  /** Снять владельца-публикацию (крестик); событие — для модификаторов. */
  onRemove?: (id: string, event?: MouseEvent) => void;
}

/** Параметры {@link createPublicationCloud}. */
export interface PublicationCloudOptions {
  /** Ширина по контейнеру (имя обрезается многоточием по нему). */
  width?: 'container';
  labels?: PublicationCloudLabels;
  actions?: PublicationCloudActions;
}

/** Данные публикации для облачка. */
export interface PublicationCloudInput {
  id: string;
  title: string;
}

/**
 * Собирает готовый элемент облачка публикации: прямые углы, значок-книга,
 * название с обязательной подсказкой. Контекстное меню и крестик — только при
 * переданных действиях.
 */
export function createPublicationCloud(
  input: PublicationCloudInput,
  options: PublicationCloudOptions = {},
): HTMLElement {
  const root = div(PUBLICATION_CLOUD_CLASS);
  if (options.width === 'container') root.classList.add(PUBLICATION_CLOUD_CONTAINER_CLASS);
  root.dataset['id'] = input.id;

  const iconBox = span('', PUBLICATION_CLOUD_ICON_CLASS);
  iconBox.append(svgIcon('value-publication', 14));

  const titleEl = span(input.title, PUBLICATION_CLOUD_TITLE_CLASS);
  setTooltip(titleEl, input.title);
  root.append(iconBox, titleEl);

  const actions = options.actions;
  const labels = options.labels ?? {};

  if (actions?.onRemove !== undefined) {
    const btn = el('button', PUBLICATION_CLOUD_REMOVE_CLASS, '✕') as HTMLButtonElement;
    btn.type = 'button';
    if (labels.remove !== undefined && labels.remove !== '') setTooltip(btn, labels.remove);
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      actions.onRemove?.(input.id, event);
    });
    root.append(btn);
  }

  const menuItems = buildMenuItems(input.id, labels, actions);
  if (menuItems.length > 0) {
    root.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showMenuAt(event.clientX, event.clientY, menuItems);
    });
  }
  return root;
}

/** Пункты контекстного меню по переданным действиям и подписям. */
function buildMenuItems(
  id: string,
  labels: PublicationCloudLabels,
  actions: PublicationCloudActions | undefined,
): MenuItem[] {
  if (actions === undefined) return [];
  const items: MenuItem[] = [];
  if (actions.onOpen !== undefined && labels.open !== undefined && labels.open !== '') {
    items.push(menuAction(labels.open, () => actions.onOpen?.(id)));
  }
  if (actions.onRead !== undefined && labels.read !== undefined && labels.read !== '') {
    items.push(menuAction(labels.read, () => actions.onRead?.(id)));
  }
  if (
    actions.onFindOnShelf !== undefined &&
    labels.findOnShelf !== undefined &&
    labels.findOnShelf !== ''
  ) {
    items.push(menuAction(labels.findOnShelf, () => actions.onFindOnShelf?.(id)));
  }
  return items;
}
