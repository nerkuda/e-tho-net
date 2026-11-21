/**
 * Строки задач/list-пунктов в ПРОСМОТРЕ (0.16.1, пачка 7; задача `c63e3652`).
 *
 * **Зачем модуль.** Пользователь потребовал, чтобы подчинённые строки задачи в
 * списках задач выглядели и вели себя ТАК ЖЕ, как в просмотре комментария:
 * вложенные списки, чекбоксы, код и цитаты, сворачиваемые пункты, wiki-ссылки.
 * Поэтому панель не размечает markdown сама — она отдаёт срез тела записи
 * этому модулю, а он рисует его ровно тем путём, что просмотр комментария:
 *
 *   markdown → `renderMarkdownWithWikiLinks` (единый рендерер `@etn/markdown` +
 *   резолв ID-ссылок по готовому DOM) → `decorateCommentView` (штатное
 *   сворачивание вложенных списков/цитат/заголовков с кареткой у верхнего края
 *   якоря) → {@link markOverdueTaskItems} (просроченные задачи красным).
 *
 * **Блок панели.** В отличие от комментария, у блока панели своё ЛОКАЛЬНОЕ
 * состояние свёрнутости (не персистится по ключам панели): владелец — сам узел
 * блока (`WeakMap`), переоткрытие панели начинает со свёрнутых пунктов, как и
 * штатное сворачивание разделов комментария без владельца.
 *
 * **Просрочка без второго парсера.** Признак берётся из ГОТОВОГО DOM: у пункта
 * списка задач есть чекбокс, а его date-чипы несут ISO в `data-wiki-date`.
 * Срок строки — ПОСЛЕДНИЙ её date-чип (та же семантика, что у проекции:
 * `due` = последняя date-ссылка строки), чипы вложенных пунктов не в счёт
 * (ближайший `li` — другой). Это работает одинаково для серверного
 * `body_html` комментария и для свежего рендера блока, без чтения `body_md`.
 */

import { WIKI_LINK_DATE_ATTR } from '@etn/markdown';

import { todayLocal } from '../lib/dates.js';
import {
  createCommentCollapseState,
  decorateCommentView,
  type CommentCollapseState,
} from './comment-collapse.js';
import { renderMarkdownWithWikiLinks } from './wiki-link-resolver.js';

/** Класс хоста просмотра markdown (стили комментария — те же, что у панели). */
export const COMMENT_VIEW_CLASS = 'comment-view';

/**
 * Состояние сворачивания блоков панели: владелец — сам узел блока. `WeakMap`
 * не удерживает снятый блок: свёрнутость живёт, пока панель показывает строку.
 */
const blockCollapse = new WeakMap<HTMLElement, CommentCollapseState>();

/**
 * Нарисовать подчинённый блок строки задачи как просмотр комментария.
 *
 * Текст уже без базового отступа предков (`childBlockText` в модели панели):
 * относительные отступы внутри блока сохранены, поэтому вложенность списков,
 * код и цитаты рендерер понимает ровно так же, как в теле комментария.
 */
export function renderTaskBlock(host: HTMLElement, text: string, networkId: string): void {
  host.classList.add(COMMENT_VIEW_CLASS);
  renderMarkdownWithWikiLinks(host, text, networkId);
  markOverdueTaskItems(host);
  let state = blockCollapse.get(host);
  if (state === undefined) {
    state = createCommentCollapseState(networkId, undefined);
    blockCollapse.set(host, state);
  }
  decorateCommentView(host, state);
}

/**
 * Пометить просроченные задачи в отрендеренном просмотре комментария/записи
 * (0.16.1, пачка 7): `li.task-list-item` получает класс `is-overdue` (красный —
 * токен темы), если последний date-чип ЕГО строки раньше `today`, а чекбокс не
 * отмечен. Чипы вложенных пунктов не учитываются: срок строки — последняя её
 * дата, а не дата подпункта.
 *
 * Строки в блоках кода задачами не являются (их и нет в DOM как
 * `task-list-item`: разбор даёт единый рендерер), поэтому ничего не красится.
 */
export function markOverdueTaskItems(host: HTMLElement, today: string = todayLocal()): void {
  for (const node of Array.from(host.querySelectorAll('.task-list-item'))) {
    if (node.tagName.toLowerCase() !== 'li') continue;
    const item = node as HTMLElement;
    const box = item.querySelector('input');
    if (box !== null && (box as HTMLInputElement).checked) continue;
    let due: string | null = null;
    for (const chip of Array.from(item.querySelectorAll('.wiki-link-date'))) {
      if (chip.closest('li') !== item) continue;
      const date = chip.getAttribute(WIKI_LINK_DATE_ATTR);
      if (date !== null && date !== '') due = date;
    }
    if (due !== null && due < today) item.classList.add('is-overdue');
  }
}
