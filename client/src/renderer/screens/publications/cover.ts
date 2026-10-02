/**
 * Обложка публикации для библиотеки и карточки (0.11.1, задача a3cfc018;
 * элемент интерфейса 1eecd988): миниатюра вложения/URL, иначе заглушка
 * «цвет + инициалы» (детерминированная по id, см. `model.ts`).
 *
 * Модуль строит ТОЛЬКО разметку обложки по данным публикации: сервер отдаёт
 * вычисленный `cover_kind`, но не отдаёт байты картинки — миниатюра вложения
 * грузится через протокол `etnimg` (как в остальных местах клиента).
 */

import type { Publication } from '@etn/shared';

import { div, span } from '../../lib/dom.js';
import { coverInitials, coverTone } from './model.js';

/** Размер обложки: карточка полки, строка списка, шапка карточки. */
export type CoverSize = 'card' | 'row' | 'thumb';

/** CSS-класс размера обложки. */
const SIZE_CLASS: Record<CoverSize, string> = {
  card: 'pub-cover-card',
  row: 'pub-cover-row',
  thumb: 'pub-cover-thumb',
};

/**
 * Строит узел обложки. Для `cover_kind === 'attachment'` источник —
 * `etnimg://attachment/<id>`: main-процесс резолвит id в `file_path` вложения
 * и отдаёт файл локально либо копией с сервера (ошибка 280a322b, ADR «Форма
 * attachment/<id> протокола etnimg»); для `url` — сам URL; иначе заглушка.
 */
export function buildCover(publication: Publication, size: CoverSize): HTMLElement {
  const root = div(`pub-cover ${SIZE_CLASS[size]}`);
  if (publication.cover_kind === 'attachment' && publication.cover_attachment_id !== null) {
    const img = document.createElement('img');
    img.className = 'pub-cover-img';
    img.alt = '';
    img.loading = 'lazy';
    img.src = `etnimg://attachment/${encodeURIComponent(publication.cover_attachment_id)}`;
    img.addEventListener('error', () => {
      img.replaceWith(placeholder(publication));
    });
    root.append(img);
    return root;
  }
  if (publication.cover_kind === 'url' && publication.cover_url !== null) {
    const img = document.createElement('img');
    img.className = 'pub-cover-img';
    img.alt = '';
    img.loading = 'lazy';
    img.src = publication.cover_url;
    img.addEventListener('error', () => {
      img.replaceWith(placeholder(publication));
    });
    root.append(img);
    return root;
  }
  root.append(placeholder(publication));
  return root;
}

/** Заглушка «цвет + инициалы». */
function placeholder(publication: Publication): HTMLElement {
  const tone = coverTone(publication.id);
  const node = div('pub-cover-ph');
  node.style.background = tone.bg;
  node.style.color = tone.fg;
  node.append(span(coverInitials(publication.title), 'pub-cover-initials'));
  node.setAttribute('aria-hidden', 'true');
  return node;
}
