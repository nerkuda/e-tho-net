/**
 * Создание постоянного комментария с УСЫНОВЛЕНИЕМ уже существующего
 * (ошибка ecdb2e7a).
 *
 * Отказ `DUPLICATE` («a permanent comment already exists for this owner») — не
 * сбой, а факт: комментарий успели создать за клиента. Штатные источники:
 * досыл pending-черновика `comment-new` после восстановления связи (H19) и
 * запись из другого клиента/вкладки. Правка, начатая ДО появления комментария,
 * обязана продолжиться: усыновить существующий и записать в него набранный
 * текст (last-write-wins на поле, 04-realtime.md §8), а не повторять `create`
 * и сыпать ошибкой на каждое сохранение.
 *
 * Тот же поиск существующего комментария нужен циклу досылки черновиков
 * (`drafts.ts`) — поэтому он здесь, а не дублем в каждом потребителе.
 */

import type { Comment } from '@etn/shared';

import { isDuplicateError } from './dom.js';
import { etn } from './etn.js';

/** Владелец постоянного комментария. */
export interface PermanentCommentOwner {
  networkId: string;
  ownerType: 'thought' | 'link';
  ownerId: string;
}

/** Постоянный комментарий владельца, либо `null`, если его ещё нет. */
export async function findPermanentComment(owner: PermanentCommentOwner): Promise<Comment | null> {
  const comments = await etn.comments.list(owner.networkId, owner.ownerType, owner.ownerId);
  return comments.find((c) => c.kind === 'permanent') ?? null;
}

/**
 * Создаёт постоянный комментарий владельца; при `DUPLICATE` — усыновляет
 * существующий. Текст правки считается новее серверного, поэтому при
 * расхождении записывается в усыновлённый комментарий; совпадающий текст не
 * пишется повторно (лишний bump версии и realtime-событие никому не нужны).
 *
 * Прочие ошибки (нет связи, чужой захват, ограничение рендера, отказ
 * записи) не перехватываются: вызывающий показывает их пользователю как
 * обычно. Если сервер сказал `DUPLICATE`, а комментарий не читается, тоже
 * пробрасывается исходный отказ — выдумывать другой текст ошибки нельзя.
 */
export async function createOrAdoptPermanentComment(
  owner: PermanentCommentOwner,
  bodyMd: string,
): Promise<Comment> {
  try {
    return await etn.comments.create(owner.networkId, owner.ownerType, owner.ownerId, {
      kind: 'permanent',
      body_md: bodyMd,
    });
  } catch (err) {
    if (!isDuplicateError(err)) throw err;
    const existing = await findPermanentComment(owner);
    if (existing === null) throw err;
    if (existing.body_md === bodyMd) return existing;
    return await etn.comments.update(
      owner.networkId,
      existing.id,
      { body_md: bodyMd },
      existing.version,
    );
  }
}
