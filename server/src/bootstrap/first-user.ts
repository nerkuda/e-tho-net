/**
 * Создание первого администратора и его первичного API-ключа (задача B6,
 * документация 06-auth.md §8).
 *
 * Общий код двух входов:
 *
 * - `etn init` (`cli.ts`): ключ печатается один раз или пишется в `--key-out`;
 * - bootstrap пакета `etn-mcp` (`bootstrap/data-dir.ts`): ключ пишется в
 *   `mcp/key` без вывода в stdout (там MCP-кадры).
 *
 * Функция не открывает транзакцию сама — вызывающая сторона оборачивает вызов
 * в `SystemDb.transaction` вместе с побочными действиями, чтобы «пользователь +
 * ключ + аудит» были атомарны. Так же не печатает: сообщения — забота входа.
 */

import { randomUUID } from 'node:crypto';

import { generateApiKey, type GeneratedApiKey } from '../auth/api-key.js';
import type { SystemDb } from '../db/system-db.js';

/** Параметры первого администратора. */
export interface FirstUserOptions {
  /** Логин первого администратора. */
  username: string;
  /** Отображаемое имя, если задано. */
  displayName: string | null;
  /** Метка первичного ключа (по умолчанию `primary`). */
  keyLabel?: string | null;
  /** Источник инициализации для `audit_log.details` (например, `etn-mcp`). */
  by?: string;
}

/**
 * Создать первого администратора и первичный ключ, если администратора ещё
 * нет. Идемпотентна: при существующем первом администраторе ничего не делает.
 *
 * @param sys - открытая системная БД.
 * @param options - логин/имя/метка ключа.
 * @param key - уже сгенерированный ключ (важно для `--key-out`: файл пишется
 *   до транзакции); по умолчанию генерируется здесь.
 * @returns `true`, если администратор и ключ созданы этим вызовом.
 */
export function initializeFirstUser(
  sys: SystemDb,
  options: FirstUserOptions,
  key: GeneratedApiKey = generateApiKey(),
): boolean {
  if (sys.hasFirstUser()) return false;

  const userId = randomUUID();
  const user = sys.createUser({
    id: userId,
    username: options.username,
    displayName: options.displayName,
    isAdmin: true,
    isFirstUser: true,
  });
  sys.createApiKey({
    id: randomUUID(),
    userId: user.id,
    label: options.keyLabel ?? 'primary',
    keyHash: key.keyHash,
    keyPrefix: key.keyPrefix,
  });
  sys.insertAuditLog({
    category: 'system',
    action: 'init',
    actorUserId: user.id,
    targetType: 'user',
    targetId: user.id,
    ...(options.by === undefined ? {} : { details: { by: options.by } }),
  });
  return true;
}
