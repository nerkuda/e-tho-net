/**
 * Маршрутизация внешнего события `publication.updated` по изменённым полям
 * (замечания 1 и 2 приёмки b02ef1cf): поля СОСТАВА (рецепт, источники,
 * нумерация) не перечитывают сборку — только подсвечивают «Пересобрать»;
 * контентные поля (титул, подзаголовок, обложка, резюме) применяются к шапке и
 * титульному блоку точечно.
 *
 * Вынесено из `publications.ts` отдельным чистым модулем: решение о маршруте —
 * единственное место, где смешанный PATCH `{title, title_recipe}` обязан дать И
 * подсветку, И новый заголовок (замечание-блокер 2 приёмки b02ef1cf), и оно
 * покрыто поведенческим тестом без монтирования всего экрана.
 */

import type { Publication } from '@etn/shared';

/** Поля публикации, меняющие СОСТАВ документа (рецепт, источники, нумерация). */
export const PUBLICATION_COMPOSITION_FIELDS: readonly string[] = [
  'title_recipe',
  'text_sources',
  'extra_properties',
  'numbering_from',
  'numbering_to',
];

/** Поля публикации, отображаемые в карточке/шапке/титульном блоке. */
export const PUBLICATION_CONTENT_FIELDS: readonly string[] = [
  'title',
  'subtitle',
  'summary_md',
  'authorship',
  'cover_attachment_id',
  'cover_url',
  'active',
];

/** Что сделать с открытым документом при правке полей публикации. */
export interface PublicationUpdateRouting {
  /** Пометить живой текст устаревшим (пришло поле состава). */
  markStale: boolean;
  /** Снимок для точечного применения (или `null`, если контентных полей нет). */
  patch: Partial<Publication> | null;
}

/**
 * Решает по изменённым полям, что применить. Обе ветки независимы: смешанный
 * PATCH даёт `{ markStale: true, patch: changes }` — состав помечается, контент
 * применяется (ранний `return` ветки состава терял `title`).
 */
export function routePublicationUpdate(changes: Partial<Publication>): PublicationUpdateRouting {
  const markStale = PUBLICATION_COMPOSITION_FIELDS.some((field) => field in changes);
  const patch = PUBLICATION_CONTENT_FIELDS.some((field) => field in changes) ? changes : null;
  return { markStale, patch };
}
