/**
 * Обновление сети — единая доменная реализация (ADR 8c93f03a, веха 7 версии
 * 0.8.2). Обе точки входа — `PATCH /networks/:id` и патч-ветка
 * `etn.networks.write` — раньше были построчными копиями одной и той же
 * логики; ради копии MCP-слой импортировал хелпер из `routes/networks.ts` —
 * единственную инверсию зависимости сервера. Теперь логика живёт здесь,
 * а фасады только разбирают вход, вызывают {@link updateNetwork} и
 * отправляют real-time событие своего контекста.
 *
 * Авторизация (owner|admin) остаётся в фасадах: REST проверяет её через
 * members-кэш, MCP — через `systemDb.getMemberRole`; домен получает уже
 * авторизованного актора.
 */

import { EtnError, validateTypeRoles, type Network, type UpdateNetworkInput } from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';
import type { NetworkService } from './network-service.js';

/**
 * Привести поле markdown-самоописания PATCH-тела к значению для записи
 * (task O5): `undefined` — сохранить текущее, `null` или пустая строка —
 * очистить, непустая строка — записать. Вынесено из `routes/networks.ts`,
 * откуда его раньше импортировал MCP-фасад.
 */
export function normalizeOptionalText(
  incoming: string | null | undefined,
  current: string | null,
): string | null {
  if (incoming === undefined) {
    return current;
  }
  if (incoming === null) {
    return null;
  }
  if (typeof incoming !== 'string') {
    return current;
  }
  return incoming.length === 0 ? null : incoming;
}

/** Актор обновления: кто сделал и (для MCP) отметка канала вызова. */
export interface UpdateNetworkActor {
  userId: string;
  /** Пометка `via` для `audit_log` (ставит только MCP-фасад). */
  via?: string;
}

/** Результат обновления: свежая карточка сети + изменённые поля. */
export interface UpdateNetworkResult {
  network: Network;
  /**
   * Только реально изменившиеся поля — для real-time события
   * `network.updated` (04-realtime.md §4.6); фасад шлёт событие, если
   * объект не пуст.
   */
  changes: Record<string, unknown>;
}

/**
 * Применить патч к сети (общая ветка PATCH-операции).
 *
 * @param systemDb   — открытая `_system.db` (репозиторий сетей/аудита).
 * @param networkService — для `validateTypeRoles` (проверка id типов по data.db).
 * @param existing   — карточка сети ДО обновления (фасад уже прочитал её,
 *                    чтобы сформулировать свою ошибку NOT_FOUND).
 * @param patch      — разобранное тело запроса.
 * @param actor      — автор (и опциональная отметка `via`).
 */
export function updateNetwork(
  systemDb: SystemDb,
  networkService: Pick<NetworkService, 'validateTypeRoles'>,
  existing: Network,
  patch: UpdateNetworkInput,
  actor: UpdateNetworkActor,
): UpdateNetworkResult {
  const displayName =
    typeof patch.display_name === 'string'
      ? patch.display_name.trim() || existing.display_name
      : existing.display_name;
  // Markdown self-description fields (task O5): null/empty clears, undefined
  // preserves.
  const description = normalizeOptionalText(patch.description, existing.description);
  const whenToUse = normalizeOptionalText(patch.when_to_use, existing.when_to_use);
  const conventions = normalizeOptionalText(patch.conventions, existing.conventions);
  const examples = normalizeOptionalText(patch.examples, existing.examples);
  // type_roles (task ba024a45 / 0.7.2, ADR 46d17a91): partial update —
  // absent keys preserve, present keys (включая явный null) переопределяют.
  // Мерж — до второй ступени валидации, чтобы устаревший id ловился даже
  // когда вызывающий ставит только одну роль.
  const mergedRoles =
    patch.type_roles === undefined
      ? existing.type_roles
      : { ...existing.type_roles, ...validateTypeRoles(patch.type_roles) };
  const validatedRoles = networkService.validateTypeRoles(existing.id, mergedRoles);

  systemDb.updateNetwork(existing.id, {
    displayName,
    description,
    when_to_use: whenToUse,
    conventions,
    examples,
    type_roles: validatedRoles,
  });
  systemDb.insertAuditLog({
    actorUserId: actor.userId,
    networkId: existing.id,
    category: 'network',
    action: 'network.update',
    targetType: 'network',
    targetId: existing.id,
    details: {
      display_name: displayName,
      description,
      when_to_use: whenToUse,
      conventions,
      examples,
      type_roles: validatedRoles,
      ...(actor.via !== undefined ? { via: actor.via } : {}),
    },
  });

  // Real-time (E3, 04-realtime.md §4.6): только изменённые поля — подписчики
  // мержат на месте.
  const changes: Record<string, unknown> = {};
  if (displayName !== existing.display_name) changes['display_name'] = displayName;
  if (description !== existing.description) changes['description'] = description;
  if (whenToUse !== existing.when_to_use) changes['when_to_use'] = whenToUse;
  if (conventions !== existing.conventions) changes['conventions'] = conventions;
  if (examples !== existing.examples) changes['examples'] = examples;
  if (JSON.stringify(validatedRoles) !== JSON.stringify(existing.type_roles)) {
    changes['type_roles'] = validatedRoles;
  }

  const network = systemDb.getNetworkById(existing.id);
  if (network === null) {
    throw new EtnError('INTERNAL', 'Сеть исчезла сразу после обновления.', {
      network_id: existing.id,
    });
  }
  return { network, changes };
}
