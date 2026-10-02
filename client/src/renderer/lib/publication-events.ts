/**
 * Локальный канал «публикация пересобрана» (ошибка c2dec45c).
 *
 * Своё realtime-эхо сервер не отдаёт клиенту-источнику: у REST и WS один
 * `client_id`, а шлюз подавляет эхо (`server/src/realtime/gateway.ts`). Поэтому
 * после «Пересобрать» событие `publication.rebuilt` до этого же клиента НЕ
 * доходит, и виджеты, перечитывающие данные только по realtime, остаются с
 * прежним документом/датой:
 *
 *  - карточка публикации в панели редактора (`editor/publication-card.ts`) —
 *    источник пересборки; документ рабочей области и списки библиотеки
 *    обновляются только по realtime (`screens/publications/publications.ts` →
 *    `applyPublicationsRealtime`), поэтому здесь их надо уведомить локально;
 *  - рабочая область (`screens/publications/workspace.ts`) — источник
 *    пересборки из шапки; карточку обновляет её собственный realtime-подписчик —
 *    тем же подавленным эхо, поэтому карточку тоже надо уведомить локально.
 *
 * Производитель не зависит от потребителей: канал — модульный набор
 * подписчиков (как `eventListeners` в `realtime.ts`), а не DOM-событие.
 * Подписчики здесь — модули рендерера, а не DOM-узлы (ср. `attachment-events.ts`,
 * где подписчики — элементы; там потому и DOM-событие). Набор не тянет глобалы
 * и одинаково работает в юнит-тестах без DOM.
 *
 * Тот же канал несёт и локальную правку публикации
 * ({@link onPublicationChanged}): у неё та же причина — подавленное эхо
 * `publication.updated` (замечание А приёмки задачи b02ef1cf).
 */

import type { Publication } from '@etn/shared';

/** Источник пересборки: карточка панели редактора или шапка рабочей области. */
export type PublicationRebuiltSource = 'card' | 'workspace';

/** Факт локальной пересборки публикации. */
export interface PublicationRebuiltEvent {
  /** id пересобранной публикации. */
  id: string;
  /** Кто инициировал пересборку — чтобы источник не перечитывал себя зря. */
  source: PublicationRebuiltSource;
}

/** Подписчики локального канала. */
const listeners = new Set<(event: PublicationRebuiltEvent) => void>();

/** Подписывается на локальные пересборки; возвращает функцию отписки. */
export function onPublicationRebuilt(
  listener: (event: PublicationRebuiltEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Сообщает, что публикация пересобрана локально. Зовут источники сразу после
 * успешного `etn.publications.rebuild` — вместо подавленного realtime-события.
 */
export function notifyPublicationRebuilt(event: PublicationRebuiltEvent): void {
  // Копия набора: подписчик вправе отписаться прямо в обработчике.
  for (const listener of [...listeners]) listener(event);
}

// ---------------------------------------------------------------------------
// Локальный канал «публикация изменена» (замечание А приёмки b02ef1cf)
// ---------------------------------------------------------------------------

/**
 * Факт локальной правки публикации (титул/подзаголовок/обложка/настройки) или
 * её вложений. Несёт СВЕЖИЙ снимок публикации: подписчики (библиотека, рабочая
 * область) применяют его точечно, без перечитывания всего списка.
 */
export interface PublicationChangedEvent {
  /** Свежий снимок публикации после правки. */
  publication: Publication;
  /** Кто инициировал правку — чтобы источник знал, что изменение уже применено. */
  source: 'card' | 'cover';
}

/** Подписчики локального канала правок. */
const changedListeners = new Set<(event: PublicationChangedEvent) => void>();

/** Подписывается на локальные правки публикации; возвращает функцию отписки. */
export function onPublicationChanged(
  listener: (event: PublicationChangedEvent) => void,
): () => void {
  changedListeners.add(listener);
  return () => {
    changedListeners.delete(listener);
  };
}

/**
 * Сообщает, что публикация изменена локально. Зовёт карточка редактора после
 * успешного PATCH: своё realtime-эхо `publication.updated` до этого же клиента
 * не доходит, и библиотека с рабочей областью обновились бы только после
 * переоткрытия.
 */
export function notifyPublicationChanged(event: PublicationChangedEvent): void {
  for (const listener of [...changedListeners]) listener(event);
}
